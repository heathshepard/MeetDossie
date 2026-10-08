// One-time migration for
// supabase/migrations/20260930d_social_posts_posted_unverified_status.sql —
// see that file for the full incident writeup. Widens social_posts'
// status check constraint to allow 'posted_unverified' through the same
// direct-Postgres connection every admin-migrate-*.js route uses, since
// PostgREST (SUPABASE_URL) cannot run DDL.
//
// Safe to re-run — DROP-then-CREATE constraint is idempotent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-30

const { runAdminSql } = require('./_lib/pg-admin');
const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft', 'approved', 'publishing', 'posted', 'failed', 'pending_video', 'rejected',
    'image_mismatch_hold', 'video_failed', 'parked_no_account', 'posted_unverified'
  ));

COMMENT ON CONSTRAINT social_posts_status_check ON public.social_posts IS
  'posted_unverified added 2026-09-30 — Zernio returned a 2xx with no extractable post identifier. Distinct from posted (verified survival) and failed (Zernio rejected the request). See 20260930d_social_posts_posted_unverified_status.sql.';
`;

// Proves the widened constraint actually accepts 'posted_unverified' by
// attempting a real UPDATE inside a transaction that always rolls back —
// never commits, never leaves a test row behind. If the constraint rejects
// the value the UPDATE throws and the whole transaction aborts naturally.
async function verifyConstraintAcceptsValue() {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('postgres_connection_env_missing');

  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false, require: true } });
  try {
    await client.connect();
    await client.query('BEGIN');
    const picked = await client.query('SELECT id, status FROM public.social_posts LIMIT 1');
    if (picked.rowCount === 0) {
      await client.query('ROLLBACK');
      return { tested: false, reason: 'no rows in social_posts to test against' };
    }
    const targetId = picked.rows[0].id;
    const originalStatus = picked.rows[0].status;
    const updateResult = await client.query(
      "UPDATE public.social_posts SET status = 'posted_unverified' WHERE id = $1 RETURNING id, status",
      [targetId]
    );
    const accepted = updateResult.rowCount === 1 && updateResult.rows[0].status === 'posted_unverified';
    await client.query('ROLLBACK');

    // Re-query post-rollback (separate statement, same connection, new implicit txn)
    // to prove the row reverted and nothing was left behind.
    const reQuery = await client.query('SELECT status FROM public.social_posts WHERE id = $1', [targetId]);
    const cleanedUp = reQuery.rowCount === 1 && reQuery.rows[0].status === originalStatus;

    return { tested: true, accepted, cleanedUp, targetId, originalStatus };
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
      message: "social_posts_status_check now allows 'posted_unverified'",
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: doVerify ? 'Failed to verify posted-unverified-status constraint' : 'Failed to run posted-unverified-status migration',
      details: err.message,
    });
  }
};
