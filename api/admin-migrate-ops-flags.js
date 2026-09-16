'use strict';

// One-time migration: create public.ops_flags (see
// supabase/migrations/20260916c_ops_flags.sql for full design commentary --
// keep the two in sync).
//
// Safe to re-run -- CREATE TABLE IF NOT EXISTS / ON CONFLICT DO NOTHING.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell -- same
// reason the admin-migrate-* siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-16

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.ops_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

COMMENT ON TABLE public.ops_flags IS
  'Shared on/off flags read by both local scripts (via node scripts/toggle-*.js) and Vercel serverless crons -- the single source of truth so a local-only state file can never diverge from what production reads. Defaults OFF (missing row/table = disabled everywhere, enforced in the reading code as well as the DEFAULT here).';

INSERT INTO public.ops_flags (key, enabled, reason, updated_by)
VALUES ('auto_reply', FALSE, 'initial migration -- ships OFF', 'migration:20260916c_ops_flags')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.ops_flags ENABLE ROW LEVEL SECURITY;
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'ops_flags ready' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate ops_flags', details: err.message });
  }
};
