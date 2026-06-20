-- =============================================================================
-- Multi-Tenant Phase 1: Organizations + Members + Roles
-- Definition of Done: 2026-06-19-team-brokerage-multitenant-DOD.md
-- Implements: DOD-S-1, DOD-S-2, DOD-S-2a
-- Author: Atlas
-- =============================================================================
--
-- This migration introduces the org-tier primitives. It is additive only and
-- does NOT touch existing Solo customer data. Backfill plan for upgrades is
-- handled at the application layer (DOD-S-7).
--
-- Roles vs Seats model (load-bearing):
--   - organization_members = 1 row per person on the org (the "seat")
--   - organization_member_roles = stacked capabilities (agent | admin | tc)
--   - Stripe billing counts only members with active 'agent' role
--
-- Rollback: see 20260619163810_multitenant_phase1_orgs_rollback.sql
-- =============================================================================

-- DOD-S-1: organizations table
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('team', 'brokerage')),
  parent_org_id UUID REFERENCES public.organizations(id) ON DELETE RESTRICT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  seat_limit INT,
  seat_price_cents INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  archived_at TIMESTAMPTZ,
  -- Brokerage hierarchy: parent_org_id only allowed when tier = 'team' and parent.tier = 'brokerage'
  -- enforced via trigger below
  CONSTRAINT no_self_parent CHECK (parent_org_id IS NULL OR parent_org_id <> id)
);

CREATE INDEX idx_organizations_parent ON public.organizations(parent_org_id) WHERE parent_org_id IS NOT NULL;
CREATE INDEX idx_organizations_stripe_customer ON public.organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_organizations_active ON public.organizations(archived_at) WHERE archived_at IS NULL;

COMMENT ON TABLE public.organizations IS 'Multi-tenant root: Team and Brokerage orgs. Solo customers have no row here. DOD-S-1.';
COMMENT ON COLUMN public.organizations.parent_org_id IS 'Brokerage->Team nesting. Only set when this row is a Team under a parent Brokerage.';
COMMENT ON COLUMN public.organizations.archived_at IS 'Soft-deletion timestamp from DOD-B-6 teardown. Audit rows survive (DOD-E-6).';

-- Trigger: enforce parent must be brokerage-tier when set
CREATE OR REPLACE FUNCTION public.enforce_org_parent_tier()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  parent_tier TEXT;
BEGIN
  IF NEW.parent_org_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT tier INTO parent_tier FROM public.organizations WHERE id = NEW.parent_org_id;
  IF parent_tier IS NULL THEN
    RAISE EXCEPTION 'parent_org_id % does not exist', NEW.parent_org_id;
  END IF;
  IF parent_tier <> 'brokerage' THEN
    RAISE EXCEPTION 'parent_org_id must reference a brokerage-tier org (got %)', parent_tier;
  END IF;
  IF NEW.tier <> 'team' THEN
    RAISE EXCEPTION 'only team-tier orgs can have a parent_org_id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_org_parent_tier
  BEFORE INSERT OR UPDATE OF parent_org_id, tier ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_org_parent_tier();

-- DOD-S-2: organization_members (Seats)
CREATE TABLE public.organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  invited_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 75-day reminder fired? Set by cron-data-deletion-reminder (DOD-V-9). Idempotency flag.
  deletion_reminder_sent_at TIMESTAMPTZ
);

-- A user can be a member of at most one org at a time (active membership)
CREATE UNIQUE INDEX uniq_active_membership_per_user
  ON public.organization_members(user_id)
  WHERE removed_at IS NULL;

CREATE INDEX idx_org_members_org_active ON public.organization_members(org_id) WHERE removed_at IS NULL;
CREATE INDEX idx_org_members_removed ON public.organization_members(removed_at) WHERE removed_at IS NOT NULL;

COMMENT ON TABLE public.organization_members IS 'Seats on an org. 1 row per person. Roles attach via organization_member_roles. DOD-S-2.';
COMMENT ON COLUMN public.organization_members.removed_at IS 'Start of 90-day grace period (DOD-E-1). Data retained until day 90 unless Vault is active.';
COMMENT ON COLUMN public.organization_members.deletion_reminder_sent_at IS 'Idempotency flag for DOD-V-9 day-75 export reminder cron.';

-- DOD-S-2a: organization_member_roles (stacked capabilities)
CREATE TABLE public.organization_member_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.organization_members(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('agent', 'admin', 'tc')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- A member can hold each role at most once at any given time
CREATE UNIQUE INDEX uniq_active_role_per_member
  ON public.organization_member_roles(member_id, role)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_member_roles_member ON public.organization_member_roles(member_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_member_roles_role ON public.organization_member_roles(role) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.organization_member_roles IS 'Stacked capabilities per seat. Agent | Admin | TC. Roles are additive. Stripe quantity = count(role=agent, revoked_at IS NULL). DOD-S-2a.';

-- Helper view: active members with role array (used by RLS + app code)
CREATE OR REPLACE VIEW public.organization_members_with_roles AS
SELECT
  m.id              AS member_id,
  m.org_id,
  m.user_id,
  m.joined_at,
  m.removed_at,
  m.invited_by_user_id,
  COALESCE(
    ARRAY_AGG(r.role ORDER BY r.role) FILTER (WHERE r.revoked_at IS NULL),
    ARRAY[]::TEXT[]
  ) AS roles
FROM public.organization_members m
LEFT JOIN public.organization_member_roles r
  ON r.member_id = m.id AND r.revoked_at IS NULL
GROUP BY m.id;

COMMENT ON VIEW public.organization_members_with_roles IS 'Convenience: members + role array. Use in RLS subqueries and app dashboards.';

-- ----------------------------------------------------------------------------
-- RLS: enable but allow only service-role and authenticated reads of own membership
-- Full RLS for cross-table (transactions / documents / etc.) lands in Phase 3 migration.
-- ----------------------------------------------------------------------------

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_member_roles ENABLE ROW LEVEL SECURITY;

-- organizations: members of an org can read the org row; admins can update.
CREATE POLICY "org_select_for_members"
  ON public.organizations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members m
      WHERE m.org_id = organizations.id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
    )
  );

CREATE POLICY "org_update_for_admins"
  ON public.organizations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = organizations.id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

-- organizations INSERT is service-role only (signup goes through API)
-- (no policy = denied for authenticated)

-- organization_members: any active member can see roster of own org; admins manage.
CREATE POLICY "members_select_own_org"
  ON public.organization_members FOR SELECT
  USING (
    org_id IN (
      SELECT m.org_id FROM public.organization_members m
      WHERE m.user_id = auth.uid() AND m.removed_at IS NULL
    )
  );

CREATE POLICY "members_insert_admin"
  ON public.organization_members FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = organization_members.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

CREATE POLICY "members_update_admin"
  ON public.organization_members FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_members m
      JOIN public.organization_member_roles r ON r.member_id = m.id
      WHERE m.org_id = organization_members.org_id
        AND m.user_id = auth.uid()
        AND m.removed_at IS NULL
        AND r.role = 'admin'
        AND r.revoked_at IS NULL
    )
  );

-- organization_member_roles: visible to org members; mutated by admins (plus self-revoke guard via trigger below)
CREATE POLICY "roles_select_own_org"
  ON public.organization_member_roles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.organization_members me, public.organization_members target
      WHERE me.user_id = auth.uid() AND me.removed_at IS NULL
        AND target.id = organization_member_roles.member_id
        AND target.org_id = me.org_id
    )
  );

CREATE POLICY "roles_insert_admin"
  ON public.organization_member_roles FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.organization_members admin_m
      JOIN public.organization_member_roles admin_r ON admin_r.member_id = admin_m.id
      JOIN public.organization_members target_m ON target_m.id = organization_member_roles.member_id
      WHERE admin_m.user_id = auth.uid()
        AND admin_m.removed_at IS NULL
        AND admin_m.org_id = target_m.org_id
        AND admin_r.role = 'admin'
        AND admin_r.revoked_at IS NULL
    )
  );

CREATE POLICY "roles_update_admin"
  ON public.organization_member_roles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1
      FROM public.organization_members admin_m
      JOIN public.organization_member_roles admin_r ON admin_r.member_id = admin_m.id
      JOIN public.organization_members target_m ON target_m.id = organization_member_roles.member_id
      WHERE admin_m.user_id = auth.uid()
        AND admin_m.removed_at IS NULL
        AND admin_m.org_id = target_m.org_id
        AND admin_r.role = 'admin'
        AND admin_r.revoked_at IS NULL
    )
  );

-- DOD-E-2: ensure at least one active Admin role survives on every non-archived org
CREATE OR REPLACE FUNCTION public.enforce_last_admin_role()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  remaining_admin_count INT;
  the_org_id UUID;
  is_archived BOOLEAN;
BEGIN
  -- Only fire on UPDATE that sets revoked_at, or DELETE
  IF TG_OP = 'UPDATE' THEN
    IF NEW.role <> 'admin' OR (NEW.revoked_at IS NULL AND OLD.revoked_at IS NULL) THEN
      RETURN NEW;
    END IF;
    -- if revoking a non-admin role, ignore
    IF OLD.role <> 'admin' THEN RETURN NEW; END IF;
  END IF;

  -- Find the org for this role's member
  SELECT m.org_id, (o.archived_at IS NOT NULL)
    INTO the_org_id, is_archived
  FROM public.organization_members m
  JOIN public.organizations o ON o.id = m.org_id
  WHERE m.id = COALESCE(NEW.member_id, OLD.member_id);

  -- Don't enforce on archived orgs (DOD-E-6 — teardown can proceed)
  IF is_archived THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Count remaining active admins after this change
  SELECT COUNT(*) INTO remaining_admin_count
  FROM public.organization_member_roles r
  JOIN public.organization_members m ON m.id = r.member_id
  WHERE m.org_id = the_org_id
    AND m.removed_at IS NULL
    AND r.role = 'admin'
    AND r.revoked_at IS NULL
    AND r.id <> COALESCE(NEW.id, OLD.id);

  IF remaining_admin_count = 0 THEN
    RAISE EXCEPTION 'cannot revoke last active admin on org % — promote another admin first (DOD-E-2)', the_org_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_enforce_last_admin_update
  BEFORE UPDATE OF revoked_at ON public.organization_member_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_last_admin_role();

CREATE TRIGGER trg_enforce_last_admin_delete
  BEFORE DELETE ON public.organization_member_roles
  FOR EACH ROW EXECUTE FUNCTION public.enforce_last_admin_role();

-- DOD-E-2 also: removing the last admin via organization_members.removed_at must be blocked.
-- We enforce by checking on update of removed_at that another admin remains.
CREATE OR REPLACE FUNCTION public.enforce_last_admin_member()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  remaining_admin_count INT;
  was_admin BOOLEAN;
  is_archived BOOLEAN;
BEGIN
  -- Only fire when removed_at transitions from NULL to non-NULL
  IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT (archived_at IS NOT NULL) INTO is_archived
  FROM public.organizations WHERE id = NEW.org_id;
  IF is_archived THEN RETURN NEW; END IF;

  -- Was this member an active admin?
  SELECT EXISTS (
    SELECT 1 FROM public.organization_member_roles
    WHERE member_id = NEW.id AND role = 'admin' AND revoked_at IS NULL
  ) INTO was_admin;

  IF NOT was_admin THEN RETURN NEW; END IF;

  -- Count remaining active admins on org excluding this member
  SELECT COUNT(*) INTO remaining_admin_count
  FROM public.organization_member_roles r
  JOIN public.organization_members m ON m.id = r.member_id
  WHERE m.org_id = NEW.org_id
    AND m.removed_at IS NULL
    AND m.id <> NEW.id
    AND r.role = 'admin'
    AND r.revoked_at IS NULL;

  IF remaining_admin_count = 0 THEN
    RAISE EXCEPTION 'cannot remove last active admin from org % — promote another admin first (DOD-E-2)', NEW.org_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_last_admin_member
  BEFORE UPDATE OF removed_at ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_last_admin_member();
