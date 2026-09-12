'use strict';

// One-time migration: telegram send-retry tracking for group_posts +
// social_posts, plus a shared send-failure log.
//
// ROOT CAUSE (2026-09-12, Carter): a draft whose Telegram approval-card send
// failed or was never attempted was left at status='draft',
// telegram_sent_at=null forever -- nothing in the codebase re-attempted it.
// daily-group5-post-generator.js grew its own retryPendingNotifications()
// for pipeline='daily5' on 2026-09-09, but it's unbounded (retries forever,
// never alerts on terminal failure) and doesn't cover pipeline='listing-groups'
// or social_posts at all. Confirmed 7 real stranded rows: 3 group_posts
// (pipeline='listing-groups', Windcrest/Hill-Country-BST/Buy-Buy-Boerne).
//
// This migration adds the columns + log table that api/cron-retry-unsent-
// approvals.js and the updated pipeline generators use to bound retries at
// 3 attempts and alert Heath by name on final failure instead of going
// silent forever.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-telegram-retry
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-12

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.group_posts
  ADD COLUMN IF NOT EXISTS telegram_send_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS telegram_last_error TEXT,
  ADD COLUMN IF NOT EXISTS telegram_last_attempt_at TIMESTAMPTZ;

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS telegram_send_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS telegram_last_error TEXT,
  ADD COLUMN IF NOT EXISTS telegram_last_attempt_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.telegram_send_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name        TEXT NOT NULL,
  row_id            UUID NOT NULL,
  identifier        TEXT,
  attempt_number    INTEGER NOT NULL,
  ok                BOOLEAN NOT NULL,
  suppressed        BOOLEAN NOT NULL DEFAULT FALSE,
  http_status       INTEGER,
  telegram_response JSONB,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_send_log_row
  ON public.telegram_send_log (table_name, row_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_group_posts_unsent_retry
  ON public.group_posts (created_at)
  WHERE status = 'draft' AND telegram_sent_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_social_posts_unsent_retry
  ON public.social_posts (created_at)
  WHERE status = 'draft' AND telegram_sent_at IS NULL;

COMMENT ON COLUMN public.group_posts.telegram_send_attempts IS
  'Count of Telegram approval-card send attempts for this row. Incremented by api/cron-retry-unsent-approvals.js and the pipeline generators'' own send paths. Capped at 3 -- the 3rd failed attempt fires a named alert to Heath (listing/venue) instead of retrying forever. Added 2026-09-12 after 3 listing-groups drafts (Windcrest, Hill Country BST, Buy Buy Boerne) sat unsent with no retry path at all.';
COMMENT ON COLUMN public.social_posts.telegram_send_attempts IS
  'Same contract as group_posts.telegram_send_attempts -- see that column comment. Added 2026-09-12.';
COMMENT ON TABLE public.telegram_send_log IS
  'Append-only record of every Telegram approval-card send attempt (success or failure) across group_posts and social_posts, so a failure can be diagnosed from what Telegram actually returned instead of guessing. Added 2026-09-12 alongside the bounded-retry columns.';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      migrated: 'group_posts + social_posts telegram_send_attempts/telegram_last_error/telegram_last_attempt_at columns, telegram_send_log table',
    });
  } catch (err) {
    console.error('[admin-migrate-telegram-retry]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
