-- =============================================================================
-- Team seat-overage price raised from $35/seat to $79.99/seat — Heath's
-- explicit, considered pricing decision 2026-08-23 (same day as, and right
-- after, the $79/seat-bug -> $35/seat fix in
-- 20260823170000_fix_team_seat_price_default.sql). See
-- docs/PRICING-HISTORY.md for the full writeup — this is a pricing change,
-- not a bug fix. No real Team subscription existed at the time of either
-- change, so there was nothing to grandfather.
--
-- Adding a NEW migration rather than re-editing 20260823170000 so the
-- migration history reads forward (7900 -> 3500 -> 7999) instead of being
-- rewritten. As of this migration, no migration in this chain has actually
-- been applied to the live DB yet — no DB credential was available in the
-- agent session that authored any of them. That's a separate infrastructure
-- gap, not a reason to skip writing the correct migration.
--
-- Function body is otherwise byte-identical to 20260823170000's version;
-- only p_seat_price_cents's DEFAULT changed. CREATE OR REPLACE FUNCTION
-- requires the full definition, not just the changed line.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_org_with_founder(
  p_name TEXT,
  p_tier TEXT,                              -- 'team' | 'brokerage'
  p_founder_user_id UUID,
  p_founder_roles TEXT[],                   -- subset of {'agent','admin','tc'}
  p_seat_price_cents INT DEFAULT 7999,
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

COMMENT ON FUNCTION public.create_org_with_founder IS 'Atomic org creation + founder seating. DOD-O-1, DOD-O-2, DOD-S-7. Seat price default: 7900 (bug) -> 3500 ($35/seat) -> 7999 ($79.99/seat, Heath''s pricing decision 2026-08-23). See docs/PRICING-HISTORY.md.';
