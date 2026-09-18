'use strict';

// One-time migration: telegram_gate_suppressions -- the queryable record of
// every Telegram send api/_lib/telegram-gate.js has eaten. See
// supabase/migrations/20260918_telegram_gate_suppressions.sql for full
// rationale.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-telegram-gate-suppressions
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-18

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.telegram_gate_suppressions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name     TEXT NOT NULL,
  method       TEXT,
  chat_id      TEXT,
  text_preview TEXT,
  mode         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_gate_suppressions_job_time
  ON public.telegram_gate_suppressions (job_name, created_at DESC);

COMMENT ON TABLE public.telegram_gate_suppressions IS
  'Append-only log of every Telegram send api/_lib/telegram-gate.js ate instead of delivering. Queried by silence-alarm.js. Added 2026-09-18.';

ALTER TABLE public.telegram_gate_suppressions ENABLE ROW LEVEL SECURITY;
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, migrated: 'telegram_gate_suppressions table + RLS' });
  } catch (err) {
    console.error('[admin-migrate-telegram-gate-suppressions]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
