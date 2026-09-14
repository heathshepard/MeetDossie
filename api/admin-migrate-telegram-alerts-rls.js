'use strict';

// One-time migration: enable RLS on telegram_send_log, weekly_digest_surfaces,
// and alert_state. All three shipped with RLS disabled -- anon key had full
// SELECT/INSERT/UPDATE/DELETE via Supabase's default public-schema grants,
// confirmed live via a real anon-key GET (returned rows) and a real
// anon-key POST+DELETE against alert_state (both succeeded).
// DDL isn't reachable through PostgREST -- runs directly against Postgres
// via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING), same pattern as
// api/admin-migrate-listing-marketing-rls.js.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-telegram-alerts-rls
//
// Mirrors supabase/migrations/20260914_telegram_alerts_rls.sql -- see that
// file for the full audit of every reader/writer (all service-role, none
// use the anon key, so RLS-enable-with-no-policies is correct and safe).
// Safe to re-run -- ENABLE ROW LEVEL SECURITY is idempotent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-14

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.telegram_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_digest_surfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_state ENABLE ROW LEVEL SECURITY;
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, migrated: 'RLS enabled on telegram_send_log + weekly_digest_surfaces + alert_state, no policies (service-role-only access)' });
  } catch (err) {
    console.error('[admin-migrate-telegram-alerts-rls]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
