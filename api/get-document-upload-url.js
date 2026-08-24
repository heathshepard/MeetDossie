// Vercel Serverless Function: /api/get-document-upload-url
// Returns a signed Supabase Storage PUT URL for a document so the browser can
// upload directly to Storage, bypassing Vercel's 4.5MB serverless body limit.
//
// Mirrors the proven get-scan-upload-url.js pattern (already live for the
// contract-scan flow). PRE-FIX this endpoint called the wrong Supabase Storage
// API (the download-sign endpoint, /object/sign/..., instead of the
// upload-sign endpoint, /object/upload/sign/...) and was never wired to the
// frontend at all — every document upload went through /api/upload-document
// as a base64 JSON body instead, which hits Vercel's 4.5MB body cap on any
// real (~3.3MB+) PDF and fails with FUNCTION_PAYLOAD_TOO_LARGE (413).
//
// POST /api/get-document-upload-url
// Body: { transactionId, fileName, fileType }
// Authorization: Bearer <supabase user JWT>
// Response: { ok, url, token, storagePath }
// Client then: 1. PUT file bytes to `url` with header `x-signature: token`
//              2. POST /api/insert-document-row with { transactionId, fileName, fileType, storagePath, documentType }

const {
  sanitizeString,
  ValidationError,
} = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET = 'documents';
const ALLOWED_EXT = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
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
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

function sanitizeFileName(name) {
  const cleaned = sanitizeString(name, { maxLength: 200 }) || '';
  const safe = cleaned
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._\-\s()]/g, '_')
    .trim();
  return safe.length > 0 ? safe : 'document';
}

// Create a signed PUT URL (not GET) via Supabase's upload-sign endpoint.
async function supabaseStorageSignedPutUrl(storagePath, expiresInSeconds = 3600) {
  const url = `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Failed to generate PUT URL (${response.status}): ${text.slice(0, 300)}`);
  }
  const json = await response.json().catch(() => null);
  if (!json) {
    throw new Error('No response body from Supabase');
  }
  const signedPath = json.url || json.signedURL || json.path;
  if (!signedPath) {
    throw new Error(`No signed URL in response. Got: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const path = signedPath.startsWith('/') ? signedPath : `/${signedPath}`;
  const fullUrl = `${SUPABASE_URL}/storage/v1${path}`;
  return { fullUrl, token: json.token };
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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[get-document-upload-url] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Storage is not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'get-document-upload-url', 50, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const body = req.body || {};
    const transactionIdRaw = sanitizeString(body.transactionId, { maxLength: 200 });
    const fileNameRaw = body.fileName;
    const fileType = sanitizeString(body.fileType, { maxLength: 200 }) || '';

    if (!transactionIdRaw) {
      throw new ValidationError('transactionId is required');
    }
    if (!fileNameRaw || typeof fileNameRaw !== 'string') {
      throw new ValidationError('fileName is required');
    }

    const fileName = sanitizeFileName(fileNameRaw);
    if (!ALLOWED_EXT.test(fileName)) {
      throw new ValidationError('Unsupported file type. Allowed: pdf, doc, docx, jpg, png');
    }

    // Build storage path following the same pattern as upload-document.js
    const storagePath = `${userId}/${transactionIdRaw}/${Date.now()}-${fileName}`;

    const { fullUrl, token } = await supabaseStorageSignedPutUrl(storagePath, 3600);

    return res.status(200).json({
      ok: true,
      url: fullUrl,
      token,
      storagePath,
      fileType: fileType || 'application/octet-stream',
    });
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

    console.error('[get-document-upload-url] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not generate upload URL' });
  }
};
