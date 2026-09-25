// Vercel Serverless Function: /api/admin-migrate-video-retraction
//
// One-shot, idempotent DDL for supabase/migrations/20260925_video_library_
// retraction.sql — adds the retraction audit columns to video_library.
//
// WHY THIS EXISTS (Atlas 2026-09-25): PostgREST cannot run DDL, and the
// POSTGRES_* credentials are Vercel *Sensitive* vars, so `vercel env pull`
// returns the literal "[SENSITIVE]" and DDL cannot be applied from a
// developer machine at all. It CAN be applied from inside a deployment,
// where the real POSTGRES_URL is injected at runtime. (The older
// api/admin-migrate-buyer2-seller2.js tries `rpc/exec`, a function that does
// not exist in this project — that route is dead; this one uses pg directly.)
//
// Deliberately NOT a generic "run any SQL" endpoint: the statements are
// hardcoded below, so a leaked CRON_SECRET cannot turn this into arbitrary
// DDL execution. Every statement is IF NOT EXISTS, so re-running is a no-op.
//
// Auth:   Authorization: Bearer ${CRON_SECRET}
// Method: POST

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

// Keep in sync with supabase/migrations/20260925_video_library_retraction.sql.
const STATEMENTS = [
  `ALTER TABLE public.video_library
     ADD COLUMN IF NOT EXISTS retracted_at      timestamptz,
     ADD COLUMN IF NOT EXISTS retracted_by      text,
     ADD COLUMN IF NOT EXISTS retraction_reason text,
     ADD COLUMN IF NOT EXISTS retraction_detail jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE INDEX IF NOT EXISTS video_library_retracted_at_idx
     ON public.video_library (retracted_at DESC)
     WHERE retracted_at IS NOT NULL`,
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Prefer the non-pooling URL: DDL over a transaction pooler can fail or
  // land on a connection that never sees the change.
  const conn = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!conn || conn === '[SENSITIVE]') {
    return res.status(500).json({
      ok: false,
      error: 'No usable POSTGRES_URL_NON_POOLING/POSTGRES_URL in this environment',
    });
  }

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  const applied = [];
  try {
    await client.connect();
    for (const sql of STATEMENTS) {
      await client.query(sql);
      applied.push(sql.trim().split('\n')[0].trim());
    }
    // Prove the columns exist rather than trusting that the DDL "succeeded".
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'video_library'
          AND column_name IN ('retracted_at','retracted_by','retraction_reason','retraction_detail')
        ORDER BY column_name`,
    );
    return res.status(200).json({
      ok: true,
      applied,
      columns_present: check.rows.map((r) => r.column_name),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message, applied });
  } finally {
    await client.end().catch(() => {});
  }
};
