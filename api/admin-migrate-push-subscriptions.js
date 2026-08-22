// One-time migration: create public.push_subscriptions (Web Push
// subscription storage for the Jarvis PWA) — see
// supabase/migrations/20260822_push_subscriptions.sql for the full design
// commentary.
//
// Safe to re-run — every statement is IF NOT EXISTS / OR REPLACE /
// DROP-then-CREATE. No data is touched.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — the
// pulled value is the literal [SENSITIVE]. Same reason the admin-migrate-*
// siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-08-22 (SV-ENG-JARVIS-WEB-PUSH)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth_key      TEXT NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.push_subscriptions IS
  'Web Push subscriptions for the Jarvis PWA. One row per browser/device. endpoint is the PushSubscription.endpoint URL (unique per device), p256dh/auth_key are the two keys off PushSubscription.toJSON().keys. Sent-to via api/jarvis-push-send.js using the web-push npm package + VAPID_PRIVATE_KEY.';
COMMENT ON COLUMN public.push_subscriptions.endpoint IS
  'PushSubscription.endpoint -- globally unique per browser+device. Natural upsert key.';
COMMENT ON COLUMN public.push_subscriptions.last_used_at IS
  'Updated on every successful push send. Rows whose endpoint the push service reports as gone (404/410) are deleted by api/jarvis-push-send.js rather than left to rot.';

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Authenticated users can view push_subscriptions"
  ON public.push_subscriptions FOR SELECT
  USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can insert push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Authenticated users can insert push_subscriptions"
  ON public.push_subscriptions FOR INSERT
  WITH CHECK ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can update push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Authenticated users can update push_subscriptions"
  ON public.push_subscriptions FOR UPDATE
  USING ((select auth.role()) = 'authenticated');

DROP POLICY IF EXISTS "Authenticated users can delete push_subscriptions" ON public.push_subscriptions;
CREATE POLICY "Authenticated users can delete push_subscriptions"
  ON public.push_subscriptions FOR DELETE
  USING ((select auth.role()) = 'authenticated');
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
      message: 'push_subscriptions table created (or already existed) with authenticated-user RLS',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create push_subscriptions',
      details: err.message,
    });
  }
};
