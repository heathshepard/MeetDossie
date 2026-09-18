// One-time migration: add provenance-annotation columns to
// public.group_registry (existence_verified, existence_verified_note,
// acting_identity, requires_admin_approval).
//
// DDL isn't reachable through PostgREST, so this runs directly against
// Postgres via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING). Mirrors
// supabase/migrations/20260917_group_registry_history_backfill_annotations.sql
// and the exact pattern of api/admin-migrate-group-registry-access-audit.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-17

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.group_registry
  ADD COLUMN IF NOT EXISTS existence_verified boolean,
  ADD COLUMN IF NOT EXISTS existence_verified_note text,
  ADD COLUMN IF NOT EXISTS acting_identity text
    CHECK (acting_identity IN ('personal', 'dossiebot', 'unknown') OR acting_identity IS NULL),
  ADD COLUMN IF NOT EXISTS requires_admin_approval text
    CHECK (requires_admin_approval IN ('yes', 'no', 'unknown') OR requires_admin_approval IS NULL);

COMMENT ON COLUMN public.group_registry.existence_verified IS
  'Whether we have direct, in-record proof this group is real and reachable (e.g. an actual posted group_posts row with a real post_url) vs. a name/URL that has never been confirmed live.';
COMMENT ON COLUMN public.group_registry.existence_verified_note IS
  'What existence_verified is based on -- e.g. which group_posts row/date, or note that a live re-verify pass is still needed.';
COMMENT ON COLUMN public.group_registry.acting_identity IS
  'Which Facebook identity actually holds membership/posting access for this group at last verification -- personal profile vs the DossieBot Chrome-profile identity. Access does not transfer between identities.';
COMMENT ON COLUMN public.group_registry.requires_admin_approval IS
  'Whether posts to this group are held for admin approval before going live. unknown when the record does not distinguish (e.g. a single post that went straight to posted status is suggestive but not conclusive).';
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
      message: 'group_registry history-annotation columns created successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add group_registry history-annotation columns',
      detail: err.message,
    });
  }
};
