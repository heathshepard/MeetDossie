-- =============================================================================
-- Multi-Tenant Phase 4: SECURITY DEFINER RPCs + Solo→Team atomic upgrade
-- DOD: S-7 (atomic upgrade), A-7 (invite), A-8 (remove member), A-9 (role edit),
--      A-10 (one-tap TC consent request), G-6 (leave team), G-7/G-8 consent flow,
--      O-1 (team signup), V-9 (75-day reminder audit hook)
-- Author: Atlas
-- Phase: Session 2 (2026-06-20)
-- =============================================================================
--
-- This migration is additive — it only adds functions and helper RPCs. It does
-- NOT modify any existing table, column, policy, or trigger. The Phase 1-3
-- schema posture remains unchanged. Every function is SECURITY DEFINER so it
-- can perform cross-table writes that bypass RLS, then re-enforces business
-- rules in PL/pgSQL.
--
-- Calling convention: every RPC checks the caller via auth.uid() at entry and
-- raises with a meaningful error message if unauthorized. Service-role callers
-- (API routes using service key) bypass by passing acting_user_id explicitly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: get acting user (auth.uid() or service-role override)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._mt_acting_user(p_override UUID DEFAULT NULL)
RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p_override, auth.uid());
$$;

-- -----------------------------------------------------------------------------
-- Helper: is the caller an admin on the given org?
-- (mirrors is_org_admin but accepts an explicit user_id for service-role calls)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._mt_user_is_org_admin(p_user_id UUID, p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organization_member_roles r ON r.member_id = m.id
    WHERE m.org_id = p_org_id
      AND m.user_id = p_user_id
      AND m.removed_at IS NULL
      AND r.role = 'admin'
      AND r.revoked_at IS NULL
  );
$$;

-- =============================================================================
-- DOD-O-1 + DOD-O-2 + DOD-S-7: create org with founding admin (atomic)
-- =============================================================================
-- Creates organizations row, seats the founder, grants requested roles.
-- If `p_upgrade_from_solo = true`, also backfills org_id on all existing
-- Solo rows owned by the founder atomically.
--
-- Returns: organizations.id (UUID).
-- Errors: founder already on another org / invalid tier / invalid role bundle.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.create_org_with_founder(
  p_name TEXT,
  p_tier TEXT,                              -- 'team' | 'brokerage'
  p_founder_user_id UUID,
  p_founder_roles TEXT[],                   -- subset of {'agent','admin','tc'}
  p_seat_price_cents INT DEFAULT 7900,
  p_parent_org_id UUID DEFAULT NULL,
  p_upgrade_from_solo BOOLEAN DEFAULT FALSE,
  p_stripe_customer_id TEXT DEFAULT NULL,
  p_acting_user_id UUID DEFAULT NULL        -- service-role caller can override
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_org_id UUID;
  v_member_id UUID;
  v_role TEXT;
  v_existing_membership_count INT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'create_org_with_founder: no acting user (auth.uid is null)';
  END IF;

  IF p_founder_user_id IS NULL THEN
    RAISE EXCEPTION 'create_org_with_founder: p_founder_user_id is required';
  END IF;

  IF p_tier NOT IN ('team','brokerage') THEN
    RAISE EXCEPTION 'create_org_with_founder: invalid tier %', p_tier;
  END IF;

  IF p_founder_roles IS NULL OR array_length(p_founder_roles, 1) IS NULL THEN
    RAISE EXCEPTION 'create_org_with_founder: at least one role is required';
  END IF;

  IF NOT (p_founder_roles <@ ARRAY['agent','admin','tc']::TEXT[]) THEN
    RAISE EXCEPTION 'create_org_with_founder: invalid role in bundle';
  END IF;

  -- Founder must hold Admin (every org must have at least one admin — DOD-E-2)
  IF NOT ('admin' = ANY(p_founder_roles)) THEN
    RAISE EXCEPTION 'create_org_with_founder: founder must hold admin role';
  END IF;

  -- Founder must not already be on another active org
  SELECT COUNT(*) INTO v_existing_membership_count
  FROM public.organization_members
  WHERE user_id = p_founder_user_id AND removed_at IS NULL;

  IF v_existing_membership_count > 0 THEN
    RAISE EXCEPTION 'create_org_with_founder: user % is already a member of another org', p_founder_user_id;
  END IF;

  -- Insert org
  INSERT INTO public.organizations
    (name, tier, parent_org_id, stripe_customer_id, seat_price_cents, created_by_user_id)
  VALUES (p_name, p_tier, p_parent_org_id, p_stripe_customer_id, p_seat_price_cents, v_actor)
  RETURNING id INTO v_org_id;

  -- Seat the founder
  INSERT INTO public.organization_members (org_id, user_id, invited_by_user_id)
  VALUES (v_org_id, p_founder_user_id, v_actor)
  RETURNING id INTO v_member_id;

  -- Grant each requested role
  FOREACH v_role IN ARRAY p_founder_roles LOOP
    INSERT INTO public.organization_member_roles (member_id, role, granted_by_user_id)
    VALUES (v_member_id, v_role, v_actor);
  END LOOP;

  -- DOD-S-7: backfill org_id on existing Solo data if upgrade flag is set
  IF p_upgrade_from_solo THEN
    UPDATE public.transactions       SET org_id = v_org_id WHERE user_id = p_founder_user_id AND org_id IS NULL;
    UPDATE public.documents          SET org_id = v_org_id WHERE user_id = p_founder_user_id AND org_id IS NULL;
    UPDATE public.action_items       SET org_id = v_org_id WHERE user_id = p_founder_user_id AND org_id IS NULL;
    UPDATE public.email_queue        SET org_id = v_org_id WHERE user_id = p_founder_user_id AND org_id IS NULL;
    UPDATE public.dossier_milestones SET org_id = v_org_id WHERE user_id = p_founder_user_id AND org_id IS NULL;
    -- social_posts: only update if user_id matches (most rows are platform-owned with NULL user_id)
    UPDATE public.social_posts       SET org_id = v_org_id WHERE user_id = p_founder_user_id AND org_id IS NULL;
  END IF;

  -- DOD-B-7: Brokerage automatically gets 1TB Vault bundle at $0
  IF p_tier = 'brokerage' THEN
    INSERT INTO public.data_vault_subscriptions
      (org_id, tier, storage_quota_bytes, monthly_price_cents)
    VALUES (v_org_id, 'brokerage_bundle', 1099511627776, 0);
  END IF;

  RETURN v_org_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_org_with_founder(TEXT,TEXT,UUID,TEXT[],INT,UUID,BOOLEAN,TEXT,UUID) TO authenticated, service_role;

-- =============================================================================
-- DOD-A-7: invite a member with a role bundle
-- =============================================================================
-- Creates organization_members row + role rows in a single transaction.
-- Caller must be an admin on the org. Invitee must not already be on another
-- active org. If invitee already has a soft-removed membership on this org,
-- it is reactivated (removed_at cleared) and missing roles added.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.invite_member_with_roles(
  p_org_id UUID,
  p_invitee_user_id UUID,
  p_roles TEXT[],                           -- subset of {'agent','admin','tc'}
  p_acting_user_id UUID DEFAULT NULL
)
RETURNS UUID                                -- returns organization_members.id
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_member_id UUID;
  v_existing_member_id UUID;
  v_role TEXT;
  v_other_org_count INT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'invite_member_with_roles: no acting user';
  END IF;

  IF NOT public._mt_user_is_org_admin(v_actor, p_org_id) THEN
    RAISE EXCEPTION 'invite_member_with_roles: user % is not an admin on org %', v_actor, p_org_id;
  END IF;

  IF p_invitee_user_id IS NULL THEN
    RAISE EXCEPTION 'invite_member_with_roles: invitee_user_id required';
  END IF;

  IF p_roles IS NULL OR array_length(p_roles, 1) IS NULL THEN
    RAISE EXCEPTION 'invite_member_with_roles: at least one role required';
  END IF;

  IF NOT (p_roles <@ ARRAY['agent','admin','tc']::TEXT[]) THEN
    RAISE EXCEPTION 'invite_member_with_roles: invalid role in bundle';
  END IF;

  -- Invitee must not be on another active org
  SELECT COUNT(*) INTO v_other_org_count
  FROM public.organization_members
  WHERE user_id = p_invitee_user_id
    AND removed_at IS NULL
    AND org_id <> p_org_id;

  IF v_other_org_count > 0 THEN
    RAISE EXCEPTION 'invite_member_with_roles: user % is on another active org', p_invitee_user_id;
  END IF;

  -- Reactivate or create membership
  SELECT id INTO v_existing_member_id
  FROM public.organization_members
  WHERE org_id = p_org_id AND user_id = p_invitee_user_id
  ORDER BY joined_at DESC LIMIT 1;

  IF v_existing_member_id IS NOT NULL THEN
    UPDATE public.organization_members
    SET removed_at = NULL,
        invited_by_user_id = v_actor,
        deletion_reminder_sent_at = NULL,
        joined_at = NOW()
    WHERE id = v_existing_member_id;
    v_member_id := v_existing_member_id;
  ELSE
    INSERT INTO public.organization_members (org_id, user_id, invited_by_user_id)
    VALUES (p_org_id, p_invitee_user_id, v_actor)
    RETURNING id INTO v_member_id;
  END IF;

  -- Grant requested roles (skip ones already active)
  FOREACH v_role IN ARRAY p_roles LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.organization_member_roles
      WHERE member_id = v_member_id AND role = v_role AND revoked_at IS NULL
    ) THEN
      INSERT INTO public.organization_member_roles (member_id, role, granted_by_user_id)
      VALUES (v_member_id, v_role, v_actor);
    END IF;
  END LOOP;

  RETURN v_member_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.invite_member_with_roles(UUID,UUID,TEXT[],UUID) TO authenticated, service_role;

-- =============================================================================
-- DOD-A-8 + DOD-G-6: remove a member (admin or self)
-- =============================================================================
-- Sets removed_at = NOW(). Starts the 90-day grace period (DOD-E-1).
-- The last-admin trigger (Phase 1) prevents removing the sole admin.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.remove_org_member(
  p_member_id UUID,
  p_acting_user_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_target_user UUID;
  v_org UUID;
  v_actor_is_admin BOOLEAN;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'remove_org_member: no acting user';
  END IF;

  SELECT user_id, org_id INTO v_target_user, v_org
  FROM public.organization_members
  WHERE id = p_member_id AND removed_at IS NULL;

  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'remove_org_member: member % not found or already removed', p_member_id;
  END IF;

  v_actor_is_admin := public._mt_user_is_org_admin(v_actor, v_org);

  -- Allowed if: actor is the target (self-leave) OR actor is org admin
  IF v_actor <> v_target_user AND NOT v_actor_is_admin THEN
    RAISE EXCEPTION 'remove_org_member: user % not authorized to remove member %', v_actor, p_member_id;
  END IF;

  UPDATE public.organization_members
  SET removed_at = NOW()
  WHERE id = p_member_id;

  -- Revoke all roles (paper trail)
  UPDATE public.organization_member_roles
  SET revoked_at = NOW(), revoked_by_user_id = v_actor
  WHERE member_id = p_member_id AND revoked_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_org_member(UUID,UUID) TO authenticated, service_role;

-- =============================================================================
-- DOD-A-9: edit a member's roles (add or remove individual roles)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.update_member_roles(
  p_member_id UUID,
  p_add_roles TEXT[],                       -- roles to grant
  p_remove_roles TEXT[],                    -- roles to revoke
  p_acting_user_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_org UUID;
  v_role TEXT;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'update_member_roles: no acting user';
  END IF;

  SELECT org_id INTO v_org
  FROM public.organization_members
  WHERE id = p_member_id AND removed_at IS NULL;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'update_member_roles: member % not found or removed', p_member_id;
  END IF;

  IF NOT public._mt_user_is_org_admin(v_actor, v_org) THEN
    RAISE EXCEPTION 'update_member_roles: user % not admin on org %', v_actor, v_org;
  END IF;

  -- Grant new roles
  IF p_add_roles IS NOT NULL THEN
    FOREACH v_role IN ARRAY p_add_roles LOOP
      IF v_role NOT IN ('agent','admin','tc') THEN
        RAISE EXCEPTION 'update_member_roles: invalid role %', v_role;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.organization_member_roles
        WHERE member_id = p_member_id AND role = v_role AND revoked_at IS NULL
      ) THEN
        INSERT INTO public.organization_member_roles (member_id, role, granted_by_user_id)
        VALUES (p_member_id, v_role, v_actor);
      END IF;
    END LOOP;
  END IF;

  -- Revoke roles (the last-admin trigger will guard against orphaning the org)
  IF p_remove_roles IS NOT NULL THEN
    FOREACH v_role IN ARRAY p_remove_roles LOOP
      UPDATE public.organization_member_roles
      SET revoked_at = NOW(), revoked_by_user_id = v_actor
      WHERE member_id = p_member_id AND role = v_role AND revoked_at IS NULL;
    END LOOP;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_member_roles(UUID,TEXT[],TEXT[],UUID) TO authenticated, service_role;

-- =============================================================================
-- DOD-G-7: agent toggles TC consent (settings page path)
-- =============================================================================
-- Inserts or revokes tc_authorizations row.
-- Caller MUST be the agent themselves.
-- Writes tc_consent_events row (consent_given / consent_revoked).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.toggle_tc_authorization(
  p_org_id UUID,
  p_tc_user_id UUID,
  p_grant BOOLEAN,                          -- TRUE = grant, FALSE = revoke
  p_ip INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_acting_user_id UUID DEFAULT NULL
)
RETURNS UUID                                -- tc_authorizations.id (or NULL on revoke-nothing)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_auth_id UUID;
  v_existing_id UUID;
  v_tc_has_role BOOLEAN;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'toggle_tc_authorization: no acting user';
  END IF;

  IF v_actor = p_tc_user_id THEN
    RAISE EXCEPTION 'toggle_tc_authorization: cannot authorize yourself';
  END IF;

  -- Actor must be an active member of the org
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE org_id = p_org_id AND user_id = v_actor AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'toggle_tc_authorization: user % not a member of org %', v_actor, p_org_id;
  END IF;

  -- Target TC must hold the TC role on this org
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organization_member_roles r ON r.member_id = m.id
    WHERE m.org_id = p_org_id AND m.user_id = p_tc_user_id AND m.removed_at IS NULL
      AND r.role = 'tc' AND r.revoked_at IS NULL
  ) INTO v_tc_has_role;

  IF NOT v_tc_has_role THEN
    RAISE EXCEPTION 'toggle_tc_authorization: user % does not hold TC role on org %', p_tc_user_id, p_org_id;
  END IF;

  IF p_grant THEN
    SELECT id INTO v_existing_id
    FROM public.tc_authorizations
    WHERE agent_user_id = v_actor AND tc_user_id = p_tc_user_id AND revoked_at IS NULL;

    IF v_existing_id IS NOT NULL THEN
      v_auth_id := v_existing_id;
    ELSE
      INSERT INTO public.tc_authorizations
        (org_id, agent_user_id, tc_user_id, granted_via, consent_ip, consent_user_agent)
      VALUES (p_org_id, v_actor, p_tc_user_id, 'agent_settings_toggle', p_ip, p_user_agent)
      RETURNING id INTO v_auth_id;

      INSERT INTO public.tc_consent_events
        (org_id, event_type, actor_user_id, agent_user_id, tc_user_id, authorization_id, ip_address, user_agent, payload_json)
      VALUES
        (p_org_id, 'consent_given', v_actor, v_actor, p_tc_user_id, v_auth_id, p_ip, p_user_agent,
         jsonb_build_object('source','settings_toggle'));

      -- Legacy audit (DOD-S-2c)
      INSERT INTO public.tc_authorizations_audit (agent_user_id, tc_user_id, action, ip_address)
      VALUES (v_actor, p_tc_user_id, 'granted', p_ip);
    END IF;
  ELSE
    UPDATE public.tc_authorizations
    SET revoked_at = NOW()
    WHERE agent_user_id = v_actor AND tc_user_id = p_tc_user_id AND revoked_at IS NULL
    RETURNING id INTO v_auth_id;

    IF v_auth_id IS NOT NULL THEN
      INSERT INTO public.tc_consent_events
        (org_id, event_type, actor_user_id, agent_user_id, tc_user_id, authorization_id, ip_address, user_agent, payload_json)
      VALUES
        (p_org_id, 'consent_revoked', v_actor, v_actor, p_tc_user_id, v_auth_id, p_ip, p_user_agent,
         jsonb_build_object('source','settings_toggle'));
      INSERT INTO public.tc_authorizations_audit (agent_user_id, tc_user_id, action, ip_address)
      VALUES (v_actor, p_tc_user_id, 'revoked', p_ip);
    END IF;
  END IF;

  RETURN v_auth_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.toggle_tc_authorization(UUID,UUID,BOOLEAN,INET,TEXT,UUID) TO authenticated, service_role;

-- =============================================================================
-- DOD-A-10: admin creates a one-tap TC consent request
-- =============================================================================
-- Caller is admin. Generates the raw token, stores SHA-256 of it, returns
-- both the hash AND the raw token (raw is used by the API to mint the URL,
-- never persisted in DB).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.create_tc_consent_request(
  p_org_id UUID,
  p_agent_user_id UUID,
  p_tc_user_id UUID,
  p_delivery_channels TEXT[],               -- subset of {'email','telegram'}
  p_acting_user_id UUID DEFAULT NULL
)
RETURNS TABLE(request_id UUID, raw_token TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_raw_token TEXT := gen_random_uuid()::TEXT || '-' || gen_random_uuid()::TEXT;
  v_hash TEXT := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');
  v_request_id UUID;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'create_tc_consent_request: no acting user';
  END IF;

  IF NOT public._mt_user_is_org_admin(v_actor, p_org_id) THEN
    RAISE EXCEPTION 'create_tc_consent_request: user % not admin on org %', v_actor, p_org_id;
  END IF;

  IF p_agent_user_id = p_tc_user_id THEN
    RAISE EXCEPTION 'create_tc_consent_request: agent and tc must be different users';
  END IF;

  IF NOT (p_delivery_channels <@ ARRAY['email','telegram']::TEXT[]) THEN
    RAISE EXCEPTION 'create_tc_consent_request: invalid delivery channel';
  END IF;

  INSERT INTO public.tc_consent_requests
    (org_id, admin_user_id, agent_user_id, tc_user_id, delivery_channels, one_tap_token)
  VALUES
    (p_org_id, v_actor, p_agent_user_id, p_tc_user_id, p_delivery_channels, v_hash)
  RETURNING id INTO v_request_id;

  INSERT INTO public.tc_consent_events
    (org_id, event_type, actor_user_id, agent_user_id, tc_user_id, request_id, delivery_channels, payload_json)
  VALUES
    (p_org_id, 'request_sent', v_actor, p_agent_user_id, p_tc_user_id, v_request_id, p_delivery_channels,
     jsonb_build_object('source','admin_one_tap'));

  RETURN QUERY SELECT v_request_id, v_raw_token;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_tc_consent_request(UUID,UUID,UUID,TEXT[],UUID) TO authenticated, service_role;

-- =============================================================================
-- DOD-G-8: agent consumes a one-tap consent token
-- =============================================================================
-- Validates token (not expired, not consumed, not revoked), inserts the
-- tc_authorizations row, marks the request consumed, writes consent_given
-- event. Caller does NOT need to be signed in — service-role bypass via
-- the API route, which passes the agent's user_id from the request row.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.consume_tc_consent_token(
  p_raw_token TEXT,
  p_ip INET DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL
)
RETURNS TABLE(
  status TEXT,                              -- 'consumed' | 'already_consumed' | 'expired' | 'revoked' | 'not_found'
  authorization_id UUID,
  agent_user_id UUID,
  tc_user_id UUID,
  org_id UUID,
  agent_email TEXT,
  tc_email TEXT,
  org_name TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_hash TEXT := encode(extensions.digest(p_raw_token, 'sha256'), 'hex');
  v_req RECORD;
  v_auth_id UUID;
  v_agent_email TEXT;
  v_tc_email TEXT;
  v_org_name TEXT;
BEGIN
  SELECT * INTO v_req
  FROM public.tc_consent_requests
  WHERE one_tap_token = v_hash;

  IF v_req IS NULL THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  -- Lookup display info for the success / failure page (RLS-safe via SECURITY DEFINER)
  SELECT email INTO v_agent_email FROM auth.users WHERE id = v_req.agent_user_id;
  SELECT email INTO v_tc_email FROM auth.users WHERE id = v_req.tc_user_id;
  SELECT name  INTO v_org_name  FROM public.organizations WHERE id = v_req.org_id;

  IF v_req.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'revoked'::TEXT, NULL::UUID, v_req.agent_user_id, v_req.tc_user_id, v_req.org_id, v_agent_email, v_tc_email, v_org_name;
    RETURN;
  END IF;

  IF v_req.consumed_at IS NOT NULL THEN
    RETURN QUERY SELECT 'already_consumed'::TEXT, v_req.consent_authorization_id, v_req.agent_user_id, v_req.tc_user_id, v_req.org_id, v_agent_email, v_tc_email, v_org_name;
    RETURN;
  END IF;

  IF v_req.token_expires_at < NOW() THEN
    -- Mark as expired in audit log
    INSERT INTO public.tc_consent_events
      (org_id, event_type, actor_user_id, agent_user_id, tc_user_id, request_id, payload_json)
    VALUES
      (v_req.org_id, 'request_expired', NULL, v_req.agent_user_id, v_req.tc_user_id, v_req.id,
       jsonb_build_object('reason','token_expired'));
    RETURN QUERY SELECT 'expired'::TEXT, NULL::UUID, v_req.agent_user_id, v_req.tc_user_id, v_req.org_id, v_agent_email, v_tc_email, v_org_name;
    RETURN;
  END IF;

  -- Mint authorization (reuse existing if somehow already granted)
  SELECT id INTO v_auth_id
  FROM public.tc_authorizations
  WHERE agent_user_id = v_req.agent_user_id
    AND tc_user_id = v_req.tc_user_id
    AND revoked_at IS NULL;

  IF v_auth_id IS NULL THEN
    INSERT INTO public.tc_authorizations
      (org_id, agent_user_id, tc_user_id, granted_via, request_id, consent_ip, consent_user_agent)
    VALUES
      (v_req.org_id, v_req.agent_user_id, v_req.tc_user_id, 'admin_request_one_tap', v_req.id, p_ip, p_user_agent)
    RETURNING id INTO v_auth_id;
  END IF;

  -- Mark request consumed
  UPDATE public.tc_consent_requests
  SET consumed_at = NOW(),
      consent_authorization_id = v_auth_id,
      consent_ip = p_ip,
      consent_user_agent = p_user_agent
  WHERE id = v_req.id;

  INSERT INTO public.tc_consent_events
    (org_id, event_type, actor_user_id, agent_user_id, tc_user_id, request_id, authorization_id, ip_address, user_agent, payload_json)
  VALUES
    (v_req.org_id, 'consent_given', v_req.agent_user_id, v_req.agent_user_id, v_req.tc_user_id, v_req.id, v_auth_id, p_ip, p_user_agent,
     jsonb_build_object('source','admin_one_tap'));

  INSERT INTO public.tc_authorizations_audit (agent_user_id, tc_user_id, action, ip_address)
  VALUES (v_req.agent_user_id, v_req.tc_user_id, 'granted', p_ip);

  RETURN QUERY SELECT 'consumed'::TEXT, v_auth_id, v_req.agent_user_id, v_req.tc_user_id, v_req.org_id, v_agent_email, v_tc_email, v_org_name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_tc_consent_token(TEXT,INET,TEXT) TO anon, authenticated, service_role;

-- =============================================================================
-- DOD-A-10 (cancel): admin cancels a pending consent request
-- =============================================================================
CREATE OR REPLACE FUNCTION public.cancel_tc_consent_request(
  p_request_id UUID,
  p_acting_user_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_req RECORD;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'cancel_tc_consent_request: no acting user';
  END IF;

  SELECT * INTO v_req FROM public.tc_consent_requests WHERE id = p_request_id;
  IF v_req IS NULL THEN
    RAISE EXCEPTION 'cancel_tc_consent_request: request % not found', p_request_id;
  END IF;

  IF NOT public._mt_user_is_org_admin(v_actor, v_req.org_id) THEN
    RAISE EXCEPTION 'cancel_tc_consent_request: user % not admin on org %', v_actor, v_req.org_id;
  END IF;

  IF v_req.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'cancel_tc_consent_request: request already consumed';
  END IF;

  IF v_req.revoked_at IS NOT NULL THEN
    RETURN; -- idempotent
  END IF;

  UPDATE public.tc_consent_requests
  SET revoked_at = NOW(), revoked_by_user_id = v_actor
  WHERE id = p_request_id;

  INSERT INTO public.tc_consent_events
    (org_id, event_type, actor_user_id, agent_user_id, tc_user_id, request_id, payload_json)
  VALUES
    (v_req.org_id, 'request_canceled_by_admin', v_actor, v_req.agent_user_id, v_req.tc_user_id, p_request_id,
     jsonb_build_object('canceled_by', v_actor));
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_tc_consent_request(UUID,UUID) TO authenticated, service_role;

-- =============================================================================
-- DOD-V-9: mark a member's deletion reminder as sent (idempotency)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.record_deletion_reminder_sent(
  p_member_id UUID,
  p_acting_user_id UUID DEFAULT NULL,
  p_recipients TEXT[] DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_org UUID;
  v_user UUID;
BEGIN
  SELECT org_id, user_id INTO v_org, v_user
  FROM public.organization_members
  WHERE id = p_member_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_deletion_reminder_sent: member % not found', p_member_id;
  END IF;

  UPDATE public.organization_members
  SET deletion_reminder_sent_at = NOW()
  WHERE id = p_member_id AND deletion_reminder_sent_at IS NULL;

  INSERT INTO public.admin_actions_audit
    (org_id, admin_user_id, acted_as_user_id, acting_role, action_type, target_resource_type, target_resource_id, payload_json)
  VALUES
    (v_org, COALESCE(v_actor, v_user), v_user, 'admin', 'data_deletion_reminder_sent',
     'organization_member', p_member_id::TEXT,
     jsonb_build_object('recipients', p_recipients, 'fired_at', NOW()));
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_deletion_reminder_sent(UUID,UUID,TEXT[]) TO service_role;

-- =============================================================================
-- READ helper: get org context for the current user
-- Used by the React app to know which org (if any) the user is on and what
-- roles they hold. Solo customers get NULL.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_my_org_context()
RETURNS TABLE(
  member_id UUID,
  org_id UUID,
  org_name TEXT,
  org_tier TEXT,
  parent_org_id UUID,
  roles TEXT[],
  joined_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    m.id AS member_id,
    o.id AS org_id,
    o.name AS org_name,
    o.tier AS org_tier,
    o.parent_org_id,
    COALESCE(
      ARRAY_AGG(r.role ORDER BY r.role) FILTER (WHERE r.revoked_at IS NULL),
      ARRAY[]::TEXT[]
    ) AS roles,
    m.joined_at
  FROM public.organization_members m
  JOIN public.organizations o ON o.id = m.org_id
  LEFT JOIN public.organization_member_roles r ON r.member_id = m.id AND r.revoked_at IS NULL
  WHERE m.user_id = auth.uid()
    AND m.removed_at IS NULL
    AND o.archived_at IS NULL
  GROUP BY m.id, o.id;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_org_context() TO authenticated;

-- =============================================================================
-- READ helper: roster of the current user's org (for admin roster page)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_org_roster(p_org_id UUID)
RETURNS TABLE(
  member_id UUID,
  user_id UUID,
  email TEXT,
  joined_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  roles TEXT[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public._mt_user_is_org_admin(auth.uid(), p_org_id) THEN
    RAISE EXCEPTION 'get_org_roster: not authorized';
  END IF;

  RETURN QUERY
  SELECT
    m.id AS member_id,
    m.user_id,
    u.email::TEXT,
    m.joined_at,
    m.removed_at,
    COALESCE(
      ARRAY_AGG(r.role ORDER BY r.role) FILTER (WHERE r.revoked_at IS NULL),
      ARRAY[]::TEXT[]
    ) AS roles
  FROM public.organization_members m
  JOIN auth.users u ON u.id = m.user_id
  LEFT JOIN public.organization_member_roles r ON r.member_id = m.id AND r.revoked_at IS NULL
  WHERE m.org_id = p_org_id
  GROUP BY m.id, u.email
  ORDER BY m.removed_at NULLS FIRST, m.joined_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_org_roster(UUID) TO authenticated;

COMMENT ON FUNCTION public.create_org_with_founder IS 'Atomic org creation + founder seating. DOD-O-1, DOD-O-2, DOD-S-7.';
COMMENT ON FUNCTION public.invite_member_with_roles IS 'Admin invites a new member with a role bundle. DOD-A-7.';
COMMENT ON FUNCTION public.remove_org_member IS 'Admin removes a member OR member self-removes. Starts 90-day grace. DOD-A-8, DOD-G-6.';
COMMENT ON FUNCTION public.update_member_roles IS 'Admin grants/revokes individual roles. DOD-A-9.';
COMMENT ON FUNCTION public.toggle_tc_authorization IS 'Agent toggles TC consent via Settings. DOD-G-7.';
COMMENT ON FUNCTION public.create_tc_consent_request IS 'Admin creates a one-tap TC consent request. DOD-A-10.';
COMMENT ON FUNCTION public.consume_tc_consent_token IS 'Agent clicks the one-tap link — anon path. DOD-G-8.';
COMMENT ON FUNCTION public.cancel_tc_consent_request IS 'Admin cancels a pending request. DOD-A-10.';
COMMENT ON FUNCTION public.record_deletion_reminder_sent IS 'Cron records that the 75-day deletion reminder was sent. DOD-V-9.';
COMMENT ON FUNCTION public.get_my_org_context IS 'Returns the org row + role bundle for the current authenticated user.';
COMMENT ON FUNCTION public.get_org_roster IS 'Admin roster page query.';
