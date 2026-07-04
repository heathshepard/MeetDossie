// api/dossie-update-and-refill.js
// Vercel Serverless Function
//
// POST /api/dossie-update-and-refill
// Updates a single field on a dossier and re-fills the PDF with the new value.
//
// Body:
// {
//   dossier_id: string (uuid),
//   field_name: string (snake_case),
//   field_value: string | number | boolean,
// }
//
// Returns:
// { ok: true, dossier_id, field_name, field_value, pdf_url, updated_at }
// { ok: false, error: string }

const fetch = require('node-fetch');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

async function supabaseCall(method, path, body) {
  const opts = {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      // Ask Supabase to return the updated/inserted rows as JSON.
      Prefer: 'return=representation',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Supabase ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`
    );
  }
  // 204 No Content returns nothing even with Prefer header — handle gracefully.
  if (res.status === 204) return [];
  const text = await res.text().catch(() => '');
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

// Whitelist of DB columns we allow writes to via this endpoint.
// The transactions table uses snake_case column names — do NOT convert to camelCase.
// Kept in sync with the update_deal_field field enum in api/chat.js and the
// fieldMap in Dossie/dossie-app.jsx so any AI-emitted canonical field can be
// written here without silent failure.
const ALLOWED_FIELDS = new Set([
  // Core deal terms
  'sale_price', 'closing_date', 'option_days', 'option_fee', 'earnest_money',
  'financing_type', 'financing_days', 'loan_amount', 'down_payment',
  'buyer_name', 'seller_name', 'property_address', 'city_state_zip',
  'title_company', 'notes', 'land_acreage', 'expected_completion_date',
  'contract_effective_date', 'possession_date', 'transaction_type',
  // Contacts
  'title_officer_name', 'title_officer_email', 'title_officer_phone',
  'lender_name', 'loan_officer_name', 'loan_officer_email', 'loan_officer_phone',
  'hoa_name', 'hoa_phone', 'hoa_management_company', 'hoa_monthly_dues',
  'inspector_name', 'inspector_phone', 'inspector_email',
  // Property meta
  'mls_number', 'bedrooms', 'bathrooms', 'sqft', 'year_built',
  // Deadlines
  'appraisal_deadline', 'survey_deadline', 'hoa_document_deadline',
  'loan_approval_deadline',
  // Block 3 — Option period
  'option_fee_amount', 'option_fee_paid_at', 'option_fee_paid_to',
  'earnest_money_amount', 'earnest_money_deposited_at',
  'earnest_money_confirmed_at', 'earnest_money_title_company',
  // Block 4 — Inspection
  'inspection_scheduled_at', 'inspection_completed_at', 'inspection_report_received',
  // Block 5 — Appraisal
  'appraisal_ordered_at', 'appraisal_received_at', 'appraisal_value',
  // Block 6 — Title + survey + loan
  'title_commitment_received_at', 'title_commitment_effective_date',
  'survey_ordered_at', 'survey_received_at', 'survey_clear',
  'loan_approval_received_at', 'clear_to_close_at',
  // Block 7 — HOA docs
  'hoa_docs_requested_at', 'hoa_docs_received_at',
  // Block 8 — Post-closing
  'recorded_deed_received_at', 'title_policy_delivered_at',
  'cda_signed_at', 'closed_at',
]);

// Map any commonly-used aliases sent by the wizard or by natural-language
// chat AI (with spaces instead of underscores) to real column names.
const FIELD_ALIASES = {
  down_payment_amt: 'down_payment',
  title_policy_paid_by: 'notes', // no dedicated column; stashed in notes for now
  // Natural-language aliases (spaces)
  'option fee': 'option_fee',
  'option period': 'option_days',
  'option days': 'option_days',
  'sale price': 'sale_price',
  'earnest money': 'earnest_money',
  'closing date': 'closing_date',
  'buyer name': 'buyer_name',
  'seller name': 'seller_name',
  'property address': 'property_address',
};

// Money fields — parsed as numeric before write. Prevents "$200" being stored
// as the string "$200" instead of the number 200 (Bug 3 fix).
const MONEY_FIELDS = new Set([
  'sale_price', 'option_fee', 'earnest_money', 'loan_amount', 'down_payment',
  'option_fee_amount', 'earnest_money_amount', 'appraisal_value',
  'hoa_monthly_dues',
]);

// Integer fields — parsed as integer before write.
const INTEGER_FIELDS = new Set([
  'option_days', 'financing_days', 'bedrooms', 'sqft', 'year_built',
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

/**
 * Update the dossier field in the database.
 * Column names are snake_case in Postgres — the transactions table uses
 * property_address, sale_price, etc. Do NOT camelCase.
 */
async function updateDossierField(dossierId, fieldName, fieldValue) {
  // Try the alias map on both raw and lowercased key so "Option Fee",
  // "option fee", and "option_fee" all resolve to the same column.
  const canonical = FIELD_ALIASES[fieldName]
    || FIELD_ALIASES[String(fieldName || '').toLowerCase()]
    || fieldName;
  if (!ALLOWED_FIELDS.has(canonical)) {
    throw new Error(`Field '${fieldName}' is not writable via this endpoint`);
  }

  // Coerce money and integer fields so "$200" persists as 200, not "$200".
  const typedValue = normalizeNumericValue(canonical, fieldValue);

  // Targeted PATCH — writes ONLY the single field being changed. This is the
  // race-clobber-safe path: concurrent updates to other fields on the same
  // row are preserved (Bug 1 fix).
  const rows = await supabaseCall('PATCH', `transactions?id=eq.${dossierId}`, {
    [canonical]: typedValue,
    updated_at: new Date().toISOString(),
  });

  if (!rows || rows.length === 0) {
    throw new Error('Dossier not found or update failed');
  }

  return { row: rows[0], canonical, typedValue };
}

/**
 * Look up the form_type of the most recent filled PDF for this dossier.
 * The transactions table does NOT store form_type; the documents table does.
 */
async function getMostRecentFormType(dossierId) {
  try {
    const rows = await supabaseCall(
      'GET',
      `documents?transaction_id=eq.${dossierId}&document_type=eq.filled_form&select=form_type,created_at&order=created_at.desc&limit=1`,
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return rows[0].form_type || null;
    }
  } catch (err) {
    console.warn('[dossie-update-and-refill] form_type lookup failed:', err.message);
  }
  return null;
}

/**
 * Fetch the full transaction record (needed for re-fill).
 */
async function getTransaction(dossierId) {
  const rows = await supabaseCall('GET', `transactions?id=eq.${dossierId}&limit=1`);
  if (!rows || rows.length === 0) {
    throw new Error('Dossier not found');
  }
  return rows[0];
}

/**
 * Queue a PDF re-fill by calling the fill-form API.
 * fill-form requires a user JWT, so pass the original caller's Authorization
 * header through instead of the service role key.
 */
async function requeuePdfRefill(dossierId, formType, transaction, userToken) {
  const host = process.env.VERCEL_URL
    ? (process.env.VERCEL_URL.startsWith('http') ? process.env.VERCEL_URL : `https://${process.env.VERCEL_URL}`)
    : 'https://meetdossie.com';
  const fillFormUrl = `${host}/api/fill-form`;

  const res = await fetch(fillFormUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
    },
    body: JSON.stringify({
      transaction_id: dossierId,
      form_type: formType,
      field_values: transaction,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`fill-form requeue failed: ${res.status} ${text.slice(0, 200)}`);
  }

  const result = await res.json();
  return result;
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // Auth: JWT user session
    let authUser;
    try {
      authUser = await verifySupabaseToken(req);
    } catch (err) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }

    const { dossier_id, field_name, field_value } = req.body || {};

    if (!dossier_id || !field_name) {
      return res.status(400).json({
        ok: false,
        error: 'dossier_id and field_name are required',
      });
    }

    // 1. Fetch the full dossier
    const transaction = await getTransaction(dossier_id);

    // 2. Verify user owns this dossier (RLS handles this too, but defensive check)
    if (transaction.user_id !== authUser.userId) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    // 3. Update the field in the database (targeted PATCH, race-safe)
    const { row: updated, canonical, typedValue } = await updateDossierField(
      dossier_id, field_name, field_value,
    );

    // Extract the caller's user JWT — fill-form requires a user token, not the service role.
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    // 4. Queue PDF re-fill if there's an existing filled PDF for this dossier.
    // Re-fetch the full transaction AFTER the update so the fill payload has
    // any concurrent updates from parallel field changes (Bug 1 race fix).
    // form_type isn't on transactions — look it up from the most recent
    // documents row of type 'filled_form'.
    let pdfUrl = null;
    let formTypeUsed = null;
    try {
      formTypeUsed = await getMostRecentFormType(dossier_id);
      if (formTypeUsed && userToken) {
        try {
          const freshTx = await getTransaction(dossier_id);
          const fillResult = await requeuePdfRefill(
            dossier_id,
            formTypeUsed,
            { ...freshTx, [canonical]: typedValue },
            userToken,
          );
          pdfUrl = fillResult.signedUrl || fillResult.pdf_url || null;
        } catch (fillErr) {
          console.error('[dossie-update-and-refill] PDF requeue failed:', fillErr.message);
          // Don't fail the update if PDF requeue fails — the field update succeeded
        }
      }
    } catch (lookupErr) {
      console.warn('[dossie-update-and-refill] form_type lookup failed:', lookupErr.message);
    }

    return res.status(200).json({
      ok: true,
      dossier_id,
      field_name: canonical,
      field_value: typedValue,
      form_type_used: formTypeUsed,
      pdf_url: pdfUrl,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    console.error('[dossie-update-and-refill] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
