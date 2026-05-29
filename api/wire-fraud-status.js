// Vercel Serverless Function: /api/wire-fraud-status
// GET ?transaction_id=<uuid>
// Returns the wire fraud delivery status for a given transaction.
//
// Response:
//   { ok: true, status: 'none' | 'sent' | 'acknowledged', delivery: {...} | null }
//
// Authorization: Bearer <supabase user JWT>

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  let allowOrigin = null;
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

function supa(path, opts) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...((opts && opts.headers) || {}),
    },
  });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    const transactionId = sanitizeString(
      (req.query && req.query.transaction_id) || '',
      { maxLength: 200 }
    );
    if (!transactionId) {
      throw new ValidationError('transaction_id query param is required.');
    }

    // Verify user owns the transaction
    const txRes = await supa(
      'transactions?id=eq.' + encodeURIComponent(transactionId) +
      '&user_id=eq.' + encodeURIComponent(userId) +
      '&select=id&limit=1'
    );
    if (!txRes.ok) {
      throw new Error('transactions fetch failed (' + txRes.status + ')');
    }
    const txRows = await txRes.json().catch(() => []);
    if (!Array.isArray(txRows) || txRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }

    // Fetch most recent wire fraud delivery for this transaction
    const wfdRes = await supa(
      'wire_fraud_deliveries?transaction_id=eq.' + encodeURIComponent(transactionId) +
      '&order=created_at.desc&limit=1' +
      '&select=id,delivered_at,acknowledged_at,buyer_name,buyer_email,document_id'
    );
    if (!wfdRes.ok) {
      throw new Error('wire_fraud_deliveries fetch failed (' + wfdRes.status + ')');
    }
    const wfdRows = await wfdRes.json().catch(() => []);
    const delivery = Array.isArray(wfdRows) && wfdRows.length > 0 ? wfdRows[0] : null;

    let status = 'none';
    if (delivery) {
      status = delivery.acknowledged_at ? 'acknowledged' : 'sent';
    }

    return res.status(200).json({ ok: true, status, delivery });

  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    if (err instanceof ValidationError) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    console.error('[wire-fraud-status] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Could not fetch wire fraud status.' });
  }
};
