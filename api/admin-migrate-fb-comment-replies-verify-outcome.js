// One-time migration: fb_comment_replies verify-outcome columns + status
// CHECK widen -- see
// supabase/migrations/20260917_fb_comment_replies_verify_outcome.sql for the
// full design commentary.
//
// Safe to re-run -- ADD COLUMN IF NOT EXISTS / DROP+ADD CONSTRAINT, no data
// touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell -- the
// pulled value is the literal [SENSITIVE]. Same reason the admin-migrate-*
// siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-17

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.fb_comment_replies
  ADD COLUMN IF NOT EXISTS reply_error TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.fb_comment_replies.reply_error IS
  'Human-readable reason recorded on any non-posted outcome (pre-submit retry, terminal unconfirmed-submit, or terminal blocked). Null once status=posted.';
COMMENT ON COLUMN public.fb_comment_replies.verified_at IS
  'Timestamp positive evidence (the reply located in the re-rendered thread) was captured. Only ever set together with status=posted -- see scripts/_lib/fb-post-verify-outcome.js resolvePostStatus().';

ALTER TABLE public.fb_comment_replies
  DROP CONSTRAINT IF EXISTS fb_comment_replies_status_check;

ALTER TABLE public.fb_comment_replies
  ADD CONSTRAINT fb_comment_replies_status_check
    CHECK (status IN (
      'pending',
      'approved',
      'posted',
      'rejected',
      'failed',
      'blocked'
    ));
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
      message: 'fb_comment_replies.reply_error + verified_at added, status CHECK widened to include failed/blocked',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to apply fb-comment-replies-verify-outcome migration',
      details: err.message,
    });
  }
};
