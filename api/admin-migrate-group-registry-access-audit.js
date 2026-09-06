// One-time migration: add access-audit columns to public.group_registry
// (access_state, promo_policy, member_count, post_volume_7d,
// question_signal, audit_notes, last_audited_at).
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260906_group_registry_access_audit.sql and the exact
// pattern of api/admin-migrate-comment-watchlist.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-06

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.group_registry
  ADD COLUMN IF NOT EXISTS access_state text
    CHECK (access_state IN (
      'member-and-readable',
      'member-but-feed-empty',
      'pending-approval',
      'not-a-member',
      'inaccessible-or-removed',
      'group-deleted'
    )),
  ADD COLUMN IF NOT EXISTS promo_policy text,
  ADD COLUMN IF NOT EXISTS member_count integer,
  ADD COLUMN IF NOT EXISTS post_volume_7d integer,
  ADD COLUMN IF NOT EXISTS question_signal text
    CHECK (question_signal IN (
      'answerable-questions',
      'listings-feed',
      'jobs-board',
      'vendor-spam',
      'unclear-low-sample'
    ) OR question_signal IS NULL),
  ADD COLUMN IF NOT EXISTS audit_notes text,
  ADD COLUMN IF NOT EXISTS last_audited_at timestamptz;

COMMENT ON COLUMN public.group_registry.access_state IS
  'Read-only audit result (Carter, 2026-09-06): can DossieBot actually see this group''s feed right now.';
COMMENT ON COLUMN public.group_registry.promo_policy IS
  'Verbatim self-promotion/vendor rule quoted from the group''s pinned Group Rules (About tab), when readable. NULL if rules unreadable or no promo-specific line found.';
COMMENT ON COLUMN public.group_registry.member_count IS
  'Member count as rendered on the group page at audit time (approximate, FB-rounded).';
COMMENT ON COLUMN public.group_registry.post_volume_7d IS
  'Rough count of visible posts with a relative timestamp <=7d, from a capped-scroll sample. Not exhaustive -- an inventory signal, not a full count.';
COMMENT ON COLUMN public.group_registry.question_signal IS
  'Best-effort classification of the visible post sample: real answerable questions vs listings feed vs jobs board vs vendor spam vs too little sample to tell.';
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'group_registry access-audit columns added successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate group_registry',
      detail: err.message,
    });
  }
};
