// Vercel Serverless Function: /api/admin-migrate-comment-reply-authenticity-gates
//
// One-shot, idempotent DDL for
// supabase/migrations/20260929b_comment_reply_authenticity_gates.sql.
//
// Same reason this pattern exists at all (see
// api/admin-migrate-zernio-comment-engine.js): PostgREST cannot run DDL, and
// the POSTGRES_* vars are Vercel *Sensitive*, so `.env.local` only ever holds
// the literal "[SENSITIVE]" on a developer machine. The real value is only
// ever readable at runtime inside a deployment, so this file exists to be
// deployed once and POSTed once.
//
// Every statement is CREATE TABLE/INDEX IF NOT EXISTS, so re-running is a
// no-op. Deliberately hardcoded (not a generic "run any SQL" endpoint) so a
// leaked CRON_SECRET cannot turn this into arbitrary DDL execution.
//
// Auth:   Authorization: Bearer ${CRON_SECRET}
// Method: POST

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS public.social_commenter_trust (
     commenter_key            text PRIMARY KEY,
     platform                 text,
     commenter_name           text,
     free_reply_used_at       timestamptz,
     free_reply_id            uuid REFERENCES public.social_comment_replies(id) ON DELETE SET NULL,
     verified                 boolean NOT NULL DEFAULT false,
     verified_at              timestamptz,
     verified_by              text,
     concentration_frozen_at  timestamptz,
     concentration_pct        numeric,
     concentration_sample     integer,
     notes                    text,
     created_at               timestamptz NOT NULL DEFAULT now(),
     updated_at               timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS social_commenter_trust_platform_idx
     ON public.social_commenter_trust (platform)`,

  `CREATE INDEX IF NOT EXISTS social_comment_replies_commenter_platform_id_idx
     ON public.social_comment_replies (commenter_platform_id)`,

  `CREATE INDEX IF NOT EXISTS social_comment_replies_posted_at_idx
     ON public.social_comment_replies (posted_at) WHERE posted_at IS NOT NULL`,

  // Service-role only, same posture as every other ops table added this cycle.
  `ALTER TABLE public.social_commenter_trust ENABLE ROW LEVEL SECURITY`,
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const conn = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!conn || conn === '[SENSITIVE]') {
    return res.status(500).json({
      ok: false,
      error: 'No usable POSTGRES_URL_NON_POOLING/POSTGRES_URL in this environment',
    });
  }

  // pg (>=8.11) lets an sslmode in the connection string win over the ssl
  // option, which resurfaces "self-signed certificate in certificate chain".
  let cleanConn = conn;
  try {
    const u = new URL(conn);
    u.searchParams.delete('sslmode');
    cleanConn = u.toString();
  } catch { /* not URL-parseable: fall back to the raw string */ }

  const client = new Client({ connectionString: cleanConn, ssl: { rejectUnauthorized: false } });
  const applied = [];
  try {
    await client.connect();
    for (const sql of STATEMENTS) {
      await client.query(sql);
      applied.push(sql.trim().split('\n')[0].trim().slice(0, 90));
    }

    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = 'social_commenter_trust'`,
    );
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='social_commenter_trust'
        ORDER BY column_name`,
    );

    return res.status(200).json({
      ok: true,
      statements_applied: applied.length,
      tables_present: tables.rows.map((r) => r.table_name),
      social_commenter_trust_columns: cols.rows.map((r) => r.column_name),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message, applied });
  } finally {
    await client.end().catch(() => {});
  }
};
