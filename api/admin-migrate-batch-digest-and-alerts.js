'use strict';

// One-time migration: create weekly_digest_surfaces + alert_state tables.
// Mirrors supabase/migrations/20260912_batch_digest_and_alerts.sql — see
// that file for full column comments. DDL isn't reachable through
// PostgREST, so this runs directly against Postgres via api/_lib/pg-admin.js
// (same pattern as api/admin-migrate-group-posts-auto-post-at.js).
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-batch-digest-and-alerts
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-12

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.weekly_digest_surfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL,
  message_id bigint,
  surfaced_at timestamptz NOT NULL DEFAULT now(),
  week_start date NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved_all', 'expired')),
  approved_all_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weekly_digest_surfaces_chat_recent
  ON public.weekly_digest_surfaces (chat_id, surfaced_at DESC);

COMMENT ON TABLE public.weekly_digest_surfaces IS
  'One row per weekly batch-approval digest sent to Heath. items = numbered list mapping position -> {table: social_posts|group_posts, id, platform/group_name, day}. "Approve all" and per-post text commands (approve/reject/edit post N) resolve against the most recent open row for the chat.';

CREATE TABLE IF NOT EXISTS public.alert_state (
  key text PRIMARY KEY,
  last_fired_at timestamptz,
  last_reason text,
  metadata jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.alert_state IS
  'Generic per-condition dedupe. key = a stable string identifying the alert condition (e.g. "silence:instagram:dossie", "approvals_stale", "backlog:tiktok:video_failed"). A cron alerts only if last_fired_at is not already today (America/Chicago) for that key.';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, migrated: 'weekly_digest_surfaces + alert_state tables' });
  } catch (err) {
    console.error('[admin-migrate-batch-digest-and-alerts]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
