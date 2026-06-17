// Vercel Serverless Function: /api/get-document-upload-url
// Returns a signed Supabase Storage upload URL for a document so the
// browser can PUT the file directly (bypassing Vercel's 4.5MB body limit).
//
// POST /api/get-document-upload-url
// Body: { transactionId, fileName, fileType }
// Authorization: Bearer <supabase user JWT>
// Response: { ok, signedUrl, publicUrl, storagePath }

const {
  sanitizeString,
  ValidationError,
} = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET = 'documents';
const ALLOWED_EXT = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;

function sanitizeFileName(name) {
  const cleaned = sanitizeString(name, { maxLength: 200 }) || '';
  const safe = cleaned
    .replace(/[\/]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._\-\s()]/g, '_')
    .trim();
  return safe.length > 0 ? safe : 'document';
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    // Verify JWT before proceeding
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

    // Request a signed upload URL from Supabase Storage
    const signEndpoint = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;

    const signResp = await fetch(signEndpoint, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });

    if (!signResp.ok) {
      const text = await signResp.text();
      console.error('[get-document-upload-url] Supabase sign error:', signResp.status, text);
      return res.status(502).json({ ok: false, error: `Storage sign failed: ${signResp.status}` });
    }

    const data = await signResp.json();
    let signedURL = data.signedURL;
    if (!signedURL) {
      return res.status(502).json({ ok: false, error: 'No signedURL in Supabase response' });
    }

    // Prefix relative URL with base
    if (signedURL.startsWith('/')) {
      signedURL = `${SUPABASE_URL}/storage/v1${signedURL}`;
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;

    return res.status(200).json({
      ok: true,
      signedUrl: signedURL,
      publicUrl,
      storagePath,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }

    console.error('[get-document-upload-url] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not generate upload URL' });
  }
};
