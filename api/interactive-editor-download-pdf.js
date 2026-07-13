// Vercel Serverless Function: /api/interactive-editor-download-pdf
//
// Returns the current FILLED PDF for a transaction+form.
// Two access patterns:
//
//   GET  ?transaction_id=<uuid>&form_number=20-19
//        Fills using the transactions row (canonical columns) + the most
//        recent contract_verification_events.field_values_snapshot for the
//        transaction if one exists. Used by the "Download filled PDF" button
//        after Accept.
//
//   POST { transaction_id, form_number, field_values: { key: value, ... } }
//        Fills using the caller-supplied live editor snapshot. Used by the
//        Interactive Editor's Preview + inline PDF pane so the agent sees
//        their in-progress edits reflected on the PDF in real time.
//
// Authorization: Bearer <supabase user JWT>
//
// 2026-07-13 CARTER — Phase 1 fill-pipeline fix. Previous version returned
// the BLANK TREC 20-19 template regardless of any field values, which caused
// Preview + Download to show empty forms and would have caused signers to
// receive blank contracts. See .tmp/dossie-sign-2026-07-13-BLOCKED/.

const { PDFDocument } = require('pdf-lib');
const fetch = require('node-fetch');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { applyCorsHeaders } = require('./_middleware/cors');
const { fillTrec2019 } = require('./_lib/fill-trec-20-19');

const TREC_RESALE_20_19_B64 = require('./_assets/trec-resale-20-19-base64.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, POST, OPTIONS' });
}

// Only TREC 20-19 supported by the Interactive Editor for now.
const SUPPORTED_FORM_NUMBERS = new Set(['20-19']);

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

// Merge the transactions canonical row values under the caller-supplied
// snapshot. Snapshot wins for keys the editor emitted, transactions row
// fills in the ~35 canonical columns (buyer_name, sale_price, closing_date,
// etc.) when the editor didn't override them.
function mergeFieldValues(txnRow, snapshot) {
  const merged = {};
  if (txnRow && typeof txnRow === 'object') {
    for (const [k, v] of Object.entries(txnRow)) {
      if (v == null || v === '') continue;
      merged[k] = v;
    }
  }
  if (snapshot && typeof snapshot === 'object') {
    for (const [k, v] of Object.entries(snapshot)) {
      if (v == null || v === '') continue;
      merged[k] = v;
    }
  }
  return merged;
}

async function fillTrec2019Pdf(fieldValues) {
  const buffer = Buffer.from(TREC_RESALE_20_19_B64, 'base64');
  const pdfDoc = await PDFDocument.load(buffer);
  await fillTrec2019(pdfDoc, fieldValues || {});
  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

async function loadLatestVerificationSnapshot(transactionId, formNumber) {
  try {
    const rows = await supa(
      `contract_verification_events?transaction_id=eq.${encodeURIComponent(transactionId)}` +
      `&trec_form_number=eq.${encodeURIComponent(formNumber)}` +
      `&select=field_values_snapshot&order=verified_at.desc&limit=1`
    );
    if (rows && rows[0] && rows[0].field_values_snapshot) {
      return rows[0].field_values_snapshot;
    }
  } catch (err) {
    console.warn('[interactive-editor-download-pdf] verification-snapshot load failed:', err && err.message);
  }
  return null;
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    // Params from query (GET) or body (POST).
    let params = req.query || {};
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      params = body || {};
    }

    const transactionId = sanitizeString(params.transaction_id, { maxLength: 200 });
    const formNumber = sanitizeString(params.form_number, { maxLength: 20 }) || '20-19';

    if (!transactionId) throw new ValidationError('transaction_id is required.');
    if (!SUPPORTED_FORM_NUMBERS.has(formNumber)) {
      throw new ValidationError(`Unsupported form_number: ${formNumber}`);
    }

    // Ownership check + pull the canonical column values.
    const txnRows = await supa(
      `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    if (!txnRows || txnRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }
    const txn = txnRows[0];

    // Resolve the source of the field-values snapshot.
    //   POST: caller supplied it (live editor state).
    //   GET:  latest accepted verification event, or null (fills only from txn).
    let snapshot = null;
    if (req.method === 'POST') {
      snapshot = (params.field_values && typeof params.field_values === 'object')
        ? params.field_values
        : {};
    } else {
      snapshot = await loadLatestVerificationSnapshot(transactionId, formNumber);
    }

    const merged = mergeFieldValues(txn, snapshot);

    // Render the filled PDF.
    let buffer;
    try {
      buffer = await fillTrec2019Pdf(merged);
    } catch (fillErr) {
      console.error('[interactive-editor-download-pdf] fillTrec2019Pdf failed:', fillErr && fillErr.message);
      return res.status(500).json({ ok: false, error: 'PDF fill failed.' });
    }

    const propSlug = String(txn.property_address || 'contract')
      .replace(/[^\w-]+/g, '_')
      .slice(0, 40);
    const filename = `TREC-${formNumber}-${propSlug}.pdf`;

    // Preview pane fetches into fetch().blob() which needs a URL-able response.
    // Return inline for POST (preview), attachment for GET (download button).
    const disposition = req.method === 'POST' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Cache-Control', 'no-store');
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
