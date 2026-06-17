// Vercel Serverless Function: /api/insert-document-row
// Inserts a document row for a file that's already been uploaded to Supabase Storage.
// Used for non-PDF files or when the file is already at a storagePath.
//
// POST /api/insert-document-row
// Body: { transactionId, fileName, fileType, storagePath, documentType? }
// Authorization: Bearer <supabase user JWT>
// Response: { ok, document }

const {
  sanitizeString,
  ValidationError,
} = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseStorageSignedUrl(storagePath, expiresInSeconds = 3600) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/documents/${storagePath}`;
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
    const { userId } = await verifySupabaseToken(req);

    const body = req.body || {};
    const transactionIdRaw = sanitizeString(body.transactionId, { maxLength: 200 });
    const fileNameRaw = body.fileName;
    const fileType = sanitizeString(body.fileType, { maxLength: 200 }) || '';
    const storagePath = body.storagePath;
    const documentType = sanitizeString(body.documentType, { maxLength: 100 });

    if (!transactionIdRaw) {
      throw new ValidationError('transactionId is required');
    }
    if (!fileNameRaw || typeof fileNameRaw !== 'string') {
      throw new ValidationError('fileName is required');
    }
    if (!storagePath || typeof storagePath !== 'string') {
      throw new ValidationError('storagePath is required');
    }

    const fileName = fileNameRaw
      .replace(/[\/]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/[^A-Za-z0-9._\-\s()]/g, '_')
      .trim() || 'document';

    const row = await supabaseInsertDocumentRow({
      transaction_id: transactionIdRaw,
      user_id: userId,
      file_name: fileName,
      file_type: fileType || 'application/octet-stream',
      document_type: documentType || null,
      storage_path: storagePath,
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
        createdAt: row && row.created_at ? row.created_at : null,
      },
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }

    console.error('[insert-document-row] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not save document.' });
  }
};
