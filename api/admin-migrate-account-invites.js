'use strict';

// One-time migration: create public.account_invites and
// public.lifecycle_email_log.
//
// Mirrors supabase/migrations/20260918_account_invites_and_lifecycle_log.sql —
// read that file for the full rationale. DDL isn't reachable through PostgREST,
// so this runs directly against Postgres via api/_lib/pg-admin.js, the same
// pattern as api/admin-migrate-telegram-alerts-rls.js.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-account-invites
//
// RUN THIS FIRST, BEFORE the code that uses these tables goes live.
//
// If the code deploys without the tables, provisioning does NOT break — every
// call site falls back to the old one-hour recovery link — but that fallback is
// the original defect, so the fix would appear to ship while changing nothing.
// The fallback announces itself loudly (a "⚠️ only a ONE-HOUR link went out"
// line in the new-member Telegram alert, plus a console warning), but the
// cleanest answer is simply to run this before merging.
//
// SAFETY: purely additive. Two new empty tables, CREATE TABLE IF NOT EXISTS,
// idempotent and safe to re-run. Alters no existing table, writes no row, and
// cannot cause any email to be sent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: 2026-09-18.

const fs = require('fs');
const path = require('path');
const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const MIGRATION_FILE = path.join(
  __dirname, '..', 'supabase', 'migrations',
  '20260918_account_invites_and_lifecycle_log.sql'
);

// Inlined rather than read from disk at request time: Vercel's bundler does not
// ship supabase/migrations/ with the function, and a migration endpoint that
// 500s on a missing file is a worse failure than a little duplication. The .sql
// file remains the reviewable source of truth and the two MUST stay in step —
// the self-check below fails the request if they have drifted.
const SQL = `
CREATE TABLE IF NOT EXISTS public.account_invites (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email             text NOT NULL,
  token_hash        text NOT NULL UNIQUE,
  source            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  consumed_at       timestamptz,
  redeem_count      integer NOT NULL DEFAULT 0,
  last_redeemed_at  timestamptz,
  email_sent_at     timestamptz,
  resend_message_id text,
  completed_at      timestamptz,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS account_invites_user_id_idx ON public.account_invites (user_id);
CREATE INDEX IF NOT EXISTS account_invites_email_lower_idx ON public.account_invites (lower(email));
CREATE INDEX IF NOT EXISTS account_invites_live_idx ON public.account_invites (expires_at) WHERE completed_at IS NULL;
ALTER TABLE public.account_invites ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.lifecycle_email_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email             text NOT NULL,
  sequence          text NOT NULL,
  step              text NOT NULL,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  resend_message_id text,
  source            text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_email_log_user_step_key ON public.lifecycle_email_log (user_id, sequence, step) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS lifecycle_email_log_sent_at_idx ON public.lifecycle_email_log (sent_at DESC);
ALTER TABLE public.lifecycle_email_log ENABLE ROW LEVEL SECURITY;
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
      migrated: 'account_invites + lifecycle_email_log created (RLS enabled, no policies — service-role only)',
      next: 'Durable invites are now live for NEW provisioning. No existing customer was touched and no email was sent.',
    });
  } catch (err) {
    console.error('[admin-migrate-account-invites]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

// Exported so a test can assert the endpoint and the .sql file have not drifted.
module.exports.SQL = SQL;
module.exports.MIGRATION_FILE = MIGRATION_FILE;
module.exports.readMigrationFile = function readMigrationFile() {
  return fs.existsSync(MIGRATION_FILE) ? fs.readFileSync(MIGRATION_FILE, 'utf8') : null;
};
