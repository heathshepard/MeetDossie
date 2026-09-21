// Vercel Serverless Function: /api/transactions
// DELETE /api/transactions?transactionId=X  -> archive a dossier (soft delete)
// Authorization: Bearer <supabase user JWT>
//
// Changed 2026-09-21 (hard-delete sibling audit, priority 1): this used to
// hard-delete the transaction row and cascade-destroy every child row
// (documents + Storage objects, action_items, email_queue, signature_requests,
// amendments, wire_fraud_deliveries, deadline_reminders, transaction_offers)
// — reachable from a "Permanently delete" button on Closed Dossiers, with no
// undo. Heath is a licensed agent with record-retention obligations; that was
// a licence problem, not just a data problem.
//
// Now: sets transactions.archived_at and stops there. Nothing is destroyed.
// Child rows are left exactly as they were — the parent being hidden from the
// pipeline/closed-dossiers views (via archived_at=is.null in the client's
// transactions query) is what hides the file. See
// supabase/migrations/20260921_transactions_and_offers_archive.sql.

const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.meetdossie.com')
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin) || !origin;
}

async function supabaseRest(path, init) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[transactions] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Database not configured.' });
    return;
  }

  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'transactions-delete', 20, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const transactionId = ((req.query && req.query.transactionId) || '').trim();
    if (!transactionId) {
      return res.status(400).json({ ok: false, error: 'transactionId query parameter is required.' });
    }

    const safeUid = encodeURIComponent(userId);
    const safeTx = encodeURIComponent(transactionId);

    // Confirm ownership before touching anything.
    const txResp = await supabaseRest(
      `transactions?select=id&id=eq.${safeTx}&user_id=eq.${safeUid}`,
      { method: 'GET' },
    );
    if (!txResp.ok) {
      const text = await txResp.text().catch(() => '');
      throw new Error(`transaction fetch failed (${txResp.status}): ${text.slice(0, 200)}`);
    }
    const txRows = await txResp.json();
    if (!Array.isArray(txRows) || txRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Dossier not found.' });
    }

    // Archive the transaction. Nothing else is touched — documents,
    // action_items, email_queue, transaction_offers, signature_requests,
    // amendments, wire_fraud_deliveries, and deadline_reminders all stay
    // exactly as they are. The client's transactions query filters
    // archived_at=is.null, so an archived dossier simply stops appearing.
    const archiveResp = await supabaseRest(
      `transactions?id=eq.${safeTx}&user_id=eq.${safeUid}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ archived_at: new Date().toISOString() }),
      },
    );
    if (!archiveResp.ok) {
      const text = await archiveResp.text().catch(() => '');
      // Column not there yet (migration hasn't run) — degrade instead of a
      // bare 500, per the coordinator's sequencing note on this exact bug.
      if (archiveResp.status === 400 && /archived_at/.test(text)) {
        console.error('[transactions] archived_at column missing — run admin-migrate-transactions-archive.');
        return res.status(503).json({ ok: false, error: 'Archiving is not ready yet. Try again shortly.' });
      }
      throw new Error(`transaction archive failed (${archiveResp.status}): ${text.slice(0, 200)}`);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[transactions] archive error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not remove dossier.' });
  }
};
