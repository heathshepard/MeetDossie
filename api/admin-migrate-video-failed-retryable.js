// One-time migration for
// supabase/migrations/20261003_video_library_failed_retryable.sql — see
// that file for the full incident writeup. Adds failure_reason/failed_at/
// retry_count columns and widens video_library's status CHECK constraint
// to allow 'failed_retryable', through the same direct-Postgres connection
// every admin-migrate-*.js route uses, since PostgREST (SUPABASE_URL)
// cannot run DDL.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS / DROP-then-CREATE constraint
// are both idempotent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-10-03

const { runAdminSql } = require('./_lib/pg-admin');
const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.video_library
  ADD COLUMN IF NOT EXISTS failure_reason text,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.video_library DROP CONSTRAINT IF EXISTS video_library_status_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_status_check
  CHECK (status IN (
    'ready', 'pending_approval', 'approved', 'pending_heath_review', 'heath_approved',
    'posting', 'posted', 'posted_partial', 'failed', 'failed_retryable', 'rejected', 'quality_hold'
  ));

COMMENT ON CONSTRAINT video_library_status_check ON public.video_library IS
  'failed_retryable added 2026-10-03 — a publish-time failure caused purely by the row''s own caption (empty / internal-note / premature Rust store CTA), auto-retried by the silence alarm up to MAX_VIDEO_RETRIES times once the caption looks valid again. Distinct from failed (terminal — a real Zernio rejection or any other hard failure; never auto-retried). See api/_lib/video-retry.js.';
`;

// Proves the widened constraint actually accepts 'failed_retryable', and
// that the new columns round-trip, via a real UPDATE inside a transaction
// that always rolls back — never commits, never leaves a test row behind.
// Same technique as admin-migrate-video-posted-partial-status.js's
// verifyConstraintAcceptsValue().
async function verifyConstraintAcceptsValue() {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('postgres_connection_env_missing');

  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false, require: true } });
  try {
    await client.connect();
    await client.query('BEGIN');
    const picked = await client.query("SELECT id, status FROM public.video_library WHERE status = 'heath_approved' LIMIT 1");
    if (picked.rowCount === 0) {
      await client.query('ROLLBACK');
      return { tested: false, reason: "no status='heath_approved' rows in video_library to test against" };
    }
    const targetId = picked.rows[0].id;
    const originalStatus = picked.rows[0].status;
    const updateResult = await client.query(
      "UPDATE public.video_library SET status = 'failed_retryable', failure_reason = 'invalid_caption', failed_at = now(), retry_count = 1 WHERE id = $1 RETURNING id, status, failure_reason, failed_at, retry_count",
      [targetId]
    );
    const accepted = updateResult.rowCount === 1 && updateResult.rows[0].status === 'failed_retryable'
      && updateResult.rows[0].failure_reason === 'invalid_caption'
      && updateResult.rows[0].retry_count === 1;

    // Negative case, same transaction: prove the constraint still REJECTS a
    // bogus value.
    let rejectedBogus = false;
    let rejectError = null;
    try {
      await client.query(
        "UPDATE public.video_library SET status = 'not_a_real_status_xyz' WHERE id = $1",
        [targetId]
      );
    } catch (err) {
      rejectedBogus = true;
      rejectError = err.message;
    }

    await client.query('ROLLBACK');

    const reQuery = await client.query('SELECT status FROM public.video_library WHERE id = $1', [targetId]);
    const cleanedUp = reQuery.rowCount === 1 && reQuery.rows[0].status === originalStatus;

    return { tested: true, accepted, rejectedBogus, rejectError, cleanedUp, targetId, originalStatus };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* no-op */ }
    throw err;
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsFlag;
  }
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const doVerify = req.query && (req.query.verify === '1' || req.query.verify === 'true');

  try {
    if (doVerify) {
      const verification = await verifyConstraintAcceptsValue();
      return res.status(200).json({ ok: true, verification });
    }
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: "video_library gained failure_reason/failed_at/retry_count, and status_check now allows 'failed_retryable'",
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: doVerify ? 'Failed to verify failed-retryable migration' : 'Failed to run failed-retryable migration',
      details: err.message,
    });
  }
};
