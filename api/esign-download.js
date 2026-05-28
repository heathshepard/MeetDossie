// Vercel Serverless Function: /api/esign-download
// POST { submissionId }
// Authorization: Bearer <CRON_SECRET>  (internal only — not a user JWT)
//
// Pulls the completed signed PDF from DocuSeal into Supabase Storage,
// inserts a documents row with document_type='signed', and updates the
// signature_requests row to status='completed'.
//
// This endpoint is also called inline by esign-webhook when all signers complete,
// but is exposed as a standalone endpoint so Heath can manually trigger a download
// if the webhook fires before DocuSeal has fully rendered the PDF.
//
// Env vars required:
//   CRON_SECRET
//   DOCUSEAL_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const DOCUSEAL_BASE = 'https://api.docuseal.com';
const BUCKET = 'documents';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || VERCEL_PREVIEW_RE.test(origin)) {
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

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

function verifyCronSecret(req) {
  const header = (req.headers.authorization || '').trim();
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7).trim();
  if (!CRON_SECRET) return false;
  return token === CRON_SECRET;
}

async function fetchSignatureRequest(submissionId) {
  const res = await supa(
    `signature_requests?docuseal_submission_id=eq.${encodeURIComponent(submissionId)}&select=*&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function fetchDocumentName(documentId) {
  const res = await supa(`documents?id=eq.${encodeURIComponent(documentId)}&select=file_name&limit=1`);
  if (!res.ok) return 'Document.pdf';
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]?.file_name) ? rows[0].file_name : 'Document.pdf';
}

module.exports = async function handler(req, res) {
  // CORS (for any internal tooling calling from browser).
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  // Auth: CRON_SECRET bearer token only.
  if (!verifyCronSecret(req)) {
    res.status(401).json({ ok: false, error: 'Unauthorized.' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  const body = req.body || {};
  const submissionId = typeof body.submissionId === 'string' ? body.submissionId.trim() : '';

  if (!submissionId) {
    res.status(400).json({ ok: false, error: 'submissionId is required.' });
    return;
  }

  try {
    // Look up the signature request.
    const sr = await fetchSignatureRequest(submissionId);
    if (!sr) {
      return res.status(404).json({ ok: false, error: 'No signature request found for that submissionId.' });
    }
    if (sr.status === 'completed' && sr.signed_document_id) {
      return res.status(200).json({ ok: true, note: 'Already downloaded.', signedDocumentId: sr.signed_document_id });
    }

    if (!DOCUSEAL_API_KEY) {
      // TODO: remove this stub once DOCUSEAL_API_KEY is set in Vercel.
      console.warn('[esign-download] DOCUSEAL_API_KEY not set — cannot download signed PDF.');
      return res.status(200).json({ ok: false, error: 'DOCUSEAL_API_KEY not configured. Add it to Vercel env vars.' });
    }

    // Fetch submission details from DocuSeal.
    const detailRes = await fetch(`${DOCUSEAL_BASE}/submissions/${encodeURIComponent(submissionId)}`, {
      headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
    });
    if (!detailRes.ok) {
      const text = await detailRes.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `DocuSeal fetch failed (${detailRes.status}): ${text.slice(0, 200)}` });
    }
    const submission = await detailRes.json();
    const signedDocUrl = submission?.documents?.[0]?.url;
    if (!signedDocUrl) {
      return res.status(422).json({ ok: false, error: 'Signed document URL not available yet. DocuSeal may still be rendering.' });
    }

    // Download the signed PDF.
    const pdfRes = await fetch(signedDocUrl);
    if (!pdfRes.ok) {
      return res.status(502).json({ ok: false, error: `Failed to download signed PDF from DocuSeal (${pdfRes.status}).` });
    }
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

    // Build storage path.
    const originalName = await fetchDocumentName(sr.document_id);
    const safeName = originalName.replace(/[^A-Za-z0-9._\-\s()]/g, '_');
    const ts = Date.now();
    const storagePath = `${sr.user_id}/${sr.transaction_id || 'no-transaction'}/signed-${ts}-${safeName}`;

    // Upload to Supabase Storage.
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/pdf',
        'x-upsert': 'false',
      },
      body: pdfBuffer,
    });
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `Storage upload failed (${uploadRes.status}): ${text.slice(0, 200)}` });
    }

    // Insert a documents row for the signed PDF.
    const docRes = await supa('documents', {
      method: 'POST',
      body: JSON.stringify({
        transaction_id: sr.transaction_id || null,
        user_id: sr.user_id,
        file_name: `signed-${safeName}`,
        file_type: 'application/pdf',
        document_type: 'signed',
        storage_path: storagePath,
        file_size: pdfBuffer.length,
      }),
    });
    if (!docRes.ok) {
      const text = await docRes.text().catch(() => '');
      return res.status(502).json({ ok: false, error: `documents insert failed (${docRes.status}): ${text.slice(0, 200)}` });
    }
    const docRows = await docRes.json().catch(() => []);
    const newDoc = Array.isArray(docRows) ? docRows[0] : docRows;
    const signedDocumentId = newDoc?.id || null;

    // Update signature_requests to completed.
    await supa(`signature_requests?id=eq.${encodeURIComponent(sr.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'completed',
        signed_document_id: signedDocumentId,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });

    return res.status(200).json({
      ok: true,
      signedDocumentId,
      storagePath,
      fileSizeBytes: pdfBuffer.length,
    });
  } catch (err) {
    console.error('[esign-download] error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'Failed to download signed document. Try again.' });
  }
};
