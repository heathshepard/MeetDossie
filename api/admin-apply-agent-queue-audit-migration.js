'use strict';

// api/admin-apply-agent-queue-audit-migration.js
// =============================================================================
// ONE-TIME schema-apply endpoint for supabase/migrations/20260806_agent_queue_pending_audit.sql.
//
// WHY THIS EXISTS
//   Local dev has no working direct Postgres connection (POSTGRES_URL is a
//   Vercel "Sensitive" var — `vercel env pull` returns the literal string
//   "[SENSITIVE]" locally, not a usable connection string). At runtime on
//   Vercel, process.env.POSTGRES_URL_NON_POOLING IS the real value. This
//   endpoint runs the exact, hardcoded DDL from the migration file (no
//   request-body SQL — nothing user-suppliable, no injection surface) using
//   that runtime connection, then reports the resulting constraint so the
//   caller can confirm it landed.
//
// Idempotent: safe to call twice — it locates the existing status CHECK
// constraint by definition (not by a guessed name) and replaces it.
//
// Auth: Bearer ${CRON_SECRET}. POST only.
//
// DELETE THIS FILE after the migration has been confirmed applied — it's a
// single-purpose tool, not a general SQL-exec endpoint, and shouldn't linger.
//
// Owner: Atlas, 2026-08-06.

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const rawConn = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!rawConn) {
    return res.status(500).json({ ok: false, error: 'missing_postgres_url' });
  }
  // Strip any sslmode= query param — when present, pg negotiates SSL from the
  // connection string itself and ignores the `ssl` config object below,
  // which defeats rejectUnauthorized:false and fails on Supabase's
  // self-signed chain.
  const conn = rawConn.replace(/([?&])sslmode=[^&]*&?/i, '$1').replace(/[?&]$/, '');

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();

    await client.query(`
      DO $$
      DECLARE
        cname text;
      BEGIN
        SELECT conname INTO cname
        FROM pg_constraint
        WHERE conrelid = 'agent_queue'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%pending%in_progress%';

        IF cname IS NOT NULL THEN
          EXECUTE format('ALTER TABLE agent_queue DROP CONSTRAINT %I', cname);
        END IF;

        ALTER TABLE agent_queue
          ADD CONSTRAINT agent_queue_status_check
          CHECK (status IN (
            'pending', 'in_progress', 'pending_audit',
            'blocked', 'completed', 'cancelled'
          ));
      END $$;
    `);

    const verify = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = 'agent_queue'::regclass AND contype = 'c'
    `);

    await client.end();

    return res.status(200).json({ ok: true, constraints: verify.rows });
  } catch (err) {
    try { await client.end(); } catch (_) { /* ignore */ }
    return res.status(500).json({ ok: false, error: err.message });
  }
};
