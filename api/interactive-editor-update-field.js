// Vercel Serverless Function: /api/interactive-editor-update-field
//
// Updates a single field on a transaction and re-renders the affected form
// PDF. Thin wrapper over dossie-update-and-refill's logic, scoped to one
// specific form_type so we always get back a fresh signed URL for that form.
//
// POST { transaction_id, form_type, field_key, new_value, source? }
// Response: {
//   ok: true,
//   pdfUrl: string,
//   field: {
//     id, form, key, value, autoFilledValue, type, required, valid, source
//   },
//   validationErrors: []
// }
//
// Authorization: Bearer <supabase user JWT>

const fetch = require('node-fetch');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { fieldNameToPrompt } = require('./_lib/fill-form-required-fields');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
}

const ALLOWED_FIELDS = new Set([
  'sale_price', 'closing_date', 'option_days', 'option_fee', 'earnest_money',
  'financing_type', 'financing_days', 'loan_amount', 'down_payment',
  'buyer_name', 'seller_name', 'property_address', 'city_state_zip',
  'title_company', 'notes', 'land_acreage', 'expected_completion_date',
  'contract_effective_date', 'possession_date', 'transaction_type',
  'title_officer_name', 'title_officer_email', 'title_officer_phone',
  'lender_name', 'loan_officer_name', 'loan_officer_email', 'loan_officer_phone',
  'hoa_name', 'hoa_phone', 'hoa_management_company', 'hoa_monthly_dues',
  'inspector_name', 'inspector_phone', 'inspector_email',
  'mls_number', 'bedrooms', 'bathrooms', 'sqft', 'year_built',
]);

const FIELD_ALIASES = {
  down_payment_amt: 'down_payment',
  title_policy_paid_by: 'notes',
};

const MONEY_FIELDS = new Set([
  'sale_price', 'option_fee', 'earnest_money', 'loan_amount', 'down_payment',
  'hoa_monthly_dues',
]);
const INTEGER_FIELDS = new Set([
  'option_days', 'financing_days', 'bedrooms', 'sqft', 'year_built',
]);

const ALLOWED_FORM_TYPES = new Set([
  'resale-contract',
  'financing-addendum',
  'hoa-addendum',
  'lead-paint-addendum',
]);

function normalizeNumericValue(canonical, rawValue) {
  if (rawValue == null || rawValue === '') return rawValue;
  if (MONEY_FIELDS.has(canonical)) {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue;
    const cleaned = String(rawValue).replace(/[^\d.-]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : rawValue;
  }
  if (INTEGER_FIELDS.has(canonical)) {
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return Math.trunc(rawValue);
    const cleaned = String(rawValue).replace(/[^\d-]/g, '');
    const n = parseInt(cleaned, 10);
    return Number.isFinite(n) ? n : rawValue;
  }
  return rawValue;
}

async function supabaseCall(method, path, body) {
  const opts = {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
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

function inferFieldType(key) {
  if (MONEY_FIELDS.has(key)) return 'money';
  if (INTEGER_FIELDS.has(key)) return 'integer';
  if (/_date$/.test(key) || /_at$/.test(key)) return 'date';
  return 'text';
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
    const formType = sanitizeString(body.form_type, { maxLength: 100 });
    const fieldKeyRaw = sanitizeString(body.field_key, { maxLength: 200 });
    const source = ['manual', 'dossie_suggestion'].includes(body.source) ? body.source : 'manual';
    let newValue = body.new_value;
    if (newValue !== null && newValue !== undefined) {
      newValue = String(newValue).slice(0, 4000);
    }

    if (!transactionId) throw new ValidationError('transaction_id is required.');
    if (!formType) throw new ValidationError('form_type is required.');
    if (!fieldKeyRaw) throw new ValidationError('field_key is required.');
    if (!ALLOWED_FORM_TYPES.has(formType)) {
      throw new ValidationError(`Unsupported form_type: ${formType}`);
    }

    const canonical = FIELD_ALIASES[fieldKeyRaw] || fieldKeyRaw;
    // 2026-07-13 CARTER — Bug #2 (Quinn DoD Round 1). Non-canonical fields
    // (~170 of ~200 on TREC 20-19) used to return skipped:true — the UI
    // showed "Saved" but the values dropped silently, wiping ~170 fields on
    // reload. Now they persist into transactions.contract_field_drafts, a
    // JSONB column keyed by form_number → { field_key: value }.
    // form_type -> form_number mapping (matches interactive-editor-init.js).
    const FORM_TYPE_TO_FORM_NUMBER = {
      'resale-contract':     '20-19',
      'financing-addendum':  '40-11',
      'hoa-addendum':        '36-11',
      'lead-paint-addendum': 'OP-L',
    };
    if (!ALLOWED_FIELDS.has(canonical)) {
      // 1. Load the row (ownership + current drafts).
      const ownRows = await supabaseCall(
        'GET',
        `transactions?id=eq.${transactionId}&select=user_id,contract_field_drafts&limit=1`
      );
      if (!ownRows || ownRows.length === 0) {
        return res.status(404).json({ ok: false, error: 'Transaction not found.' });
      }
      if (ownRows[0].user_id !== userId) {
        return res.status(403).json({ ok: false, error: 'Forbidden.' });
      }

      // 2. Merge into contract_field_drafts[form_number][field_key].
      const formNumber = FORM_TYPE_TO_FORM_NUMBER[formType] || formType;
      const existingDrafts = (ownRows[0].contract_field_drafts && typeof ownRows[0].contract_field_drafts === 'object')
        ? ownRows[0].contract_field_drafts
        : {};
      const formDrafts = { ...(existingDrafts[formNumber] || {}) };
      if (newValue === null || newValue === undefined || newValue === '') {
        delete formDrafts[fieldKeyRaw];
      } else {
        formDrafts[fieldKeyRaw] = String(newValue);
      }
      const nextDrafts = { ...existingDrafts, [formNumber]: formDrafts };

      try {
        await supabaseCall('PATCH', `transactions?id=eq.${transactionId}`, {
          contract_field_drafts: nextDrafts,
          updated_at: new Date().toISOString(),
        });
      } catch (patchErr) {
        console.error('[interactive-editor-update-field] draft merge failed:', patchErr && patchErr.message);
        return res.status(500).json({ ok: false, error: 'Could not save draft field.' });
      }

      return res.status(200).json({
        ok: true,
        persisted: 'draft',
        pdfUrl: null,
        field: {
          id: `${formType}:${fieldKeyRaw}`,
          form: formType,
          key: fieldKeyRaw,
          label: fieldKeyRaw,
          value: newValue == null ? '' : String(newValue),
          autoFilledValue: null,
          type: 'text',
          required: false,
          valid: true,
          source,
        },
        validationErrors: [],
      });
    }

    // 1. Verify ownership.
    const txnRows = await supabaseCall('GET', `transactions?id=eq.${transactionId}&limit=1`);
    if (!txnRows || txnRows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Transaction not found.' });
    }
    if (txnRows[0].user_id !== userId) {
      return res.status(403).json({ ok: false, error: 'Forbidden.' });
    }

    // 2. Update the field (targeted PATCH — race-safe).
    const typedValue = normalizeNumericValue(canonical, newValue);
    await supabaseCall('PATCH', `transactions?id=eq.${transactionId}`, {
      [canonical]: typedValue,
      updated_at: new Date().toISOString(),
    });

    // 3. Re-render the specific form PDF by calling fill-form.
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!userToken) {
      return res.status(401).json({ ok: false, error: 'Missing auth token for fill-form.' });
    }

    // Re-fetch fresh txn to include any concurrent updates.
    const freshRows = await supabaseCall('GET', `transactions?id=eq.${transactionId}&limit=1`);
    const freshTxn = freshRows[0];

    const host = process.env.VERCEL_URL
      ? (process.env.VERCEL_URL.startsWith('http') ? process.env.VERCEL_URL : `https://${process.env.VERCEL_URL}`)
      : 'https://meetdossie.com';
    const fillFormUrl = `${host}/api/fill-form`;

    let pdfUrl = null;
    try {
      const fillRes = await fetch(fillFormUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          transaction_id: transactionId,
          form_type: formType,
          field_values: freshTxn,
        }),
      });
      if (fillRes.ok) {
        const fillJson = await fillRes.json().catch(() => null);
        pdfUrl = (fillJson && (fillJson.signedUrl || fillJson.pdf_url)) || null;
      } else {
        const text = await fillRes.text().catch(() => '');
        console.error('[interactive-editor-update-field] fill-form failed:', fillRes.status, text.slice(0, 200));
      }
    } catch (fillErr) {
      console.error('[interactive-editor-update-field] fill-form exception:', fillErr && fillErr.message);
    }

    const type = inferFieldType(canonical);
    const updatedField = {
      id: `${formType}:${fieldKeyRaw}`,
      form: formType,
      key: fieldKeyRaw,
      label: fieldNameToPrompt(fieldKeyRaw),
      value: typedValue == null ? '' : String(typedValue),
      autoFilledValue: null,
      type,
      required: false, // caller preserves its required flag on merge
      valid: isFieldValid(typedValue, type, false),
      source,
    };

    return res.status(200).json({
      ok: true,
      pdfUrl,
      field: updatedField,
      validationErrors: [],
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    console.error('[interactive-editor-update-field] error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error.' });
  }
};
