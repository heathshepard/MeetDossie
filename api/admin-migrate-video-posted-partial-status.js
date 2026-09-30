// One-time migration for
// supabase/migrations/20260930e_video_library_posted_partial_status.sql —
// see that file for the full incident writeup. Adds a real CHECK
// constraint to video_library.status (there was none before this) that
// allows 'posted_partial' through the same direct-Postgres connection
// every admin-migrate-*.js route uses, since PostgREST (SUPABASE_URL)
// cannot run DDL.
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
ALTER TABLE public.video_library DROP CONSTRAINT IF EXISTS video_library_status_check;

ALTER TABLE public.video_library
  ADD CONSTRAINT video_library_status_check
  CHECK (status IN (
    'ready', 'pending_approval', 'approved', 'pending_heath_review', 'heath_approved',
    'posting', 'posted', 'posted_partial', 'failed', 'rejected', 'quality_hold'
  ));

COMMENT ON CONSTRAINT video_library_status_check ON public.video_library IS
  'posted_partial added 2026-09-30 — one or more originally-targeted platforms were gated out (daily cap / inactive schedule / no schedule row) before ever reaching Zernio. Distinct from posted (every targeted platform was at least attempted) and failed (a platform that WAS attempted got a hard Zernio rejection). See 20260930e_video_library_posted_partial_status.sql and api/_lib/video-delivery-verify.js buildSkipEntry().';
`;

// Proves the widened constraint actually accepts 'posted_partial' by
// attempting a real UPDATE inside a transaction that always rolls back —
// never commits, never leaves a test row behind. If the constraint rejects
// the value the UPDATE throws and the whole transaction aborts naturally.
// Same technique as admin-migrate-posted-unverified-status.js's
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
    const picked = await client.query("SELECT id, status FROM public.video_library WHERE status = 'posted' LIMIT 1");
    if (picked.rowCount === 0) {
      await client.query('ROLLBACK');
      return { tested: false, reason: "no status='posted' rows in video_library to test against" };
    }
    const targetId = picked.rows[0].id;
    const originalStatus = picked.rows[0].status;
    const updateResult = await client.query(
      "UPDATE public.video_library SET status = 'posted_partial' WHERE id = $1 RETURNING id, status",
      [targetId]
    );
    const accepted = updateResult.rowCount === 1 && updateResult.rows[0].status === 'posted_partial';

    // Negative case, same transaction: prove the constraint still REJECTS a
    // bogus value — otherwise this "verification" would just prove the
    // column accepts anything, not that the CHECK is real and scoped.
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

    // Re-query post-rollback (separate statement, same connection, new implicit txn)
    // to prove the row reverted and nothing was left behind.
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
      message: "video_library_status_check now exists and allows 'posted_partial'",
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: doVerify ? 'Failed to verify posted-partial-status constraint' : 'Failed to run posted-partial-status migration',
      details: err.message,
    });
  }
};
