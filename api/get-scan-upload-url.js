// Vercel Serverless Function: /api/get-scan-upload-url
// Returns a signed PUT URL for uploading a PDF to Supabase Storage for scanning.
// This is used by handleScanContract to bypass Vercel's 4.5MB body limit.
//
// POST { fileName }
// Authorization: Bearer <supabase user JWT>
//
// Returns: { ok: true, uploadUrl: "...", storagePath: "..." }
// Client then: 1. PUT file to uploadUrl
//              2. POST /api/scan-contract with { storagePath }

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { checkRateLimit, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

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

// Create a signed PUT URL (not GET). Client will use this to upload the file.
// Returns the full URL.
async function supabaseStorageSignedPutUrl(storagePath, expiresInSeconds = 3600) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/put/${BUCKET}/${storagePath}`;
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
  if (!json || !json.signedURL) {
    throw new Error('No signed URL in response');
  }
  // Storage returns a relative URL like "/object/sign/put/documents/...?token=..."
  const path = json.signedURL.startsWith('/') ? json.signedURL : `/${json.signedURL}`;
  return `${SUPABASE_URL}/storage/v1${path}`;
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
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[get-scan-upload-url] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Storage is not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'get-scan-upload-url', 50, 60 * 60 * 1000);

    let userId;
    try {
      const authResult = await verifySupabaseToken(req);
      userId = authResult.userId;
    } catch (authErr) {
      return res.status(authErr.status || 401).json({ ok: false, error: authErr.message });
    }

    const body = req.body || {};
    const fileNameRaw = body.fileName;

    if (!fileNameRaw || typeof fileNameRaw !== 'string') {
      throw new ValidationError('fileName (string) is required in body.');
    }

    const fileName = sanitizeFileName(fileNameRaw);
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      throw new ValidationError('Only PDF files are supported for scanning.');
    }

    // Pre-deal scans: userId/temp-scans/[timestamp]-[filename]
    const storagePath = `${userId}/temp-scans/${Date.now()}-${fileName}`;

    const uploadUrl = await supabaseStorageSignedPutUrl(storagePath, 3600);

    return res.status(200).json({
      ok: true,
      uploadUrl,
      storagePath,
      expiresIn: 3600,
    });
  } catch (error) {
    console.error('[get-scan-upload-url] error:', error && error.message);

    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }

    const status = (error && Number.isInteger(error.status)) ? error.status : 500;
    const message = status >= 500 ? 'Failed to generate upload URL.' : error?.message || 'Bad request.';
    return res.status(status).json({ ok: false, error: message });
  }
};
