// Vercel Serverless Function: /api/fill-form
// Fills a TREC form PDF with field values and uploads to Supabase Storage.
//
// POST { transaction_id, trec_number, field_values: { buyer_name, seller_name, ... } }
// trec_number: '20-16' | '40-9' | 'hoa-addendum' | 'lead-paint'
// Authorization: Bearer <supabase user JWT>
//
// Returns: { ok: true, documentId, storagePath, signedUrl }

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

// Base64-embedded TREC forms — same pattern as api/draft-amendment.js.
// These are the fillable PDFs from the TREC Base folder, encoded at build time.
// Using embedded base64 avoids external fetches at runtime (Vercel edge-safe).
let TREC_RESALE_BASE64, TREC_FINANCING_BASE64;
try { TREC_RESALE_BASE64 = require('./_assets/trec-resale-base64.js'); } catch (e) { TREC_RESALE_BASE64 = null; }
try { TREC_FINANCING_BASE64 = require('./_assets/trec-financing-base64.js'); } catch (e) { TREC_FINANCING_BASE64 = null; }

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

// ---------------------------------------------------------------------------
// TREC form source PDFs — stored in Supabase Storage 'form-templates' bucket.
// These are the canonical fillable PDFs uploaded from the TREC Base folder.
// If not in Supabase storage yet, fall back to TREC.texas.gov URLs.
// ---------------------------------------------------------------------------
const FORM_CONFIGS = {
  '20-16': {
    name: 'One to Four Family Residential Contract (Resale)',
    short_name: 'TREC 20-16 Contract',
    storagePath: 'form-templates/trec-20-16-resale.pdf',
    fallbackUrl: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/20-16.pdf',
    fieldType: 'acroform',
    base64Asset: TREC_RESALE_BASE64,  // embedded base64 from _assets/trec-resale-base64.js
  },
  '40-9': {
    name: 'Third Party Financing Addendum',
    short_name: 'Third Party Financing Addendum',
    storagePath: 'form-templates/trec-40-9-financing.pdf',
    fallbackUrl: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/40-9.pdf',
    fieldType: 'acroform',
    base64Asset: TREC_FINANCING_BASE64,  // embedded base64 from _assets/trec-financing-base64.js
  },
  'hoa-addendum': {
    name: 'Addendum for Property Subject to Mandatory Membership in Property Owners Association',
    short_name: 'HOA Addendum',
    storagePath: 'form-templates/trec-hoa-addendum.pdf',
    fallbackUrl: 'https://www.trec.texas.gov/sites/default/files/pdf-forms/36-8.pdf',
    fieldType: 'acroform',
    base64Asset: null,  // no embedded asset yet; falls back to Supabase Storage or URL
  },
  'lead-paint': {
    name: 'Lead-Based Paint Addendum',
    short_name: 'Lead Paint Disclosure',
    storagePath: 'form-templates/lead-paint-addendum.pdf',
    fallbackUrl: null,
    fieldType: 'acroform',
    base64Asset: null,  // no embedded asset yet; falls back to Supabase Storage
  },
};

const ALLOWED_TREC_NUMBERS = new Set(Object.keys(FORM_CONFIGS));

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true; // Same-origin request — always allow
  let allowOrigin = null;
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

// ---------------------------------------------------------------------------
// Supabase helpers (identical pattern to draft-amendment.js)
// ---------------------------------------------------------------------------
async function supabaseRest(path_part, init) {
  const url = `${SUPABASE_URL}/rest/v1/${path_part}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

async function supabaseStorageDownload(storagePath, bucketName) {
  const url = `${SUPABASE_URL}/storage/v1/object/${bucketName}/${storagePath}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Storage download failed (${response.status}): ${text.slice(0, 200)}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
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

// ---------------------------------------------------------------------------
// Safe field setters — same pattern as draft-amendment.js
// ---------------------------------------------------------------------------
function safeSetText(form, name, value) {
  try {
    const field = form.getTextField(name);
    if (!field) return;
    const max = field.getMaxLength();
    let v = String(value == null ? '' : value);
    if (max && v.length > max) v = v.slice(0, max);
    field.setText(v);
  } catch (e) {
    console.warn('[fill-form] could not set field', name, ':', e && e.message);
  }
}

function safeCheck(form, name) {
  try {
    const box = form.getCheckBox(name);
    if (box) box.check();
  } catch (e) {
    console.warn('[fill-form] could not check box', name, ':', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function formatMoney(value) {
  const n = Number(String(value || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return String(value || '');
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatLongDateNoYear(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`;
}

function formatTwoDigitYear(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})/.exec(String(isoLike));
  if (!m) return '';
  return m[1].slice(2);
}

function formatDate(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

// ---------------------------------------------------------------------------
// PDF FILL FUNCTIONS — one per form type
// ---------------------------------------------------------------------------

// TREC 20-16: One-to-Four Family Residential Contract (Resale)
async function fill2016(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PARTIES
  if (fv.buyer_name) safeSetText(form, '1 PARTIES The parties to this contract are', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'Seller and', fv.seller_name);

  // PROPERTY
  if (fv.property_address) {
    safeSetText(form, 'Texas known as', fv.property_address);
    safeSetText(form, 'Address of Property', fv.property_address);
    safeSetText(form, 'Address of Property_2', fv.property_address);
    safeSetText(form, 'Addr of Prop', fv.property_address);
  }
  if (fv.city) safeSetText(form, 'Addition City of', fv.city);
  if (fv.county) safeSetText(form, 'County of', fv.county);
  if (fv.legal_description) safeSetText(form, 'A LAND Lot', fv.legal_description);

  // SALES PRICE
  if (fv.purchase_price != null) {
    const priceStr = formatMoney(fv.purchase_price);
    // Paragraph 3B — "Sum of all financing" financing checkbox + total
    safeCheck(form, 'B Sum of all financing described in the attached');
    // undefined_4 = total sales price
    safeSetText(form, 'undefined_4', priceStr);
    // Cash portion (down payment) if we know it
    if (fv.down_payment_amt != null) {
      safeSetText(form, 'undefined_2', formatMoney(fv.down_payment_amt));
    }
    // Financing amount
    if (fv.loan_amount != null) {
      safeSetText(form, 'undefined_3', formatMoney(fv.loan_amount));
    }
  }

  // EARNEST MONEY
  if (fv.earnest_money != null) {
    safeSetText(form, 'earnest money of', formatMoney(fv.earnest_money));
  }

  // OPTION PERIOD
  if (fv.option_fee != null) {
    safeSetText(form, 'Option Fee in the form of', formatMoney(fv.option_fee));
  }

  // TITLE COMPANY
  if (fv.title_company) {
    safeSetText(form, 'insurance Title Policy issued by', fv.title_company);
    safeSetText(form, 'Escrow Agent', fv.title_company);
  }

  // CLOSING DATE — Paragraph 9A
  // Field "A The closing of the sale will be on or before" = "Month Day"
  // Field "20" = 2-digit year
  if (fv.closing_date) {
    safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(fv.closing_date));
    safeSetText(form, '20', formatTwoDigitYear(fv.closing_date));
  }

  // PROPERTY CONDITION — default "As Is"
  safeCheck(form, '1 Buyer accepts the Property As Is');

  // HOA
  if (fv.hoa_exists === true) {
    safeCheck(form, 'is');  // Property IS subject to mandatory HOA
  } else {
    safeCheck(form, 'is not');  // Property is NOT subject to mandatory HOA
  }

  // ADDENDA CHECKBOXES
  if (fv.financing_type && fv.financing_type !== 'cash') {
    safeCheck(form, 'Third Party Financing Addendum');
  }
  if (fv.hoa_exists === true) {
    safeCheck(form, 'Addendum for Property Subject to');
  }

  // LISTING AGENT (from profile)
  if (fv.listing_agent_name) {
    safeSetText(form, 'Listing Associates Name', fv.listing_agent_name);
    safeSetText(form, 'List Assoc Name', fv.listing_agent_name);
  }
  if (fv.listing_broker_firm) {
    safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm);
  }
  if (fv.listing_agent_phone) {
    safeSetText(form, 'Phone_3', fv.listing_agent_phone);
  }
  if (fv.listing_agent_email) {
    safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email);
  }
  if (fv.listing_agent_license) {
    safeSetText(form, 'License No_5', fv.listing_agent_license);
  }

  return pdfDoc;
}

// TREC 40-9: Third Party Financing Addendum
async function fill409(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // HEADER
  const addrLine = [fv.property_address, fv.city].filter(Boolean).join(', ');
  if (addrLine) {
    safeSetText(form, 'Street Address and City', addrLine);
    safeSetText(form, 'Address of Property', addrLine);
  }

  // FINANCING TYPE
  const ft = String(fv.financing_type || '').toLowerCase();
  if (ft === 'conventional') {
    safeCheck(form, '1 Conventional Financing');
    safeCheck(form, 'a A first mortgage loan in the principal amount of');
    // Buyer approval contingency
    safeCheck(form, 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer');
    // Fill principal amount
    if (fv.loan_amount != null) {
      safeSetText(form, 'any financed PMI premium due in full in 1', formatMoney(fv.loan_amount));
    }
  } else if (ft === 'fha') {
    safeCheck(form, '3 FHA Insured Financing A Section');
    safeCheck(form, 'a A first mortgage loan in the principal amount of');
    safeCheck(form, 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer');
    if (fv.loan_amount != null) {
      // FHA amount goes in separate field
      safeSetText(form, 'excluding any financed MIP amortizable monthly for not less', formatMoney(fv.loan_amount));
    }
  } else if (ft === 'va') {
    safeCheck(form, '4 VA Guaranteed Financing A VA guaranteed loan of not less than');
    safeCheck(form, 'a A first mortgage loan in the principal amount of');
    safeCheck(form, 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer');
    if (fv.loan_amount != null) {
      safeSetText(form, 'excluding any financed Funding Fee amortizable monthly for not less than', formatMoney(fv.loan_amount));
    }
  } else if (ft === 'usda') {
    safeCheck(form, '5 USDA Guaranteed Financing A USDAguaranteed loan of not less than');
    safeCheck(form, 'a A first mortgage loan in the principal amount of');
    safeCheck(form, 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer');
  }

  return pdfDoc;
}

// HOA Addendum
async function fillHoaAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  const addrLine = [fv.property_address, fv.city].filter(Boolean).join(', ');
  if (addrLine) safeSetText(form, 'Street Address and City', addrLine);
  if (fv.hoa_name) safeSetText(form, 'Name of Property Owners Association Association and Phone Number', fv.hoa_name);
  if (fv.hoa_phone) safeSetText(form, 'Name of Property Owners Association Association and Phone Number',
    `${fv.hoa_name || ''}  ${fv.hoa_phone}`);

  // Default: buyer doesn't require subdivision info unless told otherwise
  safeCheck(form, '4Buyer does not require delivery of the Subdivision Information');

  return pdfDoc;
}

// Lead-Based Paint Addendum
async function fillLeadPaint(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  const addrLine = [fv.property_address, fv.city].filter(Boolean).join(', ');
  if (addrLine) safeSetText(form, 'Street Address and City', addrLine);

  // Default: seller has no knowledge of lead (agent must update if seller does)
  safeCheck(form, 'Check Box7');  // Seller has no knowledge
  safeCheck(form, 'Check Box9');  // No records
  safeCheck(form, 'Check Box11'); // Buyer received pamphlet
  safeCheck(form, 'Check Box12'); // Buyer has 10-day inspection right

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// Get blank PDF bytes
// Priority: 1) embedded base64 asset, 2) Supabase Storage, 3) TREC URL
// ---------------------------------------------------------------------------
async function getBlankPdf(formConfig) {
  // 1. Embedded base64 asset (fastest — no network needed)
  if (formConfig.base64Asset) {
    try {
      const bytes = Buffer.from(formConfig.base64Asset, 'base64');
      if (bytes.length > 1000) {
        console.log('[fill-form] loaded from embedded base64:', formConfig.storagePath);
        return bytes;
      }
    } catch (e) {
      console.warn('[fill-form] base64 decode failed:', e.message);
    }
  }

  // 2. Supabase Storage form-templates bucket
  try {
    const bytes = await supabaseStorageDownload(formConfig.storagePath, 'form-templates');
    if (bytes && bytes.length > 1000) {
      console.log('[fill-form] loaded from form-templates storage:', formConfig.storagePath);
      return bytes;
    }
  } catch (e) {
    console.log('[fill-form] not in form-templates storage, will try URL:', e.message);
  }

  // 3. Fall back to TREC URL
  if (formConfig.fallbackUrl) {
    const resp = await fetch(formConfig.fallbackUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Dossie/1.0)' },
    });
    if (!resp.ok) throw new Error(`Could not download form from ${formConfig.fallbackUrl} (${resp.status})`);
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }

  throw new Error(`No source available for form ${formConfig.storagePath}`);
}

// ---------------------------------------------------------------------------
// Main fill orchestrator
// ---------------------------------------------------------------------------
async function fillForm(trecNumber, fieldValues) {
  const config = FORM_CONFIGS[trecNumber];
  if (!config) throw new ValidationError(`Unknown form: ${trecNumber}`);

  const pdfBytes = await getBlankPdf(config);
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (e) {
    throw new Error(`Failed to load PDF for ${trecNumber}: ${e.message}`);
  }

  const fv = fieldValues || {};

  switch (trecNumber) {
    case '20-16':   await fill2016(pdfDoc, fv); break;
    case '40-9':    await fill409(pdfDoc, fv); break;
    case 'hoa-addendum': await fillHoaAddendum(pdfDoc, fv); break;
    case 'lead-paint':   await fillLeadPaint(pdfDoc, fv); break;
    default:
      throw new ValidationError(`No fill handler for form ${trecNumber}`);
  }

  // Flatten so the agent can print/send without interactive editing
  try {
    pdfDoc.getForm().flatten();
  } catch (e) {
    console.warn('[fill-form] flatten failed:', e && e.message);
  }

  return await pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
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
    console.error('[fill-form] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Fill-form is not configured.' });
    return;
  }

  let storagePathForCleanup = null;

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'fill-form', 20, 60 * 60 * 1000); // 20/hour

    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    const trecNumber = sanitizeString(body.trec_number, { maxLength: 50 });
    const fieldValues = (body.field_values && typeof body.field_values === 'object') ? body.field_values : {};

    if (!transactionId) throw new ValidationError('transaction_id is required.');
    if (!trecNumber) throw new ValidationError('trec_number is required.');
    if (!ALLOWED_TREC_NUMBERS.has(trecNumber)) {
      throw new ValidationError(`trec_number must be one of: ${[...ALLOWED_TREC_NUMBERS].join(', ')}`);
    }

    // Verify user owns the transaction
    const safeUid = encodeURIComponent(userId);
    const safeTx = encodeURIComponent(transactionId);
    const txResp = await supabaseRest(
      `transactions?id=eq.${safeTx}&user_id=eq.${safeUid}&select=id,property_address,city_state_zip,buyer_name,seller_name,sale_price,earnest_money,option_fee,closing_date&limit=1`,
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

    // Merge transaction data with agent-supplied field values
    // Agent-supplied values take precedence over transaction record
    const mergedFields = {
      buyer_name:       tx.buyer_name || null,
      seller_name:      tx.seller_name || null,
      property_address: tx.property_address || null,
      city:             tx.city_state_zip || null,
      purchase_price:   tx.sale_price || null,
      earnest_money:    tx.earnest_money || null,
      option_fee:       tx.option_fee || null,
      closing_date:     tx.closing_date || null,
      ...fieldValues,  // agent-supplied overrides
    };

    // Fill the form
    console.log('[fill-form] filling', trecNumber, 'for tx', transactionId);
    const filledBytes = await fillForm(trecNumber, mergedFields);
    const buffer = Buffer.from(filledBytes);

    // Upload to Supabase Storage
    const ts = Date.now();
    const config = FORM_CONFIGS[trecNumber];
    const safeName = `filled-${trecNumber}-${ts}.pdf`;
    const storagePath = `${userId}/${transactionId}/${safeName}`;
    storagePathForCleanup = storagePath;
    await supabaseStorageUpload(storagePath, buffer, 'application/pdf');

    // Insert documents row
    const docResp = await supabaseRest('documents', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        transaction_id: transactionId,
        user_id: userId,
        file_name: `${config.short_name}.pdf`,
        file_type: 'application/pdf',
        document_type: 'filled_form',
        storage_path: storagePath,
        file_size: buffer.length,
        status: 'filled',
      }),
    });
    if (!docResp.ok) {
      const text = await docResp.text().catch(() => '');
      throw new Error(`documents insert failed (${docResp.status}): ${text.slice(0, 300)}`);
    }
    const docRows = await docResp.json();
    const docRow = Array.isArray(docRows) ? docRows[0] : docRows;

    const signedUrl = await supabaseStorageSignedUrl(storagePath, 3600);

    return res.status(200).json({
      ok: true,
      documentId: docRow && docRow.id ? docRow.id : null,
      storagePath,
      signedUrl,
      fileName: `${config.short_name}.pdf`,
      formName: config.name,
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
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[fill-form] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not fill that form. Try again.' });
  }
};
