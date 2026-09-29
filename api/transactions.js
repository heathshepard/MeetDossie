// Vercel Serverless Function: /api/transactions
// DELETE /api/transactions?transactionId=X  -> hard-delete a dossier and all its child rows
// Authorization: Bearer <supabase user JWT>
//
// Deletion order (avoids FK violations):
//   1. Document storage objects (bucket: documents)
//   2. documents rows
//   3. action_items rows
//   4. email_queue rows  (users only have SELECT via RLS — must use service role)
//   5. transactions row  (CASCADE handles: signature_requests, amendments,
//                          wire_fraud_deliveries, deadline_reminders, transaction_offers)

const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

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

async function removeStorageObject(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return response.ok || response.status === 404;
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

    // Step 1: fetch document rows so we can remove storage objects.
    const docsResp = await supabaseRest(
      `documents?select=id,storage_path&transaction_id=eq.${safeTx}&user_id=eq.${safeUid}`,
      { method: 'GET' },
    );
    const docRows = docsResp.ok ? (await docsResp.json().catch(() => [])) : [];
    const docs = Array.isArray(docRows) ? docRows : [];

    // Step 2: delete storage objects (best-effort — don't abort if a few fail).
    await Promise.all(
      docs
        .filter((d) => d.storage_path)
        .map((d) => removeStorageObject(d.storage_path)),
    );

    // Step 3: delete document rows.
    await supabaseRest(
      `documents?transaction_id=eq.${safeTx}&user_id=eq.${safeUid}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    );

    // Step 4: delete action_items rows.
    await supabaseRest(
      `action_items?transaction_id=eq.${safeTx}&user_id=eq.${safeUid}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    );

    // Step 5: delete email_queue rows (service role needed — users lack DELETE RLS).
    await supabaseRest(
      `email_queue?transaction_id=eq.${safeTx}&user_id=eq.${safeUid}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    );

    // Step 6: delete the transaction row. CASCADE removes:
    //   signature_requests, amendments, wire_fraud_deliveries,
    //   deadline_reminders, transaction_offers.
    const delResp = await supabaseRest(
      `transactions?id=eq.${safeTx}&user_id=eq.${safeUid}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    );
    if (!delResp.ok) {
      const text = await delResp.text().catch(() => '');
      throw new Error(`transaction delete failed (${delResp.status}): ${text.slice(0, 200)}`);
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
    console.error('[transactions] delete error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not delete dossier.' });
  }
};
