// Vercel Serverless Function: /api/interactive-editor-download-pdf
//
// Returns the current filled PDF for a transaction+form as an attachment.
// Used by the Phase 1 Interactive Form Editor's "Download filled PDF"
// button (Pierce's data-export requirement — avoid vendor lock-in).
//
// GET /api/interactive-editor-download-pdf?transaction_id=<uuid>&form_number=20-19
// Authorization: Bearer <supabase user JWT>
//
// The endpoint locates the most recent filled document for the requested
// form, streams it back with Content-Disposition: attachment. If no filled
// doc exists, it falls back to the blank template so the agent always gets
// something.
//
// CARTER draft 2026-07-11.

const fetch = require('node-fetch');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { applyCorsHeaders } = require('./_middleware/cors');
const { resolveBlankTemplatePdf } = require('./_lib/resolve-blank-template-pdf');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, OPTIONS' });
}

const FORM_TO_DOCUMENT_TYPE = {
  '20-19': 'resale_contract',
  '20-18': 'resale_contract',
};

async function supa(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${opts.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return [];
  const text = await res.text().catch(() => '');
  if (!text) return [];
  try { return JSON.parse(text); } catch { return []; }
}

async function fetchStorageBuffer(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) return null;
  const arr = await r.arrayBuffer();
  return Buffer.from(arr);
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { userId } = await verifySupabaseToken(req);
    const transactionId = sanitizeString(req.query?.transaction_id, { maxLength: 200 });
    const formNumber = sanitizeString(req.query?.form_number, { maxLength: 20 }) || '20-19';

    if (!transactionId) throw new ValidationError('transaction_id is required.');
    const documentType = FORM_TO_DOCUMENT_TYPE[formNumber];
    if (!documentType) throw new ValidationError(`Unsupported form_number: ${formNumber}`);

    // Ownership check.
    const txnRows = await supa(`transactions?id=eq.${transactionId}&user_id=eq.${userId}&select=id,buyer_name,seller_name,property_address&limit=1`);
    if (!txnRows || txnRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }
    const txn = txnRows[0];

    // Locate the most recent filled document for this form.
    const docRows = await supa(
      `documents?transaction_id=eq.${transactionId}&document_type=eq.${documentType}&select=id,storage_path,file_name,status,form_template_id&order=created_at.desc&limit=1`
    );
    const doc = (docRows && docRows[0]) || null;

    let buffer = null;
    let filename = null;

    if (doc) {
      // Try the shared blank-template resolver first (handles placeholder
      // storage paths). Falls through to real Storage otherwise.
      const resolvedBlank = await resolveBlankTemplatePdf(doc);
      if (resolvedBlank) {
        buffer = resolvedBlank.buffer;
        filename = resolvedBlank.filename || `TREC-${formNumber}-${(txn.property_address || 'contract').replace(/[^\w-]+/g, '_').slice(0, 40)}.pdf`;
      } else if (doc.storage_path) {
        buffer = await fetchStorageBuffer(doc.storage_path);
        filename = doc.file_name || `TREC-${formNumber}.pdf`;
      }
    }

    // Fallback: blank template.
    if (!buffer) {
      const blank = await resolveBlankTemplatePdf({
        document_type: 'form_template',
        status: 'blank',
        _short_name_fallback: '1-4 Family Contract',
      });
      if (blank) {
        buffer = blank.buffer;
        filename = `TREC-${formNumber}-blank.pdf`;
      }
    }

    if (!buffer) {
      return res.status(404).json({ ok: false, error: 'PDF not found.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename || `TREC-${formNumber}.pdf`}"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.status(200).send(buffer);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    console.error('[interactive-editor-download-pdf] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
};
