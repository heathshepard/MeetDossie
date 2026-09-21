// Vercel Serverless Function: /api/wire-fraud-mark-sent
// POST { transaction_id, recipient_role: 'buyer'|'seller' }
// Records that a wire fraud warning was delivered to a party on this deal
// — through any channel (a DocuSeal e-sign, a plain email, in person, a
// phone call) — so the "Wire Fraud Warning not sent" banner reflects
// reality instead of nagging forever with no way to act on it.
//
// 2026-09-21 — TAR/TXR 2517 is buyer AND seller facing (Heath's executed
// copy: "Buyers and Sellers Beware", a [ ] Seller [ ] Buyer checkbox pair).
// recipient_role records which party this delivery covers — the same
// column wire_fraud_deliveries already needed once a seller-side delivery
// became a real, tracked thing rather than an assumption.
//
// Authorization: Bearer <supabase user JWT>

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');

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
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.meetdossie.com')) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin) || !origin;
}

async function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

const VALID_ROLES = new Set(['buyer', 'seller']);

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Service not configured.' });
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    if (!transactionId) throw new ValidationError('transaction_id is required.');
    const recipientRole = sanitizeString(body.recipient_role, { maxLength: 20 });
    if (!VALID_ROLES.has(recipientRole)) throw new ValidationError("recipient_role must be 'buyer' or 'seller'.");

    const safeUid = encodeURIComponent(userId);
    const safeTx = encodeURIComponent(transactionId);

    const txResp = await supa(`transactions?id=eq.${safeTx}&user_id=eq.${safeUid}&select=id,buyer_name,buyer_email,seller_name,seller_email`);
    if (!txResp.ok) throw new Error(`transactions fetch failed (${txResp.status})`);
    const txRows = await txResp.json();
    const tx = Array.isArray(txRows) ? txRows[0] : null;
    if (!tx) return res.status(404).json({ ok: false, error: 'Dossier not found.' });

    const recipientName = recipientRole === 'seller' ? tx.seller_name : tx.buyer_name;
    const recipientEmail = recipientRole === 'seller' ? tx.seller_email : tx.buyer_email;

    const payload = {
      transaction_id: transactionId,
      user_id: userId,
      document_id: null,
      delivered_at: new Date().toISOString(),
      recipient_role: recipientRole,
      // buyer_name/buyer_email are the table's only name/email columns
      // today (see fill-form.js's DocuSeal path, the other writer to this
      // table) — recipient_role is what makes this row honest about who it
      // actually covers when that recipient is the seller.
      buyer_name: recipientName || null,
      buyer_email: recipientEmail || null,
    };

    const insertResp = await supa('wire_fraud_deliveries', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    if (!insertResp.ok) {
      const text = await insertResp.text().catch(() => '');
      throw new Error(`wire_fraud_deliveries insert failed (${insertResp.status}): ${text.slice(0, 300)}`);
    }
    const rows = await insertResp.json();
    return res.status(200).json({ ok: true, delivery: Array.isArray(rows) ? rows[0] : rows });
  } catch (error) {
    if (error instanceof AuthError) return res.status(error.status || 401).json({ ok: false, error: error.message });
    if (error instanceof ValidationError) return res.status(error.status || 400).json({ ok: false, error: error.message });
    console.error('[wire-fraud-mark-sent] error:', error && error.message);
    return res.status(500).json({ ok: false, error: 'Could not record the delivery.' });
  }
};
