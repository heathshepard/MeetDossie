-- "Reply Monitoring" paid add-on entitlement flag ($10/mo, see
-- docs/PRICING-HISTORY.md and the Settings > Add-ons card in Dossie's UI,
-- id="reply-monitoring", currently a disabled "Coming Soon" placeholder).
--
-- Backs api/cron-email-to-dossier.js's entitlement gate: only accounts with
-- this flag true get inbound emails matched + summarized + filed into their
-- dossiers. Added 2026-08-12 per Heath's instruction (via Cole) that this
-- must ship gated, not free/built-in for every subscriber.
--
-- NOT YET APPLIED to the live DB as of 2026-08-12 -- this agent session had
-- no DB-admin/DDL execution path available (no psql, no exec_sql RPC, no
-- Supabase management token in .env.local). cron-email-to-dossier.js reads
-- subscriptions.metadata->>'reply_monitoring_enabled' in the meantime (that
-- column already exists, no DDL needed, writable via plain REST). Once this
-- migration is actually run, switch the cron's isReplyMonitoringEnabled() to
-- read this column instead and backfill it from any metadata flags already
-- set.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reply_monitoring_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN subscriptions.reply_monitoring_enabled IS
  'Reply Monitoring add-on ($10/mo) entitlement. Gates api/cron-email-to-dossier.js. Default false -- opt-in / admin-set until self-serve purchase flow exists.';
