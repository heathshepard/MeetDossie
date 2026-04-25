// Vercel Serverless Function: /api/upload-document
// Uploads a file (base64 in the body) to Supabase Storage at
// `${userId}/${transactionId}/${ts}-${fileName}` and writes a row to the
// `documents` table. Returns the document row + a 1-hour signed URL.
//
// POST { transactionId, fileName, fileType, fileBase64, documentType? }
// Authorization: Bearer <supabase user JWT>

const {
  sanitizeString,
  ValidationError,
} = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKET = 'documents';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);
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
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) {
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
  // Strip any path separators, control chars, and reduce repeated dots.
  const safe = cleaned
    .replace(/[\\/]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._\-\s()]/g, '_')
    .trim();
  return safe.length > 0 ? safe : 'document';
}

async function supabaseStorageUpload(storagePath, buffer, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Storage upload failed (${response.status}): ${text.slice(0, 300)}`);
  }
}

async function supabaseStorageSignedUrl(storagePath, expiresInSeconds = 3600) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) return null;
  const json = await response.json().catch(() => null);
  if (!json || !json.signedURL) return null;
  // Storage returns a relative URL like "/object/sign/documents/...?token=..."
  const path = json.signedURL.startsWith('/') ? json.signedURL : `/${json.signedURL}`;
  return `${SUPABASE_URL}/storage/v1${path}`;
}

async function supabaseInsertDocumentRow(row) {
  const url = `${SUPABASE_URL}/rest/v1/documents`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`documents insert failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const inserted = await response.json();
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

async function supabaseStorageRemove(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  }).catch(() => {});
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
    console.error('[upload-document] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Document storage is not configured.' });
    return;
  }

  let storagePathForCleanup = null;

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'upload-document', 20, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const body = req.body || {};
    const transactionIdRaw = sanitizeString(body.transactionId, { maxLength: 200 });
    const fileNameRaw = body.fileName;
    const fileType = sanitizeString(body.fileType, { maxLength: 200 }) || '';
    const documentType = sanitizeString(body.documentType, { maxLength: 100 });
    const fileBase64 = body.fileBase64;

    if (!transactionIdRaw) {
      throw new ValidationError('transactionId is required.');
    }
    if (!fileNameRaw || typeof fileNameRaw !== 'string') {
      throw new ValidationError('fileName is required.');
    }
    if (!fileBase64 || typeof fileBase64 !== 'string') {
      throw new ValidationError('fileBase64 is required.');
    }

    const fileName = sanitizeFileName(fileNameRaw);
    if (!ALLOWED_EXT.test(fileName)) {
      throw new ValidationError('Unsupported file type. Allowed: pdf, doc, docx, jpg, png.');
    }
    if (fileType && !ALLOWED_MIME.has(fileType)) {
      // Don't hard-fail on mismatched mime if extension is OK — browsers vary.
      console.warn('[upload-document] Unrecognized mime type:', fileType);
    }

    const cleaned = fileBase64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
      throw new ValidationError('fileBase64 is not valid base64.');
    }
    const approxBytes = Math.floor((cleaned.length * 3) / 4);
    if (approxBytes > MAX_FILE_BYTES) {
      throw new ValidationError(`File is too large (~${approxBytes} bytes). Max is ${MAX_FILE_BYTES} bytes (10 MB).`, 413);
    }

    let buffer;
    try {
      buffer = Buffer.from(cleaned, 'base64');
    } catch (e) {
      throw new ValidationError('fileBase64 could not be decoded.');
    }
    if (buffer.length === 0) {
      throw new ValidationError('Decoded file is empty.');
    }
    if (buffer.length > MAX_FILE_BYTES) {
      throw new ValidationError(`File is too large (${buffer.length} bytes). Max is ${MAX_FILE_BYTES} bytes (10 MB).`, 413);
    }

    const storagePath = `${userId}/${transactionIdRaw}/${Date.now()}-${fileName}`;
    storagePathForCleanup = storagePath;

    await supabaseStorageUpload(storagePath, buffer, fileType || 'application/octet-stream');

    const row = await supabaseInsertDocumentRow({
      transaction_id: transactionIdRaw,
      user_id: userId,
      file_name: fileName,
      file_type: fileType || 'application/octet-stream',
      document_type: documentType || null,
      storage_path: storagePath,
      file_size: buffer.length,
    });

    const signedUrl = await supabaseStorageSignedUrl(storagePath, 3600);

    return res.status(200).json({
      ok: true,
      document: {
        id: row && row.id ? row.id : null,
        transactionId: transactionIdRaw,
        fileName,
        fileType: fileType || 'application/octet-stream',
        documentType: documentType || null,
        storagePath,
        signedUrl,
        fileSize: buffer.length,
        createdAt: row && row.created_at ? row.created_at : null,
      },
    });
  } catch (error) {
    // If we already wrote the storage object but the DB row insert failed,
    // clean the storage object up so we don't leak orphan files.
    if (storagePathForCleanup && error && /documents insert failed/i.test(String(error.message))) {
      await supabaseStorageRemove(storagePathForCleanup);
    }

    if (error instanceof AuthError) {
      res.status(error.status || 401).json({ ok: false, error: error.message });
      return;
    }
    if (error instanceof ValidationError) {
      res.status(error.status || 400).json({ ok: false, error: error.message });
      return;
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      res.status(429).json({ ok: false, error: 'Too many uploads. Try again later.' });
      return;
    }

    console.error('[upload-document] error:', error && error.message ? error.message : error);
    res.status(500).json({ ok: false, error: 'Could not save that document. Try again.' });
  }
};
