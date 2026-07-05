// Vercel Serverless Function: /api/interactive-editor-validate
//
// Validates that all required fields are non-empty and valid across the
// interactive-editor's tracked forms. Returns isReady + error list + the
// redirect URL for the existing send-for-signature flow.
//
// POST { transaction_id }
// Response: {
//   ok: true,
//   isReady: boolean,
//   errors: string[],
//   esignRedirectUrl: string | null   // null when not ready
// }
//
// The frontend uses esignRedirectUrl only as a hint — the actual e-sign
// modal is opened locally with the existing document from the transaction.
//
// Authorization: Bearer <supabase user JWT>

const fetch = require('node-fetch');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { fieldNameToPrompt } = require('./_lib/fill-form-required-fields');

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

// Only require validation on the primary contract by default — addenda are
// optional/context-dependent. Keep the primary tight; expand later as needed.
const REQUIRED_FIELDS_BY_FORM = {
  'resale-contract': [
    'sale_price',
    'earnest_money',
    'option_fee',
    'option_days',
    'closing_date',
    'financing_type',
  ],
  'financing-addendum': [
    'loan_amount',
    'down_payment',
    'financing_type',
  ],
  'hoa-addendum': [],
  'lead-paint-addendum': [],
};

const MONEY_FIELDS = new Set([
  'sale_price', 'option_fee', 'earnest_money', 'loan_amount', 'down_payment',
]);
const INTEGER_FIELDS = new Set([
  'option_days', 'financing_days',
]);

function inferFieldType(key) {
  if (MONEY_FIELDS.has(key)) return 'money';
  if (INTEGER_FIELDS.has(key)) return 'integer';
  if (/_date$/.test(key)) return 'date';
  return 'text';
}

function fieldIsEmpty(value) {
  return value === null || value === undefined || value === '' ||
    (typeof value === 'boolean' && value === false);
}

function fieldIsValidFormat(value, type) {
  if (fieldIsEmpty(value)) return false;
  if (type === 'money' || type === 'integer') {
    const n = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) && n >= 0;
  }
  if (type === 'date') {
    return !Number.isNaN(new Date(value).getTime());
  }
  return true;
}

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

    // Optional: subset of forms to validate.
    const requestedForms = Array.isArray(body.forms)
      ? body.forms.filter((f) => typeof f === 'string' && REQUIRED_FIELDS_BY_FORM[f] !== undefined)
      : Object.keys(REQUIRED_FIELDS_BY_FORM);

    const txnRows = await supabaseCall('GET', `transactions?id=eq.${transactionId}&limit=1`);
    if (!txnRows || txnRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }
    const txn = txnRows[0];
    if (txn.user_id !== userId) {
      return res.status(403).json({ ok: false, error: 'Forbidden.' });
    }

    // Check which forms actually have a filled_form doc in storage — only
    // validate those (customer may only be sending the resale contract).
    const docRows = await supabaseCall(
      'GET',
      `documents?transaction_id=eq.${transactionId}&document_type=eq.filled_form&select=form_type`
    );
    const availableForms = new Set((docRows || []).map((d) => d.form_type).filter(Boolean));

    const errors = [];
    for (const formType of requestedForms) {
      if (!availableForms.has(formType)) continue; // Skip unfilled optional forms.
      const requiredKeys = REQUIRED_FIELDS_BY_FORM[formType] || [];
      for (const key of requiredKeys) {
        const val = txn[key];
        const type = inferFieldType(key);
        if (fieldIsEmpty(val)) {
          errors.push(`${fieldNameToPrompt(key)} (${formType}) is required.`);
        } else if (!fieldIsValidFormat(val, type)) {
          errors.push(`${fieldNameToPrompt(key)} (${formType}) has an invalid value.`);
        }
      }
    }

    const isReady = errors.length === 0;
    return res.status(200).json({
      ok: true,
      isReady,
      errors,
      esignRedirectUrl: isReady ? `/app?deal=${transactionId}&action=send-for-signature` : null,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    console.error('[interactive-editor-validate] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
};
