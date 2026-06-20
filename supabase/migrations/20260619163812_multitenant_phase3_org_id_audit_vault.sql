-- =============================================================================
-- Multi-Tenant Phase 3: org_id columns + admin_actions_audit + RLS + Data Vault
-- DOD-S-3, DOD-S-4, DOD-S-5, DOD-S-8, DOD-S-9
-- =============================================================================
--
-- Backfill posture (DOD-S-7): existing Solo customer rows keep user_id but get
-- NULL org_id. Solo RLS path is unchanged. Org RLS only fires when org_id IS NOT NULL.
-- =============================================================================

-- DOD-S-3: add org_id to each customer-owned table
-- Note: social_posts has no user_id (it's platform-marketing-owned, not customer-owned).
-- We add org_id for consistency but social_posts RLS is unchanged (service-role only).
ALTER TABLE public.transactions       ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;
ALTER TABLE public.documents          ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;
ALTER TABLE public.action_items       ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;
ALTER TABLE public.email_queue        ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;
ALTER TABLE public.social_posts       ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;
ALTER TABLE public.dossier_milestones ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL;

-- Also add user_id to social_posts as nullable (for future per-agent attribution of marketing content)
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_org       ON public.transactions(org_id)       WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_org          ON public.documents(org_id)          WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_items_org       ON public.action_items(org_id)       WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_queue_org        ON public.email_queue(org_id)        WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_org       ON public.social_posts(org_id)       WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dossier_milestones_org ON public.dossier_milestones(org_id) WHERE org_id IS NOT NULL;

COMMENT ON COLUMN public.transactions.org_id IS 'Multi-tenant scope. NULL for Solo customers (DOD-S-7). DOD-S-3.';
COMMENT ON COLUMN public.documents.org_id IS 'Multi-tenant scope. NULL for Solo customers. DOD-S-3.';

-- DOD-S-4: admin_actions_audit
CREATE TABLE public.admin_actions_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  acted_as_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  acting_role TEXT NOT NULL CHECK (acting_role IN ('admin', 'tc')),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'view',
    'create_transaction', 'edit_transaction', 'move_stage',
    'upload_document', 'delete_document',
    'draft_email', 'send_email',
    'create_action_item',
    'prefill_form', 'route_compliance_doc',
    'data_deletion_reminder_sent'
  )),
  target_resource_type TEXT,
  target_resource_id TEXT,
  payload_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address INET
);

CREATE INDEX idx_admin_audit_org      ON public.admin_actions_audit(org_id, created_at DESC);
CREATE INDEX idx_admin_audit_actedas  ON public.admin_actions_audit(acted_as_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_admin    ON public.admin_actions_audit(admin_user_id, created_at DESC);
CREATE INDEX idx_admin_audit_action   ON public.admin_actions_audit(action_type, created_at DESC);

COMMENT ON TABLE public.admin_actions_audit IS 'Append-only audit log of admin + TC actions in agent workspaces. DOD-S-4, DOD-A-3, DOD-A-4.';

ALTER TABLE public.admin_actions_audit ENABLE ROW LEVEL SECURITY;

-- Append-only: block UPDATE / DELETE
CREATE TRIGGER trg_block_admin_audit_update
  BEFORE UPDATE ON public.admin_actions_audit
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutations();
CREATE TRIGGER trg_block_admin_audit_delete
  BEFORE DELETE ON public.admin_actions_audit
  FOR EACH ROW EXECUTE FUNCTION public.block_audit_mutations();

-- Admin in same org can see audit; acted-as agent can see actions on themselves; actor can see own.
CREATE POLICY "admin_audit_select"
  ON public.admin_actions_audit FOR SELECT
  USING (
    admin_user_id = auth.uid()
    OR acted_as_user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = admin_actions_audit.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

-- Insert via SECURITY DEFINER RPC or service role only.

-- DOD-S-5: Multi-tenant RLS on customer tables.
-- Pattern (per table):
--   - keep existing user_id-based policies for Solo (org_id IS NULL)
--   - add org-aware policies for Team/Brokerage (org_id IS NOT NULL):
--       SELECT: user owns OR user is admin on org OR (table=email_queue specifically: TC with active auth)
--       INSERT/UPDATE/DELETE: user owns OR user is admin on org (TC send-email handled at API + trigger layer)
-- Signing-related tables (signature_requests) require user_id = auth.uid() ALWAYS, even for admins.

-- Helper: is_org_admin(org)
CREATE OR REPLACE FUNCTION public.is_org_admin(target_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organization_member_roles r ON r.member_id = m.id
    WHERE m.org_id = target_org_id
      AND m.user_id = auth.uid()
      AND m.removed_at IS NULL
      AND r.role = 'admin'
      AND r.revoked_at IS NULL
  );
$$;

-- Helper: has_active_tc_auth(agent, target_agent) — is current user a TC authorized to send for target?
CREATE OR REPLACE FUNCTION public.has_active_tc_auth(target_agent_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.tc_authorizations
    WHERE agent_user_id = target_agent_id
      AND tc_user_id = auth.uid()
      AND revoked_at IS NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_org_admin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_active_tc_auth(UUID) TO authenticated;

-- ---------- transactions ----------
-- Drop any existing org-blind policies and re-create with org-aware logic.
-- We do not touch existing user_id policies; we ADD org-aware policies.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transactions' AND policyname='org_admin_select_transactions') THEN
    DROP POLICY "org_admin_select_transactions" ON public.transactions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='transactions' AND policyname='org_admin_modify_transactions') THEN
    DROP POLICY "org_admin_modify_transactions" ON public.transactions;
  END IF;
END $$;

CREATE POLICY "org_admin_select_transactions"
  ON public.transactions FOR SELECT
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));

CREATE POLICY "org_admin_insert_transactions"
  ON public.transactions FOR INSERT
  WITH CHECK (org_id IS NOT NULL AND public.is_org_admin(org_id));

CREATE POLICY "org_admin_update_transactions"
  ON public.transactions FOR UPDATE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));

CREATE POLICY "org_admin_delete_transactions"
  ON public.transactions FOR DELETE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));

-- ---------- documents ----------
CREATE POLICY "org_admin_select_documents"
  ON public.documents FOR SELECT
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_insert_documents"
  ON public.documents FOR INSERT
  WITH CHECK (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_update_documents"
  ON public.documents FOR UPDATE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_delete_documents"
  ON public.documents FOR DELETE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));

-- ---------- action_items ----------
CREATE POLICY "org_admin_select_action_items"
  ON public.action_items FOR SELECT
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_insert_action_items"
  ON public.action_items FOR INSERT
  WITH CHECK (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_update_action_items"
  ON public.action_items FOR UPDATE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_delete_action_items"
  ON public.action_items FOR DELETE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));

-- ---------- email_queue ----------
-- Admin can SELECT/INSERT (draft) / UPDATE / DELETE rows in their org.
-- TC can SELECT rows for agents who've authorized them; INSERT with status='sent' allowed
-- only when TC has active auth for acted_as_user_id (enforced at API + trigger below).
CREATE POLICY "org_admin_select_email_queue"
  ON public.email_queue FOR SELECT
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_insert_email_queue"
  ON public.email_queue FOR INSERT
  WITH CHECK (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_update_email_queue"
  ON public.email_queue FOR UPDATE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));

CREATE POLICY "tc_select_authorized_email_queue"
  ON public.email_queue FOR SELECT
  USING (
    org_id IS NOT NULL
    AND user_id IS NOT NULL
    AND public.has_active_tc_auth(user_id)
  );

-- TC INSERT/UPDATE handled at API layer with explicit auth check (DOD-A-4).
-- The trigger below guards against direct DB writes that bypass the auth check.

-- ---------- dossier_milestones ----------
CREATE POLICY "org_admin_select_dossier_milestones"
  ON public.dossier_milestones FOR SELECT
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_insert_dossier_milestones"
  ON public.dossier_milestones FOR INSERT
  WITH CHECK (org_id IS NOT NULL AND public.is_org_admin(org_id));
CREATE POLICY "org_admin_update_dossier_milestones"
  ON public.dossier_milestones FOR UPDATE
  USING (org_id IS NOT NULL AND public.is_org_admin(org_id));

-- ---------- email_queue write guard (DOD-S-5 signing-style enforcement for TC sends) ----------
-- Any INSERT/UPDATE that sets status='sent' on email_queue, where user_id != auth.uid()
-- (i.e., a TC sending on behalf of an agent), must have an active tc_authorization for that pair.
-- Service-role bypass via session_user check.
CREATE OR REPLACE FUNCTION public.enforce_tc_send_authorization()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  is_service BOOLEAN;
BEGIN
  -- Service role bypass: when the role is service_role, skip
  SELECT current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
    INTO is_service;
  IF is_service THEN RETURN NEW; END IF;

  -- Only fire when status transitions to 'sent' and acted_as != actor
  IF NEW.status IS DISTINCT FROM 'sent' THEN RETURN NEW; END IF;
  IF NEW.user_id = auth.uid() THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- TC must have active authorization for the target agent
  IF NOT public.has_active_tc_auth(NEW.user_id) THEN
    RAISE EXCEPTION 'TC % is not authorized to send email on behalf of agent % (DOD-A-4 / DOD-S-5)', auth.uid(), NEW.user_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_tc_send_authorization
  BEFORE INSERT OR UPDATE OF status, user_id ON public.email_queue
  FOR EACH ROW EXECUTE FUNCTION public.enforce_tc_send_authorization();

-- ---------- Signing-related write guard (DOD-S-5: signing always = agent's own act) ----------
-- signature_requests already has user_id. Add a trigger that blocks INSERT/UPDATE
-- by anyone other than the row's user_id (no admin/TC bypass, even with org_id match).
CREATE OR REPLACE FUNCTION public.enforce_self_signing()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  is_service BOOLEAN;
BEGIN
  SELECT current_setting('request.jwt.claims', true)::jsonb->>'role' = 'service_role'
    INTO is_service;
  IF is_service THEN RETURN NEW; END IF;
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;  -- background contexts handled by service role

  IF NEW.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'signing actions must be performed by the agent themselves (DOD-S-5, DOD-Q-4). actor=% target=%', auth.uid(), NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Apply to signature_requests
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='signature_requests') THEN
    EXECUTE 'CREATE TRIGGER trg_enforce_self_signing_sig_req BEFORE INSERT OR UPDATE ON public.signature_requests FOR EACH ROW EXECUTE FUNCTION public.enforce_self_signing()';
  END IF;
END $$;

-- =============================================================================
-- DOD-S-8: data_vault_subscriptions
-- =============================================================================
CREATE TABLE public.data_vault_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  stripe_subscription_item_id TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('starter', 'pro', 'enterprise', 'custom', 'brokerage_bundle')),
  storage_quota_bytes BIGINT NOT NULL,
  monthly_price_cents INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  canceled_at TIMESTAMPTZ,
  grace_period_ends_at TIMESTAMPTZ
);

CREATE INDEX idx_vault_org_active ON public.data_vault_subscriptions(org_id) WHERE canceled_at IS NULL;
CREATE INDEX idx_vault_grace ON public.data_vault_subscriptions(grace_period_ends_at) WHERE grace_period_ends_at IS NOT NULL;
CREATE UNIQUE INDEX uniq_vault_active_per_org ON public.data_vault_subscriptions(org_id) WHERE canceled_at IS NULL;

COMMENT ON TABLE public.data_vault_subscriptions IS 'Data Vault subscription per org. 1 active row max. Brokerage gets implicit 1TB bundle. DOD-S-8.';

ALTER TABLE public.data_vault_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vault_select_admin"
  ON public.data_vault_subscriptions FOR SELECT
  USING (public.is_org_admin(org_id));

-- =============================================================================
-- DOD-S-9: storage_usage_snapshots
-- =============================================================================
CREATE TABLE public.storage_usage_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_bytes BIGINT NOT NULL DEFAULT 0,
  archived_agent_bytes BIGINT NOT NULL DEFAULT 0,
  active_agent_bytes BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_storage_snapshots_org ON public.storage_usage_snapshots(org_id, snapshot_at DESC);

COMMENT ON TABLE public.storage_usage_snapshots IS 'Daily storage rollups per org. Used to enforce Vault quota and surface usage. DOD-S-9.';

ALTER TABLE public.storage_usage_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "storage_snapshots_select_admin"
  ON public.storage_usage_snapshots FOR SELECT
  USING (public.is_org_admin(org_id));
