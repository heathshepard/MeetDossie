-- =============================================================================
-- Team Plan: real TC role scoping + transaction reassignment
-- Heath confirmed both 2026-08-23 ("yes build them").
-- =============================================================================
--
-- 1. TC role read-scoping. Before this, 'tc' (alongside 'agent'/'admin' in
--    VALID_ROLES) did nothing functionally — just a colored badge in
--    TeamView.jsx. This gives a member with the 'tc' role team-wide
--    dossier/risk VISIBILITY identical to admin, WITHOUT admin-only write
--    capabilities (invite/remove/rename/billing stay gated to
--    _mt_user_is_org_admin exclusively — this function is additive, it does
--    not touch that check anywhere).
--
-- 2. Admin-only transaction reassignment — move an open dossier from one
--    active team member to another (agent leaves, goes on leave, etc).
--    Mirrors remove_org_member/update_member_roles: the RPC re-derives
--    org_id from the transaction itself and re-checks admin status on THAT
--    org before touching anything, so the caller (API route) never has to
--    be trusted to have already checked.

-- -----------------------------------------------------------------------------
-- _mt_user_is_org_admin_or_tc — parallel to _mt_user_is_org_admin, used ONLY
-- by the read/visibility endpoints (org-dossiers, org-dossier-detail,
-- org-risk-overview, team chat context). Never used for invite/remove/rename/
-- billing — those keep the strict admin-only check unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._mt_user_is_org_admin_or_tc(p_user_id UUID, p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members m
    JOIN public.organization_member_roles r ON r.member_id = m.id
    WHERE m.org_id = p_org_id
      AND m.user_id = p_user_id
      AND m.removed_at IS NULL
      AND r.role IN ('admin', 'tc')
      AND r.revoked_at IS NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public._mt_user_is_org_admin_or_tc(UUID, UUID) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- reassign_transaction — admin-only. Moves transactions.user_id (the actual
-- FK column that associates a dossier with its owning agent — confirmed via
-- schema read, not guessed) from whoever currently owns it to a different
-- ACTIVE member of the SAME org the transaction already belongs to.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reassign_transaction(
  p_transaction_id UUID,
  p_new_user_id UUID,
  p_acting_user_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor UUID := public._mt_acting_user(p_acting_user_id);
  v_org UUID;
  v_old_user UUID;
BEGIN
  SELECT org_id, user_id INTO v_org, v_old_user
  FROM public.transactions
  WHERE id = p_transaction_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'reassign_transaction: transaction % not found or not on a team org', p_transaction_id;
  END IF;

  IF NOT public._mt_user_is_org_admin(v_actor, v_org) THEN
    RAISE EXCEPTION 'reassign_transaction: user % is not an admin on org %', v_actor, v_org;
  END IF;

  IF p_new_user_id = v_old_user THEN
    RAISE EXCEPTION 'reassign_transaction: transaction % is already owned by %', p_transaction_id, p_new_user_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE org_id = v_org AND user_id = p_new_user_id AND removed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'reassign_transaction: user % is not an active member of org %', p_new_user_id, v_org;
  END IF;

  UPDATE public.transactions SET user_id = p_new_user_id WHERE id = p_transaction_id;

  INSERT INTO public.admin_actions_audit
    (org_id, admin_user_id, acted_as_user_id, acting_role, action_type, target_resource_type, target_resource_id, payload_json)
  VALUES
    (v_org, v_actor, p_new_user_id, 'admin', 'edit_transaction',
     'transaction', p_transaction_id::TEXT,
     jsonb_build_object('action', 'reassign', 'field', 'user_id', 'old_user_id', v_old_user, 'new_user_id', p_new_user_id));
END;
$$;

GRANT EXECUTE ON FUNCTION public.reassign_transaction(UUID, UUID, UUID) TO service_role;
