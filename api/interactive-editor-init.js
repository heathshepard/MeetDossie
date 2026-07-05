// Vercel Serverless Function: /api/interactive-editor-init
//
// Loads the 4 filled PDFs (or a subset) + a field inventory for the
// Interactive Editor. Called after Talk-to-Dossie's fill_forms tool
// completes. Reuses the existing filled_form documents in Supabase Storage.
//
// POST { transaction_id, forms?: string[] }
// Response: {
//   ok: true,
//   transaction: { id, buyer, seller, ... },
//   forms: {
//     "resale-contract":     { name, pdfUrl, documentId, fields: [...] },
//     "financing-addendum":  { ... },
//     "hoa-addendum":        { ... },
//     "lead-paint-addendum": { ... },
//   }
// }
//
// Field object shape:
// {
//   id: "resale-contract:sale_price",
//   form: "resale-contract",
//   key: "sale_price",           // canonical column name on transactions
//   label: "Sale price",
//   value: "425000",             // stringified current value
//   required: true,
//   valid: true,
//   source: "auto",
//   type: "money" | "date" | "integer" | "text"
// }
//
// Authorization: Bearer <supabase user JWT>

const fetch = require('node-fetch');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  REQUIRED_FIELDS_BY_FORM_TYPE,
  fieldNameToPrompt,
} = require('./_lib/fill-form-required-fields');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

// Human-readable form names (matches DocuSeal template titles).
const FORM_LABELS = {
  'resale-contract':     { code: '20-18', name: 'One to Four Family Residential Contract' },
  'financing-addendum':  { code: '40-11', name: 'Third Party Financing Addendum' },
  'hoa-addendum':        { code: '36-11', name: 'HOA Addendum' },
  'lead-paint-addendum': { code: 'OP-L',  name: 'Lead-Based Paint Addendum' },
};

// fill-form.js stores documents with a `document_type` column, not
// `form_type`. Map our canonical form_type key -> the document_type value
// so we can locate the most recent filled PDF for each form.
const FORM_TYPE_TO_DOCUMENT_TYPE = {
  'resale-contract':     'resale_contract',
  'financing-addendum':  'financing_addendum',
  'hoa-addendum':        'hoa_addendum',
  'lead-paint-addendum': 'lead_paint_addendum',
};

// Extend REQUIRED_FIELDS to include the four target forms plus common optional
// fields customers may want to review/adjust before signing.
const EDITABLE_FIELDS_BY_FORM = {
  'resale-contract': [
    { key: 'sale_price', required: true, type: 'money' },
    { key: 'earnest_money', required: true, type: 'money' },
    { key: 'option_fee', required: true, type: 'money' },
    { key: 'option_days', required: true, type: 'integer' },
    { key: 'closing_date', required: true, type: 'date' },
    { key: 'financing_type', required: true, type: 'text' },
    { key: 'title_policy_paid_by', required: true, type: 'text' },
    { key: 'buyer_name', required: false, type: 'text' },
    { key: 'seller_name', required: false, type: 'text' },
    { key: 'property_address', required: false, type: 'text' },
    { key: 'city_state_zip', required: false, type: 'text' },
    { key: 'title_company', required: false, type: 'text' },
  ],
  'financing-addendum': [
    { key: 'loan_amount', required: true, type: 'money' },
    { key: 'down_payment', required: true, type: 'money' },
    { key: 'financing_type', required: true, type: 'text' },
    { key: 'financing_days', required: false, type: 'integer' },
  ],
  'hoa-addendum': [
    { key: 'hoa_name', required: false, type: 'text' },
    { key: 'hoa_phone', required: false, type: 'text' },
    { key: 'hoa_management_company', required: false, type: 'text' },
    { key: 'hoa_monthly_dues', required: false, type: 'money' },
  ],
  'lead-paint-addendum': [
    { key: 'buyer_name', required: false, type: 'text' },
    { key: 'seller_name', required: false, type: 'text' },
    { key: 'property_address', required: false, type: 'text' },
  ],
};

async function supabaseCall(method, path, body) {
  const opts = {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return [];
  const text = await res.text().catch(() => '');
  if (!text) return [];
  try { return JSON.parse(text); } catch { return []; }
}

async function getSignedUrl(storagePath) {
  if (!storagePath) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/documents/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    if (!json || !json.signedURL) return null;
    return `${SUPABASE_URL}/storage/v1${json.signedURL}`;
  } catch {
    return null;
  }
}

function formatFieldValue(rawValue, type) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return '';
  if (type === 'money') {
    if (typeof rawValue === 'number') return String(rawValue);
    return String(rawValue);
  }
  if (type === 'date') {
    // Keep ISO dates as-is; frontend will render.
    return String(rawValue);
  }
  return String(rawValue);
}

function isFieldValid(rawValue, type, required) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return !required;
  }
  if (type === 'money' || type === 'integer') {
    const n = Number(String(rawValue).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n);
  }
  if (type === 'date') {
    return !Number.isNaN(new Date(rawValue).getTime());
  }
  return true;
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

    // Optionally restrict to a subset of forms.
    const requestedForms = Array.isArray(body.forms)
      ? body.forms.filter((f) => typeof f === 'string' && EDITABLE_FIELDS_BY_FORM[f])
      : Object.keys(EDITABLE_FIELDS_BY_FORM);

    // 1. Fetch the transaction row.
    const txnRows = await supabaseCall(
      'GET',
      `transactions?id=eq.${transactionId}&limit=1`
    );
    if (!txnRows || txnRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }
    const txn = txnRows[0];
    if (txn.user_id !== userId) {
      return res.status(403).json({ ok: false, error: 'Forbidden.' });
    }

    // 2. Fetch the most recent filled_form document for each form type.
    // fill-form.js writes documents.document_type as one of
    //   resale_contract | financing_addendum | hoa_addendum | lead_paint_addendum
    // (and leaves the legacy form_type column NULL). We match on document_type.
    const wantedDocTypes = requestedForms
      .map((f) => FORM_TYPE_TO_DOCUMENT_TYPE[f])
      .filter(Boolean);
    const docTypeFilter = wantedDocTypes.length > 0
      ? `document_type=in.(${wantedDocTypes.map((t) => `"${t}"`).join(',')})`
      : `document_type=in.("resale_contract","financing_addendum","hoa_addendum","lead_paint_addendum")`;
    const docRows = await supabaseCall(
      'GET',
      `documents?transaction_id=eq.${transactionId}&${docTypeFilter}&select=id,document_type,storage_path,created_at,file_name&order=created_at.desc`
    );

    // Latest-per-document_type -> map back to form_type key.
    const latestDocByFormType = {};
    for (const d of (docRows || [])) {
      if (!d.document_type) continue;
      // Reverse-map document_type -> form_type key.
      const formTypeKey = Object.keys(FORM_TYPE_TO_DOCUMENT_TYPE)
        .find((k) => FORM_TYPE_TO_DOCUMENT_TYPE[k] === d.document_type);
      if (!formTypeKey) continue;
      if (!latestDocByFormType[formTypeKey]) {
        latestDocByFormType[formTypeKey] = d;
      }
    }

    // 3. Build per-form response.
    const forms = {};
    for (const formType of requestedForms) {
      const editableFields = EDITABLE_FIELDS_BY_FORM[formType] || [];
      const doc = latestDocByFormType[formType] || null;
      const signedUrl = doc ? await getSignedUrl(doc.storage_path) : null;

      const fields = editableFields.map((f) => {
        const rawValue = txn[f.key];
        const valueStr = formatFieldValue(rawValue, f.type);
        return {
          id: `${formType}:${f.key}`,
          form: formType,
          key: f.key,
          label: fieldNameToPrompt(f.key),
          value: valueStr,
          autoFilledValue: valueStr,
          type: f.type,
          required: f.required,
          valid: isFieldValid(rawValue, f.type, f.required),
          source: 'auto',
        };
      });

      forms[formType] = {
        code: FORM_LABELS[formType]?.code || formType,
        name: FORM_LABELS[formType]?.name || formType,
        pdfUrl: signedUrl,
        documentId: doc?.id || null,
        fileName: doc?.file_name || null,
        available: Boolean(doc),
        fields,
      };
    }

    return res.status(200).json({
      ok: true,
      transaction: {
        id: txn.id,
        buyer_name: txn.buyer_name || null,
        seller_name: txn.seller_name || null,
        property_address: txn.property_address || null,
        city_state_zip: txn.city_state_zip || null,
      },
      forms,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    console.error('[interactive-editor-init] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
};
