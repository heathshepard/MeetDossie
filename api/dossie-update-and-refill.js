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
  return res.json();
}

/**
 * Update the dossier field in the database.
 */
async function updateDossierField(dossierId, fieldName, fieldValue) {
  // Convert snake_case to camelCase for DB column
  const camelField = fieldName
    .split('_')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');

  const rows = await supabaseCall('PATCH', `transactions?id=eq.${dossierId}`, {
    [camelField]: fieldValue,
    updated_at: new Date().toISOString(),
  });

  if (!rows || rows.length === 0) {
    throw new Error('Dossier not found or update failed');
  }

  return rows[0];
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
 */
async function requeuePdfRefill(dossierId, formType, transaction) {
  const fillFormUrl = `${process.env.VERCEL_URL || 'https://meetdossie.com'}/api/fill-form`;

  const res = await fetch(fillFormUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Use service role key to bypass auth (this is internal server-to-server)
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      transaction_id: dossierId,
      form_type: formType,
      field_values: transaction, // Pass full transaction so fill-form can extract fields
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

    // 3. Update the field in the database
    const updated = await updateDossierField(dossier_id, field_name, field_value);

    // 4. Queue PDF re-fill if there's a filled PDF
    // (form_type is stored on the transaction record if it was filled)
    let pdfUrl = null;
    if (transaction.form_type) {
      try {
        const fillResult = await requeuePdfRefill(dossier_id, transaction.form_type, {
          ...transaction,
          [field_name]: field_value,
        });
        pdfUrl = fillResult.signedUrl || null;
      } catch (fillErr) {
        console.error('[dossie-update-and-refill] PDF requeue failed:', fillErr.message);
        // Don't fail the update if PDF requeue fails — the field update succeeded
      }
    }

    return res.status(200).json({
      ok: true,
      dossier_id,
      field_name,
      field_value,
      pdf_url: pdfUrl,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    console.error('[dossie-update-and-refill] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
