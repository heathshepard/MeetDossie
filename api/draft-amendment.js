// Vercel Serverless Function: /api/draft-amendment
// Drafts a TREC 39-10 Amendment to Contract PDF (the current TREC amendment
// form — 39-9 has been superseded by 39-10) by filling the AcroForm fields
// with dossier data plus the agent's amendment input. The filled PDF is
// uploaded to the documents bucket and recorded in both the `documents` and
// `amendments` tables.
//
// POST { transactionId, amendmentType, newValue, notes }
// amendmentType: 'closing_date' | 'option_extension' | 'price_change'
// Authorization: Bearer <supabase user JWT>

const { PDFDocument } = require('pdf-lib');
const TREC_39_10_BASE64 = require('./_assets/trec-amendment-39-11-base64.js');

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+(?:-heathshepard-6590s-projects)?\.vercel\.app$/;

const ALLOWED_TYPES = new Set(['closing_date', 'option_extension', 'price_change', 'repair_items']);

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

async function supabaseRest(path, init) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

async function supabaseStorageUpload(storagePath, buffer, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Storage upload failed (${response.status}): ${text.slice(0, 300)}`);
  }
}

async function supabaseStorageSignedUrl(storagePath, expiresInSeconds = 3600) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;
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
  const p = json.signedURL.startsWith('/') ? json.signedURL : `/${json.signedURL}`;
  return `${SUPABASE_URL}/storage/v1${p}`;
}

async function supabaseStorageRemove(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  }).catch(() => {});
}

function formatLongDate(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

// Formats a date as "Month Day" (no year) for use with TREC form fields that
// have a separate pre-printed "20" prefix before the 2-digit year field.
function formatLongDateNoYear(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`;
}

// Returns the 2-digit year suffix for the TREC "20__" year field.
function formatTwoDigitYear(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})/.exec(String(isoLike));
  if (!m) return '';
  return m[1].slice(2);
}

function formatMoney(value) {
  const n = Number(String(value).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return String(value);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function safeSetText(form, name, value) {
  try {
    const field = form.getTextField(name);
    if (!field) return;
    const max = field.getMaxLength();
    let v = String(value == null ? '' : value);
    if (max && v.length > max) v = v.slice(0, max);
    field.setText(v);
  } catch (e) {
    console.warn('[draft-amendment] could not set field', name, e && e.message);
  }
}

function safeCheck(form, name) {
  try {
    const box = form.getCheckBox(name);
    if (box) box.check();
  } catch (e) {
    console.warn('[draft-amendment] could not check box', name, e && e.message);
  }
}

// Field name aliases — see `scripts/probe-39-10-positions.js` for the visual
// layout of the form. These names come directly from the AcroForm dictionary
// in the published TREC 39-10 PDF; many are auto-generated and unhelpful
// ("undefined", "Text6") so they're documented inline.
const FIELDS = {
  propertyAddress: 'Street Address and City',                       // page top
  finalAcceptanceDate: 'DATE OF FINAL ACCEPTANCE',                  // footer
  // Paragraph 1 — sales price
  salesPriceCheckbox: '1 The Sales Price in Paragraph 3 of the contract is',
  salesPriceCash: 'undefined',           // cash portion line
  salesPriceFinancing: 'undefined_2',    // financing portion
  salesPriceTotal: 'undefined_3',        // total
  // Paragraph 3 — closing date
  closingDateCheckbox: '3 The date in Paragraph 9 of the contract is changed to',
  closingDateText: 'date 5',
  closingDateYearSuffix: '20_25',
  // Paragraph 6 — additional option fee + extension
  optionFeeCheckbox: '6 Buyer has paid Seller an additional Option Fee of',
  optionFeeAmount: 'as follows',                  // dollar amount paid
  optionFeeExtensionDays: 'for an extension of the', // number of days
  optionFeeNewEndDate: 'contract',                // resulting new end date / paragraph reference
  optionFeeCreditYes: 'Fee',                      // "will be credited"
  optionFeeCreditNo: 'Fee 2',                     // "will NOT be credited"
};

async function fillTrec39_10(tx, { amendmentType, newValue, notes }) {
  const pdfBytes = Buffer.from(TREC_39_10_BASE64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();

  // Header — property line
  const propertyLine = [
    tx.property_address || '',
    tx.city_state_zip || '',
  ].filter(Boolean).join(', ');
  if (propertyLine) safeSetText(form, FIELDS.propertyAddress, propertyLine);

  // Footer — DATE OF FINAL ACCEPTANCE is left blank intentionally.
  // The TREC form instructs the broker to fill this in at signing.
  // Auto-filling garbles the pre-printed footer layout.

  if (amendmentType === 'repair_items') {
    // repair_items: newValue is a JSON array of repair item strings OR a
    // comma-separated plain string. notes contains the repair completion deadline.
    let items = [];
    try {
      const parsed = JSON.parse(newValue);
      items = Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch (e) {
      items = String(newValue).split(',').map((s) => s.trim()).filter(Boolean);
    }
    const deadline = notes ? String(notes).slice(0, 40) : '';
    const numbered = items.map((item, i) => `${i + 1}. ${item}`).join('; ');
    const repairText = deadline
      ? `Seller agrees to complete all repairs using licensed contractors by ${deadline}: ${numbered}`
      : `Seller agrees to complete all repairs using licensed contractors: ${numbered}`;

    safeCheck(form, '9 Other Modifications Insert only factual statements and business details applicable to this sale');
    safeSetText(form, 'Text 8', repairText.slice(0, 80));
    if (repairText.length > 80) safeSetText(form, 'Text 9', repairText.slice(80, 160));
    if (repairText.length > 160) safeSetText(form, 'Text 10', repairText.slice(160, 240));
  } else if (amendmentType === 'closing_date') {
    safeCheck(form, FIELDS.closingDateCheckbox);
    // TREC 39-10 closing date section has a "Month Day" text field followed by
    // a pre-printed "20" with a 2-digit year suffix field. Fill them separately
    // so the output reads "August 5, 20 26" (matching the form's pre-printed layout)
    // rather than "August 5, 2026, 20__" (the full date stuffed into the text field
    // leaving the year field blank with its pre-printed "20" hanging).
    safeSetText(form, FIELDS.closingDateText, formatLongDateNoYear(newValue));
    safeSetText(form, FIELDS.closingDateYearSuffix, formatTwoDigitYear(newValue));
  } else if (amendmentType === 'option_extension') {
    // For an extension, the agent supplies the number of additional days.
    // We don't presume an additional option fee — many extensions are written
    // with $0 additional fee — so we leave the dollar field blank for the
    // agent and buyer to negotiate before signing. The days line is the
    // load-bearing field.
    safeCheck(form, FIELDS.optionFeeCheckbox);
    safeSetText(form, FIELDS.optionFeeExtensionDays, `${newValue} day${String(newValue).trim() === '1' ? '' : 's'}`);
  } else if (amendmentType === 'price_change') {
    safeCheck(form, FIELDS.salesPriceCheckbox);
    // The form has three numeric inputs (cash / financing / total). Without a
    // breakdown from the agent we drop the new total into the "total" line
    // and leave the components blank — title can fill them in at signing.
    safeSetText(form, FIELDS.salesPriceTotal, formatMoney(newValue));
  }

  // Notes — appended into the "Other Modifications" overflow lines if present.
  // pdf-lib has no reliable way to text-wrap a string into multi-line fields,
  // so we drop the first ~80 chars into Text 8 and overflow into Text 9/10.
  if (notes) {
    const trimmed = String(notes).slice(0, 240);
    safeCheck(form, '9 Other Modifications Insert only factual statements and business details applicable to this sale');
    safeSetText(form, 'Text 8', trimmed.slice(0, 80));
    if (trimmed.length > 80) safeSetText(form, 'Text 9', trimmed.slice(80, 160));
    if (trimmed.length > 160) safeSetText(form, 'Text 10', trimmed.slice(160, 240));
  }

  // Flatten so the agent can sign / print without an interactive PDF reader
  // re-editing the fields. They still get a clean signable copy.
  try { form.flatten(); } catch (e) { console.warn('[draft-amendment] flatten failed:', e && e.message); }

  return await pdfDoc.save();
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[draft-amendment] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Amendment drafting is not configured.' });
    return;
  }

  let storagePathForCleanup = null;

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'draft-amendment', 30, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    // Accept BOTH camelCase (legacy) and snake_case (Talk-to-Dossie chat dispatcher).
    const transactionId = sanitizeString(body.transactionId || body.transaction_id, { maxLength: 200 });
    const amendmentType = sanitizeString(body.amendmentType || body.amendment_type, { maxLength: 50 });
    const newValueRaw = body.newValue != null ? body.newValue : body.new_value;
    const notes = sanitizeString(body.notes, { maxLength: 500 });

    if (!transactionId) throw new ValidationError('transactionId is required.');
    if (!amendmentType) throw new ValidationError('amendmentType is required.');
    if (!ALLOWED_TYPES.has(amendmentType)) {
      throw new ValidationError('amendmentType must be one of: closing_date, option_extension, price_change, repair_items.');
    }
    const newValue = sanitizeString(newValueRaw == null ? '' : String(newValueRaw), { maxLength: 200 });
    if (!newValue) throw new ValidationError('newValue is required.');

    // Owner-scoped transaction fetch — refuses to draft on someone else's deal.
    const safeUid = encodeURIComponent(userId);
    const safeTx = encodeURIComponent(transactionId);
    const txResp = await supabaseRest(
      `transactions?id=eq.${safeTx}&user_id=eq.${safeUid}&select=id,property_address,city_state_zip,buyer_name,seller_name,contract_effective_date,closing_date,option_days,sale_price&limit=1`,
      { method: 'GET' },
    );
    if (!txResp.ok) {
      const text = await txResp.text().catch(() => '');
      throw new Error(`transaction fetch failed (${txResp.status}): ${text.slice(0, 200)}`);
    }
    const txRows = await txResp.json();
    const tx = (Array.isArray(txRows) && txRows[0]) || null;
    if (!tx) {
      return res.status(404).json({ ok: false, error: 'Dossier not found.' });
    }

    // Capture the original value for the audit row before we overwrite it.
    let originalValue = null;
    if (amendmentType === 'closing_date') originalValue = tx.closing_date || null;
    else if (amendmentType === 'option_extension') originalValue = tx.option_days != null ? String(tx.option_days) : null;
    else if (amendmentType === 'price_change') originalValue = tx.sale_price != null ? String(tx.sale_price) : null;

    // Fill the form.
    const filledBytes = await fillTrec39_10(tx, { amendmentType, newValue, notes });
    const buffer = Buffer.from(filledBytes);

    // Upload to storage.
    const ts = Date.now();
    const safeName = `amendment-${amendmentType}-${ts}.pdf`;
    const storagePath = `${userId}/${transactionId}/${ts}-${safeName}`;
    storagePathForCleanup = storagePath;
    await supabaseStorageUpload(storagePath, buffer, 'application/pdf');

    // Insert documents row.
    const docResp = await supabaseRest('documents', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        transaction_id: transactionId,
        user_id: userId,
        file_name: safeName,
        file_type: 'application/pdf',
        document_type: 'amendment',
        storage_path: storagePath,
        file_size: buffer.length,
      }),
    });
    if (!docResp.ok) {
      const text = await docResp.text().catch(() => '');
      throw new Error(`documents insert failed (${docResp.status}): ${text.slice(0, 300)}`);
    }
    const docRows = await docResp.json();
    const docRow = Array.isArray(docRows) ? docRows[0] : docRows;

    // Insert amendments row.
    const amendResp = await supabaseRest('amendments', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        transaction_id: transactionId,
        user_id: userId,
        amendment_type: amendmentType,
        original_value: originalValue,
        new_value: newValue,
        notes: notes || null,
        storage_path: storagePath,
        status: 'draft',
      }),
    });
    if (!amendResp.ok) {
      const text = await amendResp.text().catch(() => '');
      // Don't roll the document back — the agent should still have the filled PDF.
      console.error('[draft-amendment] amendments insert failed:', text);
    }
    const amendRows = amendResp.ok ? await amendResp.json() : null;
    const amendRow = Array.isArray(amendRows) ? amendRows[0] : amendRows;

    // Auto-update the dossier fields so the agent's pipeline view reflects
    // the amended terms. Owner-scoped (id + user_id) so a malformed token
    // can't touch another agent's deal. We log but don't fail the request
    // if this update errors — the PDF + amendments audit row are the
    // load-bearing artifacts; the dossier write is a convenience sync.
    try {
      let patchBody = null;
      if (amendmentType === 'closing_date') {
        patchBody = { closing_date: newValue };
      } else if (amendmentType === 'price_change') {
        const numericPrice = Number(String(newValue).replace(/[^0-9.]/g, ''));
        if (Number.isFinite(numericPrice)) patchBody = { sale_price: numericPrice };
      } else if (amendmentType === 'option_extension') {
        // Extension days are additive — buyer negotiated N more days on top
        // of the existing option period. Treat the input as a day count and
        // add to the current option_days (defaulting to 0 if unset).
        const extDays = parseInt(String(newValue).replace(/[^0-9]/g, ''), 10);
        if (Number.isFinite(extDays)) {
          const currentDays = parseInt(tx.option_days, 10);
          const total = (Number.isFinite(currentDays) ? currentDays : 0) + extDays;
          patchBody = { option_days: total };
        }
      }

      if (patchBody) {
        const patchResp = await supabaseRest(
          `transactions?id=eq.${safeTx}&user_id=eq.${safeUid}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify(patchBody),
          },
        );
        if (!patchResp.ok) {
          const text = await patchResp.text().catch(() => '');
          console.error('[draft-amendment] transactions auto-update failed:', text);
        }
      }
    } catch (e) {
      console.error('[draft-amendment] transactions auto-update threw:', e && e.message);
    }

    const signedUrl = await supabaseStorageSignedUrl(storagePath, 3600);

    return res.status(200).json({
      ok: true,
      document: {
        id: docRow && docRow.id ? docRow.id : null,
        transactionId,
        fileName: safeName,
        fileType: 'application/pdf',
        documentType: 'amendment',
        storagePath,
        signedUrl,
        fileSize: buffer.length,
        createdAt: docRow && docRow.created_at ? docRow.created_at : null,
      },
      amendment: amendRow || {
        transaction_id: transactionId,
        user_id: userId,
        amendment_type: amendmentType,
        original_value: originalValue,
        new_value: newValue,
        notes: notes || null,
        storage_path: storagePath,
        status: 'draft',
      },
    });
  } catch (error) {
    if (storagePathForCleanup && error && /documents insert failed/i.test(String(error.message))) {
      await supabaseStorageRemove(storagePathForCleanup);
    }
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many amendment drafts. Try again later.' });
    }
    console.error('[draft-amendment] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not draft that amendment. Try again.' });
  }
};
