// Vercel Serverless Function: /api/interactive-editor-verify
//
// Phase 1 Interactive Form Editor legal-trail endpoint.
//
// Called when the agent checks the "I've reviewed this document and confirm
// the fields are correct" box and clicks Accept. Inserts a row into
// public.contract_verification_events with a SHA-256 hash of the PDF the
// agent accepted + a full snapshot of every field value. Used later to
// prove exactly what the agent saw + accepted at the moment they hit send.
//
// POST {
//   transaction_id,
//   form_number,               // '20-19'
//   template_id,               // '4952172'
//   contract_version,          // 'TREC 20-19 · Effective 07/01/2026'
//   field_values,              // { field_key: value, ... }
//   signers,                   // [{ role, email, name }, ...]
//   pdf_hash                   // sha256 hex (client computes over the exact PDF preview it displayed)
// }
//
// Response: { ok: true, verification_event_id: <uuid> }
//
// Authorization: Bearer <supabase user JWT>
//
// CARTER draft 2026-07-11.

const fetch = require('node-fetch');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
}

async function supa(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
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

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    if (!transactionId) throw new ValidationError('transaction_id is required.');

    const formNumber = sanitizeString(body.form_number, { maxLength: 20 }) || null;
    const templateId = sanitizeString(body.template_id, { maxLength: 40 }) || null;
    const contractVersion = sanitizeString(body.contract_version, { maxLength: 200 }) || null;
    const pdfHash = sanitizeString(body.pdf_hash, { maxLength: 100 }) || null;
    const pdfStoragePath = sanitizeString(body.pdf_storage_path, { maxLength: 500 }) || null;

    // fields snapshot — accept the raw object; postgres JSONB handles it.
    const fieldValues = (body.field_values && typeof body.field_values === 'object')
      ? body.field_values
      : {};

    // signers — array of { role, email, name }.
    let signers = [];
    if (Array.isArray(body.signers)) {
      signers = body.signers
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          role: sanitizeString(s.role, { maxLength: 100 }) || null,
          email: sanitizeString(s.email, { maxLength: 200 }) || null,
          name: sanitizeString(s.name, { maxLength: 200 }) || null,
        }));
    }

    // Ownership check.
    const txnRows = await supa(`transactions?id=eq.${transactionId}&user_id=eq.${userId}&select=id&limit=1`);
    if (!txnRows || txnRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }

    // Look up the form_templates row (for the FK) — non-blocking.
    let formTemplateId = null;
    try {
      const tplRows = await supa(`form_templates?trec_number=eq.${encodeURIComponent(formNumber || '')}&select=id&limit=1`);
      if (tplRows && tplRows[0]) formTemplateId = tplRows[0].id;
    } catch (_err) {
      // Non-fatal.
    }

    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;
    const clientIp = String(
      req.headers['x-forwarded-for'] || req.socket?.remoteAddress || ''
    ).split(',')[0].trim().slice(0, 100) || null;

    const insertRows = await supa('contract_verification_events', {
      method: 'POST',
      body: JSON.stringify([{
        transaction_id: transactionId,
        form_template_id: formTemplateId,
        template_id: templateId,
        trec_form_number: formNumber,
        contract_version: contractVersion,
        verified_by: userId,
        pdf_hash: pdfHash,
        pdf_storage_path: pdfStoragePath,
        field_values_snapshot: fieldValues,
        signer_emails: signers,
        user_agent: userAgent,
        client_ip: clientIp,
      }]),
    });

    const row = Array.isArray(insertRows) && insertRows[0] ? insertRows[0] : null;
    return res.status(200).json({
      ok: true,
      verification_event_id: row ? row.id : null,
      verified_at: row ? row.verified_at : null,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    console.error('[interactive-editor-verify] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
};
