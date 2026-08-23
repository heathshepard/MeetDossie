// One-time migration: TC role read-scoping RPC + admin-only transaction
// reassignment RPC — see
// supabase/migrations/20260823180000_team_tc_scoping_and_reassign.sql for the
// full design commentary.
//
// Safe to re-run — CREATE OR REPLACE FUNCTION, no data touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — the
// pulled value is the literal [SENSITIVE]. Same reason the admin-migrate-*
// siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-23 (Team Plan: TC scoping + reassign)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
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
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: '_mt_user_is_org_admin_or_tc + reassign_transaction created (or replaced)',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to apply team-tc-scoping-and-reassign migration',
      details: err.message,
    });
  }
};
