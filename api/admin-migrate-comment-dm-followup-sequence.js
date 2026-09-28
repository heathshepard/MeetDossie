// One-time migration: comment_dm_leads follow-up-sequence columns.
// See supabase/migrations/20260928_comment_dm_followup_sequence.sql for the
// full design commentary.
//
// Safe to re-run -- ADD COLUMN IF NOT EXISTS / guarded CHECK adds, no data
// touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell -- the
// pulled value is the literal [SENSITIVE]. Same reason the admin-migrate-*
// siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-28

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.comment_dm_leads
  ADD COLUMN IF NOT EXISTS user_replied BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_replied_marked_by TEXT,
  ADD COLUMN IF NOT EXISTS dm_link_tag TEXT,
  ADD COLUMN IF NOT EXISTS touch2_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS touch2_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS touch2_error TEXT,
  ADD COLUMN IF NOT EXISTS touch3_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS touch3_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS touch3_error TEXT,
  ADD COLUMN IF NOT EXISTS needs_manual BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_manual_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS needs_manual_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_followup_attempt_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_dm_leads_touch2_status_chk') THEN
    ALTER TABLE public.comment_dm_leads
      ADD CONSTRAINT comment_dm_leads_touch2_status_chk
      CHECK (touch2_status IN ('pending', 'sent', 'needs_manual', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_dm_leads_touch3_status_chk') THEN
    ALTER TABLE public.comment_dm_leads
      ADD CONSTRAINT comment_dm_leads_touch3_status_chk
      CHECK (touch3_status IN ('pending', 'sent', 'needs_manual', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS comment_dm_leads_touch2_status_idx ON public.comment_dm_leads (touch2_status);
CREATE INDEX IF NOT EXISTS comment_dm_leads_touch3_status_idx ON public.comment_dm_leads (touch3_status);
CREATE INDEX IF NOT EXISTS comment_dm_leads_needs_manual_idx ON public.comment_dm_leads (needs_manual) WHERE needs_manual = true;
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
      message: 'comment_dm_leads follow-up-sequence columns added (user_replied, touch2_*, touch3_*, needs_manual*, dm_link_tag)',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to apply comment-dm-followup-sequence migration',
      details: err.message,
    });
  }
};
