// Vercel Serverless Function: /api/documents
// GET    /api/documents?transactionId=X  -> list documents (with fresh signed URLs)
// DELETE /api/documents?documentId=Y     -> delete document row + storage object
// Authorization: Bearer <supabase user JWT>

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';
const SIGNED_URL_TTL_SECONDS = 3600;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
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

async function signUrl(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => null);
  if (!json || !json.signedURL) return null;
  const path = json.signedURL.startsWith('/') ? json.signedURL : `/${json.signedURL}`;
  return `${SUPABASE_URL}/storage/v1${path}`;
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

function shapeDocumentRow(row, signedUrl) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    fileName: row.file_name,
    fileType: row.file_type,
    documentType: row.document_type || null,
    storagePath: row.storage_path,
    fileSize: row.file_size || null,
    createdAt: row.created_at,
    signedUrl: signedUrl || null,
  };
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[documents] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Document storage is not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'documents', 120, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    if (req.method === 'GET') {
      const transactionId = sanitizeString(
        (req.query && req.query.transactionId) || '',
        { maxLength: 200 },
      );
      if (!transactionId) {
        throw new ValidationError('transactionId query parameter is required.');
      }

      const safeUid = encodeURIComponent(userId);
      const safeTx = encodeURIComponent(transactionId);
      const listResp = await supabaseRest(
        `documents?select=*&user_id=eq.${safeUid}&transaction_id=eq.${safeTx}&order=created_at.desc`,
        { method: 'GET' },
      );
      if (!listResp.ok) {
        const text = await listResp.text().catch(() => '');
        throw new Error(`documents list failed (${listResp.status}): ${text.slice(0, 200)}`);
      }
      const rows = await listResp.json();
      const items = Array.isArray(rows) ? rows : [];
      const documents = await Promise.all(
        items.map(async (row) => {
          const signed = await signUrl(row.storage_path);
          return shapeDocumentRow(row, signed);
        }),
      );
      return res.status(200).json({ ok: true, documents });
    }

    if (req.method === 'DELETE') {
      const documentId = sanitizeString(
        (req.query && req.query.documentId) || '',
        { maxLength: 200 },
      );
      if (!documentId) {
        throw new ValidationError('documentId query parameter is required.');
      }

      const safeUid = encodeURIComponent(userId);
      const safeId = encodeURIComponent(documentId);
      // Confirm ownership: only fetch the row if user_id matches.
      const fetchResp = await supabaseRest(
        `documents?select=*&id=eq.${safeId}&user_id=eq.${safeUid}`,
        { method: 'GET' },
      );
      if (!fetchResp.ok) {
        const text = await fetchResp.text().catch(() => '');
        throw new Error(`documents fetch failed (${fetchResp.status}): ${text.slice(0, 200)}`);
      }
      const rows = await fetchResp.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Document not found.' });
      }
      const row = rows[0];

      // Delete storage first, then row. If storage delete fails, still try
      // to remove the DB row so the UI list doesn't show a ghost.
      await removeStorageObject(row.storage_path);

      const delResp = await supabaseRest(
        `documents?id=eq.${safeId}&user_id=eq.${safeUid}`,
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
      );
      if (!delResp.ok) {
        const text = await delResp.text().catch(() => '');
        throw new Error(`documents delete failed (${delResp.status}): ${text.slice(0, 200)}`);
      }

      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[documents] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not load documents.' });
  }
};
