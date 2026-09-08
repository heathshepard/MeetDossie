'use strict';

// One-time migration: add the reply-approval columns to
// public.tc_discovery_responses. Full design commentary in
// supabase/migrations/20260908_tc_reply_approval.sql (keep the two in sync).
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS; the
// backfill only touches rows still in the default 'new' state.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — same
// reason the admin-migrate-* siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-08 (TC discovery comment-reply approval loop)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.tc_discovery_responses
  ADD COLUMN IF NOT EXISTS reply_status TEXT NOT NULL DEFAULT 'new'
    CHECK (reply_status IN ('new','flagged','notified','approved','skipped','posting','posted','post_failed')),
  ADD COLUMN IF NOT EXISTS reply_draft TEXT,
  ADD COLUMN IF NOT EXISTS reply_final TEXT,
  ADD COLUMN IF NOT EXISTS reply_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_telegram_message_id TEXT,
  ADD COLUMN IF NOT EXISTS reply_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_error TEXT;

COMMENT ON COLUMN public.tc_discovery_responses.reply_status IS
  'Reply-approval lifecycle: new -> (flagged|notified) -> (approved|skipped) -> posting -> (posted|post_failed). Nothing posts without an explicit Heath approval; post_failed is terminal (never auto-retried).';
COMMENT ON COLUMN public.tc_discovery_responses.reply_draft IS
  'AI-drafted reply in Heath''s voice (no Dossie mention, no pitch, no link). Display-only until approved.';
COMMENT ON COLUMN public.tc_discovery_responses.reply_final IS
  'The text that actually posts: the draft on plain Approve, or Heath''s edited text from the Telegram reply flow.';

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_reply_status
  ON public.tc_discovery_responses (reply_status);

UPDATE public.tc_discovery_responses
  SET reply_status = 'skipped'
  WHERE is_own_comment = TRUE AND reply_status = 'new';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'tc_discovery_responses reply-approval columns ready' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate tc_discovery_responses', details: err.message });
  }
};
