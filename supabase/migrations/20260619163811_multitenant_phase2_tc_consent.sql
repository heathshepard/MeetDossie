-- =============================================================================
-- Multi-Tenant Phase 2: TC Authorization + Consent Flow + Audit
-- DOD-S-2b, DOD-S-2c, DOD-S-2d, DOD-S-2e
-- =============================================================================
--
-- Architecture:
--   tc_authorizations         = active grants (current state)
--   tc_authorizations_audit   = LEGACY append-only log (superseded by tc_consent_events;
--                               kept readable during migration window)
--   tc_consent_requests       = admin one-tap consent requests (DOD-A-10)
--   tc_consent_events         = canonical append-only audit log (NEW writes go here)
-- =============================================================================

-- DOD-S-2b: tc_authorizations (current grants)
CREATE TABLE public.tc_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tc_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  granted_via TEXT NOT NULL DEFAULT 'agent_settings_toggle'
    CHECK (granted_via IN ('agent_settings_toggle', 'admin_request_one_tap')),
  request_id UUID,  -- FK added after tc_consent_requests is created
  request_ip INET,
  request_user_agent TEXT,
  consent_ip INET,
  consent_user_agent TEXT,
  CONSTRAINT agent_not_tc CHECK (agent_user_id <> tc_user_id)
);

CREATE UNIQUE INDEX uniq_active_tc_auth
  ON public.tc_authorizations(agent_user_id, tc_user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_tc_auth_agent ON public.tc_authorizations(agent_user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_tc_auth_tc ON public.tc_authorizations(tc_user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_tc_auth_org ON public.tc_authorizations(org_id);

COMMENT ON TABLE public.tc_authorizations IS 'Active TC -> Agent send-on-behalf grants. Per-pair consent. DOD-S-2b.';
COMMENT ON COLUMN public.tc_authorizations.granted_via IS 'agent_settings_toggle = agent flipped toggle; admin_request_one_tap = admin sent request, agent clicked one-tap link.';
COMMENT ON COLUMN public.tc_authorizations.request_id IS 'FK to tc_consent_requests if granted via one-tap flow.';

-- DOD-S-2c: LEGACY tc_authorizations_audit (kept for migration; new writes go to tc_consent_events)
CREATE TABLE public.tc_authorizations_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_user_id UUID NOT NULL,
  tc_user_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address INET
);

CREATE INDEX idx_tc_audit_agent ON public.tc_authorizations_audit(agent_user_id, created_at DESC);
CREATE INDEX idx_tc_audit_tc ON public.tc_authorizations_audit(tc_user_id, created_at DESC);

COMMENT ON TABLE public.tc_authorizations_audit IS 'LEGACY append-only log. SUPERSEDED by tc_consent_events for new code paths. Kept for backward read compatibility. DOD-S-2c.';

-- DOD-S-2d: tc_consent_requests (admin one-tap flow)
CREATE TABLE public.tc_consent_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tc_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_channels TEXT[] NOT NULL DEFAULT ARRAY['email']::TEXT[]
    CHECK (delivery_channels <@ ARRAY['email','telegram']::TEXT[] AND array_length(delivery_channels, 1) >= 1),
  -- one_tap_token: stored as SHA-256 hex of the raw UUID token. App keeps raw token only long enough to deliver.
  one_tap_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  consumed_at TIMESTAMPTZ,
  consent_authorization_id UUID REFERENCES public.tc_authorizations(id) ON DELETE SET NULL,
  consent_ip INET,
  consent_user_agent TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT consent_agent_not_tc CHECK (agent_user_id <> tc_user_id)
);

CREATE UNIQUE INDEX uniq_one_tap_token ON public.tc_consent_requests(one_tap_token);
CREATE INDEX idx_consent_req_agent_tc ON public.tc_consent_requests(agent_user_id, tc_user_id, consumed_at);
CREATE INDEX idx_consent_req_org ON public.tc_consent_requests(org_id, created_at DESC);
CREATE INDEX idx_consent_req_pending ON public.tc_consent_requests(token_expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE public.tc_consent_requests IS 'Admin one-tap TC consent requests. Single-use tokens, 7-day expiry. DOD-S-2d, DOD-A-10.';
COMMENT ON COLUMN public.tc_consent_requests.one_tap_token IS 'SHA-256 hash of the raw UUID token. Raw token sent in URL once, never stored.';

-- Now wire tc_authorizations.request_id -> tc_consent_requests.id
ALTER TABLE public.tc_authorizations
  ADD CONSTRAINT fk_tc_auth_request
  FOREIGN KEY (request_id) REFERENCES public.tc_consent_requests(id) ON DELETE SET NULL;

-- DOD-S-2e: tc_consent_events (canonical audit log)
CREATE TABLE public.tc_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'request_sent',
    'consent_given',
    'consent_revoked',
    'send_on_behalf_executed',
    'request_canceled_by_admin',
    'request_expired'
  )),
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  agent_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tc_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_id UUID REFERENCES public.tc_consent_requests(id) ON DELETE SET NULL,
  authorization_id UUID REFERENCES public.tc_authorizations(id) ON DELETE SET NULL,
  email_queue_id UUID,  -- FK to email_queue.id; nullable; not enforced as FK to avoid migration coupling
  delivery_channels TEXT[],
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload_json JSONB
);

CREATE INDEX idx_consent_events_org ON public.tc_consent_events(org_id, created_at DESC);
CREATE INDEX idx_consent_events_agent ON public.tc_consent_events(agent_user_id, created_at DESC);
CREATE INDEX idx_consent_events_tc ON public.tc_consent_events(tc_user_id, created_at DESC);
CREATE INDEX idx_consent_events_type ON public.tc_consent_events(event_type, created_at DESC);

COMMENT ON TABLE public.tc_consent_events IS 'CANONICAL append-only TC audit log. All new TC events write here. DOD-S-2e.';

-- Append-only enforcement: block UPDATE and DELETE on tc_consent_events and tc_authorizations_audit
CREATE OR REPLACE FUNCTION public.block_audit_mutations()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit log table % is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_block_consent_events_update
  BEFORE UPDATE ON public.tc_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutations();

CREATE TRIGGER trg_block_consent_events_delete
  BEFORE DELETE ON public.tc_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutations();

CREATE TRIGGER trg_block_tc_audit_update
  BEFORE UPDATE ON public.tc_authorizations_audit
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutations();

CREATE TRIGGER trg_block_tc_audit_delete
  BEFORE DELETE ON public.tc_authorizations_audit
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutations();

-- DOD-E-7: when a member's TC role is revoked, auto-revoke that TC's authorizations
CREATE OR REPLACE FUNCTION public.auto_revoke_tc_auths_on_role_revoke()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  the_user_id UUID;
  the_org_id UUID;
BEGIN
  IF NEW.role <> 'tc' OR NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.user_id, m.org_id INTO the_user_id, the_org_id
  FROM public.organization_members m WHERE m.id = NEW.member_id;

  -- Revoke all active authorizations where this user is the TC
  UPDATE public.tc_authorizations
  SET revoked_at = NOW()
  WHERE tc_user_id = the_user_id
    AND org_id = the_org_id
    AND revoked_at IS NULL;

  -- Audit each revocation
  INSERT INTO public.tc_consent_events
    (org_id, event_type, actor_user_id, agent_user_id, tc_user_id, authorization_id, payload_json)
  SELECT
    org_id, 'consent_revoked', NEW.revoked_by_user_id, agent_user_id, tc_user_id, id,
    jsonb_build_object('reason', 'tc_role_revoked', 'member_id', NEW.member_id)
  FROM public.tc_authorizations
  WHERE tc_user_id = the_user_id
    AND org_id = the_org_id
    AND revoked_at >= NOW() - INTERVAL '1 second';

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_revoke_tc_auths
  AFTER UPDATE OF revoked_at ON public.organization_member_roles
  FOR EACH ROW EXECUTE FUNCTION public.auto_revoke_tc_auths_on_role_revoke();

-- RLS

ALTER TABLE public.tc_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tc_authorizations_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tc_consent_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tc_consent_events ENABLE ROW LEVEL SECURITY;

-- tc_authorizations: agent can see their own; TC can see their own; admin can see all in org
CREATE POLICY "tc_auth_select_own_or_admin"
  ON public.tc_authorizations FOR SELECT
  USING (
    agent_user_id = auth.uid()
    OR tc_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = tc_authorizations.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

-- Only the agent themselves can INSERT/UPDATE their own authorization (settings toggle path)
-- The one-tap path goes through a SECURITY DEFINER RPC, not direct insert.
CREATE POLICY "tc_auth_insert_self"
  ON public.tc_authorizations FOR INSERT
  WITH CHECK (agent_user_id = auth.uid());

CREATE POLICY "tc_auth_update_self"
  ON public.tc_authorizations FOR UPDATE
  USING (agent_user_id = auth.uid());

-- tc_authorizations_audit: visible to agent + tc + admin
CREATE POLICY "tc_audit_select"
  ON public.tc_authorizations_audit FOR SELECT
  USING (
    agent_user_id = auth.uid()
    OR tc_user_id = auth.uid()
  );
-- No INSERT/UPDATE/DELETE policies = service-role / SECURITY DEFINER only

-- tc_consent_requests: admin sees own org's requests; agent sees requests targeting them
CREATE POLICY "consent_req_select"
  ON public.tc_consent_requests FOR SELECT
  USING (
    agent_user_id = auth.uid()
    OR admin_user_id = auth.uid()
    OR tc_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = tc_consent_requests.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

-- Admin can INSERT requests for their org
CREATE POLICY "consent_req_insert_admin"
  ON public.tc_consent_requests FOR INSERT
  WITH CHECK (
    admin_user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = tc_consent_requests.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

-- Admin can UPDATE (cancel) their own pending requests
CREATE POLICY "consent_req_update_admin"
  ON public.tc_consent_requests FOR UPDATE
  USING (
    admin_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = tc_consent_requests.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

-- tc_consent_events: visible to agent + tc + admin of org. Insert via SECURITY DEFINER only.
CREATE POLICY "consent_events_select"
  ON public.tc_consent_events FOR SELECT
  USING (
    agent_user_id = auth.uid()
    OR tc_user_id = auth.uid()
    OR actor_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = tc_consent_events.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );
-- No insert/update/delete policies — append-only via service role and SECURITY DEFINER RPCs
