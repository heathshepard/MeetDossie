// Vercel Serverless Function: /api/fill-form
// Fills a TREC form PDF with field values and uploads to Supabase Storage.
// PDF source: embedded base64 assets (same pattern as draft-amendment.js).
// Field names verified against actual AcroForm field inspection of each PDF.
//
// POST { transaction_id, form_type, field_values }
// form_type: resale-contract | financing-addendum | termination-notice
// (Amendment is handled by /api/draft-amendment)
//
// Authorization: Bearer <supabase user JWT>
// Returns: { ok: true, documentId, storagePath, signedUrl, fileName, formName }

const { PDFDocument } = require('pdf-lib');

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

// Form configs -- base64 assets embedded at deploy time.
// Field names from actual AcroForm inspection of each PDF (see scripts/inspect_resale_fields.py).
const FORM_CONFIGS = {
  'resale-contract': {
    name: 'One to Four Family Residential Contract (Resale)',
    shortName: 'TREC-Resale-Contract',
    getBase64: function() { return require('./_assets/trec-resale-base64.js'); },
    documentType: 'resale_contract',
  },
  'financing-addendum': {
    name: 'Third Party Financing Addendum (TREC 40)',
    shortName: 'TREC-Financing-Addendum',
    getBase64: function() { return require('./_assets/trec-financing-base64.js'); },
    documentType: 'financing_addendum',
  },
  'termination-notice': {
    name: 'Notice of Sellers Termination of Contract',
    shortName: 'TREC-Termination-Notice',
    getBase64: function() { return require('./_assets/trec-termination-base64.js'); },
    documentType: 'termination_notice',
  },
  'wire-fraud-warning': {
    name: 'Wire Fraud Warning (TAR 2517)',
    shortName: 'TAR-Wire-Fraud-Warning',
    getBase64: function() { return require('./_assets/tar-wire-fraud-base64.js'); },
    documentType: 'wire_fraud_warning',
  },
};

const ALLOWED_FORM_TYPES = new Set(Object.keys(FORM_CONFIGS));

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
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

async function supabaseRest(pathPart, init) {
  const url = SUPABASE_URL + '/rest/v1/' + pathPart;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

async function supabaseStorageUpload(storagePath, buffer, contentType) {
  const url = SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text().catch(function() { return ''; });
    throw new Error('Storage upload failed (' + response.status + '): ' + text.slice(0, 300));
  }
}

async function supabaseStorageSignedUrl(storagePath, expiresInSeconds) {
  if (expiresInSeconds === undefined) expiresInSeconds = 3600;
  const url = SUPABASE_URL + '/storage/v1/object/sign/' + BUCKET + '/' + storagePath;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });
  if (!response.ok) return null;
  const json = await response.json().catch(function() { return null; });
  if (!json || !json.signedURL) return null;
  const p = json.signedURL.startsWith('/') ? json.signedURL : '/' + json.signedURL;
  return SUPABASE_URL + '/storage/v1' + p;
}

async function supabaseStorageRemove(storagePath) {
  const url = SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + storagePath;
  await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    },
  }).catch(function() {});
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
    console.warn('[fill-form] could not set text field', JSON.stringify(name), ':', e && e.message);
  }
}

function safeCheck(form, name) {
  try {
    const box = form.getCheckBox(name);
    if (box) box.check();
  } catch (e) {
    console.warn('[fill-form] could not check box', JSON.stringify(name), ':', e && e.message);
  }
}

// "2026-05-28" -> "05/28/2026"
function formatDate(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  return m[2] + '/' + m[3] + '/' + m[1];
}

// "2026-05-28" -> "May 28"
function formatLongDateNoYear(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLike));
  if (!m) return String(isoLike);
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return months[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10);
}

// "2026-05-28" -> "26"
function formatTwoDigitYear(isoLike) {
  if (!isoLike) return '';
  const m = /^(\d{4})/.exec(String(isoLike));
  if (!m) return '';
  return m[1].slice(2);
}

function formatMoney(value) {
  const n = Number(String(value || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return String(value || '');
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// RESALE CONTRACT (TREC 20-16/20-17)
// Ported from RESALE_FIELD_MAP + RESALE_BUTTON_MAP in document_field_maps.py
// Verified against AcroForm inspection of One-to-Four-Family-Residential-Contract-Resale.pdf
// ---------------------------------------------------------------------------
async function fillResaleContract(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  if (fv.buyer_name) safeSetText(form, '1 PARTIES The parties to this contract are', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'Seller and', fv.seller_name);

  const addr = fv.property_address || '';
  if (addr) {
    safeSetText(form, 'Texas known as', addr);
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Address of Property_2', addr);
    safeSetText(form, 'Addr of Prop', addr);
  }
  if (fv.county) safeSetText(form, 'County of', fv.county);
  if (fv.city_state_zip) safeSetText(form, 'Addition City of', fv.city_state_zip);
  if (fv.legal_description) safeSetText(form, 'A LAND Lot', fv.legal_description);

  const isFinanced = fv.loan_amount && Number(fv.loan_amount) > 0;
  if (isFinanced) safeCheck(form, 'B Sum of all financing described in the attached');
  if (fv.sale_price != null && fv.sale_price !== '') safeSetText(form, 'undefined_4', formatMoney(fv.sale_price));
  if (fv.down_payment_amt != null && fv.down_payment_amt !== '') safeSetText(form, 'undefined_2', formatMoney(fv.down_payment_amt));
  if (fv.loan_amount != null && fv.loan_amount !== '') safeSetText(form, 'undefined_3', formatMoney(fv.loan_amount));

  if (fv.earnest_money != null && fv.earnest_money !== '') safeSetText(form, 'earnest money of', formatMoney(fv.earnest_money));
  if (fv.option_fee != null && fv.option_fee !== '') safeSetText(form, 'Option Fee in the form of', formatMoney(fv.option_fee));

  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-') ? formatDate(fv.contract_effective_date) : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }

  if (fv.closing_date) {
    const cd = String(fv.closing_date);
    if (cd.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd));
      safeSetText(form, '20', formatTwoDigitYear(cd));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd);
    }
  }

  if (fv.title_company) {
    safeSetText(form, 'insurance Title Policy issued by', fv.title_company);
    safeSetText(form, 'Escrow Agent', fv.title_company);
  }

  if (isFinanced || fv.financing_addendum === true) safeCheck(form, 'Third Party Financing Addendum');

  if (fv.hoa_exists === true) {
    safeCheck(form, 'is');
    safeCheck(form, 'Addendum for Property Subject to');
  } else {
    safeCheck(form, 'is not');
  }

  safeCheck(form, '1 Buyer accepts the Property As Is');

  if (fv.listing_agent_name) {
    safeSetText(form, 'Listing Associates Name', fv.listing_agent_name);
    safeSetText(form, 'List Assoc Name', fv.listing_agent_name);
  }
  if (fv.listing_broker_firm) safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm);
  if (fv.listing_agent_phone) safeSetText(form, 'Phone_3', fv.listing_agent_phone);
  if (fv.listing_agent_email) safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email);
  if (fv.listing_agent_license) safeSetText(form, 'License No_5', fv.listing_agent_license);

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// THIRD PARTY FINANCING ADDENDUM (TREC 40-9/40-11)
// Ported from FINANCING_FIELD_MAP + FINANCING_BUTTON_MAP in document_field_maps.py
// Verified against AcroForm inspection of Third-Party-Financing-Addendum-TREC-40.pdf
// Key: 'a A first mortgage loan in the principal amount of' is /Btn (checkbox), not text.
// ---------------------------------------------------------------------------
async function fillFinancingAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  const propertyFull = fv.property_full || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (propertyFull) safeSetText(form, 'Street Address and City', propertyFull);

  const ft = String(fv.financing_type || '').toLowerCase();

  if (ft && ft !== 'cash') {
    safeCheck(form, 'a A first mortgage loan in the principal amount of');
    safeCheck(form, 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer');
  }

  if (ft === 'conventional' || fv.financing_conventional === true) {
    safeCheck(form, '1 Conventional Financing');
    if (fv.loan_amount != null && fv.loan_amount !== '') {
      safeSetText(form, 'any financed PMI premium due in full in 1', formatMoney(fv.loan_amount));
    }
  } else if (ft === 'fha' || fv.financing_fha === true) {
    safeCheck(form, '3 FHA Insured Financing A Section');
    if (fv.loan_amount != null && fv.loan_amount !== '') {
      safeSetText(form, 'excluding any financed MIP amortizable monthly for not less', formatMoney(fv.loan_amount));
    }
  } else if (ft === 'va' || fv.financing_va === true) {
    safeCheck(form, '4 VA Guaranteed Financing A VA guaranteed loan of not less than');
    if (fv.loan_amount != null && fv.loan_amount !== '') {
      safeSetText(form, 'excluding any financed Funding Fee amortizable monthly for not less than', formatMoney(fv.loan_amount));
    }
  } else if (ft === 'usda') {
    safeCheck(form, '5 USDA Guaranteed Financing A USDAguaranteed loan of not less than');
  }

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// NOTICE OF SELLERS TERMINATION OF CONTRACT
// Ported from TERMINATION_FIELD_MAP in document_field_maps.py
// Verified against AcroForm inspection of Notice-of-Sellers-Termination-of-Contract.pdf
// ---------------------------------------------------------------------------
async function fillTerminationNotice(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  const propertyFull = fv.property_full || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (propertyFull) safeSetText(form, 'Street Address and City', propertyFull);

  if (fv.seller_name) safeSetText(form, 'BETWEEN THE UNDERSIGNED SELLER AND', fv.seller_name);
  if (fv.buyer_name) safeSetText(form, 'BUYER', fv.buyer_name);

  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-') ? formatDate(fv.contract_effective_date) : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }

  const today = new Date().toISOString().slice(0, 10);
  safeSetText(form, 'Date_2', formatDate(today));

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// WIRE FRAUD WARNING (TAR 2517)
// Fields: buyer_name, buyer_email, property_address, agent_name, agent_license, delivery_date
// Note: TAR 2517 base64 PDF must be populated in _assets/tar-wire-fraud-base64.js
// before this form will produce output. The field names below are best-guess —
// adjust after inspecting the actual AcroForm fields in TAR 2517 if needed.
// ---------------------------------------------------------------------------
async function fillWireFraudWarning(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // Best-effort field fills — TAR 2517 AcroForm fields may differ from these names.
  // After obtaining the real PDF, run scripts/inspect_resale_fields.py to get exact names.
  const today = fv.delivery_date || new Date().toISOString().slice(0, 10);

  if (fv.buyer_name) safeSetText(form, 'Buyer Name', fv.buyer_name);
  if (fv.buyer_email) safeSetText(form, 'Buyer Email', fv.buyer_email);
  if (fv.property_address) safeSetText(form, 'Property Address', fv.property_address);
  if (fv.agent_name) safeSetText(form, 'Agent Name', fv.agent_name);
  if (fv.agent_license) safeSetText(form, 'License No', fv.agent_license);
  if (today) safeSetText(form, 'Date', formatDate(today));

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// Load base64 PDF and return filled bytes
// ---------------------------------------------------------------------------
async function fillForm(formType, fieldValues) {
  const config = FORM_CONFIGS[formType];
  if (!config) throw new ValidationError('Unknown form_type: ' + formType);

  const base64 = config.getBase64();
  const pdfBytes = Buffer.from(base64, 'base64');

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (e) {
    throw new Error('Failed to load PDF for ' + formType + ': ' + (e && e.message));
  }

  const fv = fieldValues || {};

  switch (formType) {
    case 'resale-contract':    await fillResaleContract(pdfDoc, fv); break;
    case 'financing-addendum': await fillFinancingAddendum(pdfDoc, fv); break;
    case 'termination-notice': await fillTerminationNotice(pdfDoc, fv); break;
    case 'wire-fraud-warning': await fillWireFraudWarning(pdfDoc, fv); break;
    default:
      throw new ValidationError('No fill handler for form_type: ' + formType);
  }

  try { pdfDoc.getForm().flatten(); } catch (e) { console.warn('[fill-form] flatten failed:', e && e.message); }

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
    await checkRateLimit(ip, 'fill-form', 20, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    body = body || {};

    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    const formType = sanitizeString(body.form_type, { maxLength: 50 });
    const fieldValues = (body.field_values && typeof body.field_values === 'object') ? body.field_values : {};

    if (!transactionId) throw new ValidationError('transaction_id is required.');
    if (!formType) throw new ValidationError('form_type is required.');
    if (!ALLOWED_FORM_TYPES.has(formType)) {
      throw new ValidationError('form_type must be one of: ' + [...ALLOWED_FORM_TYPES].join(', '));
    }

    const safeUid = encodeURIComponent(userId);
    const safeTx = encodeURIComponent(transactionId);
    const txResp = await supabaseRest(
      'transactions?id=eq.' + safeTx + '&user_id=eq.' + safeUid + '&select=id,property_address,city_state_zip,buyer_name,seller_name,sale_price,earnest_money,option_fee,option_days,closing_date,contract_effective_date,county,legal_description,title_company,loan_amount,financing_type,lender_name&limit=1',
      { method: 'GET' },
    );
    if (!txResp.ok) {
      const text = await txResp.text().catch(function() { return ''; });
      throw new Error('transaction fetch failed (' + txResp.status + '): ' + text.slice(0, 200));
    }
    const txRows = await txResp.json();
    const tx = (Array.isArray(txRows) && txRows[0]) || null;
    if (!tx) {
      return res.status(404).json({ ok: false, error: 'Dossier not found.' });
    }

    let profile = {};
    try {
      const profResp = await supabaseRest(
        'profiles?id=eq.' + safeUid + '&select=full_name,phone,email,brokerage,trec_license_number&limit=1',
        { method: 'GET' },
      );
      if (profResp.ok) {
        const profRows = await profResp.json();
        profile = (Array.isArray(profRows) && profRows[0]) || {};
      }
    } catch (e) {
      console.warn('[fill-form] profile fetch failed (non-fatal):', e && e.message);
    }

    // Normalize transaction data, mirroring normalize_transaction.py
    const ft = tx.financing_type || (tx.lender_name ? 'conventional' : null);
    const txDefaults = {
      buyer_name:              tx.buyer_name || '',
      seller_name:             tx.seller_name || '',
      property_address:        tx.property_address || '',
      city_state_zip:          tx.city_state_zip || '',
      property_full:           [tx.property_address, tx.city_state_zip].filter(Boolean).join(', '),
      county:                  tx.county || '',
      legal_description:       tx.legal_description || '',
      sale_price:              tx.sale_price != null ? String(tx.sale_price) : '',
      earnest_money:           tx.earnest_money != null ? String(tx.earnest_money) : '',
      option_fee:              tx.option_fee != null ? String(tx.option_fee) : '',
      closing_date:            tx.closing_date || '',
      contract_effective_date: tx.contract_effective_date || '',
      title_company:           tx.title_company || '',
      loan_amount:             tx.loan_amount != null ? String(tx.loan_amount) : '',
      financing_type:          ft || '',
      financing_addendum:      Boolean(ft && ft !== 'cash'),
      financing_conventional:  ft === 'conventional',
      financing_fha:           ft === 'fha',
      financing_va:            ft === 'va',
      listing_agent_name:      profile.full_name || '',
      listing_broker_firm:     profile.brokerage || '',
      listing_agent_phone:     profile.phone || '',
      listing_agent_email:     profile.email || '',
      listing_agent_license:   profile.trec_license_number || '',
    };

    // Agent-supplied field_values override transaction defaults
    const mergedFields = Object.assign({}, txDefaults, fieldValues);

    console.log('[fill-form] filling', formType, 'for tx', transactionId);
    const filledBytes = await fillForm(formType, mergedFields);
    const buffer = Buffer.from(filledBytes);

    const ts = Date.now();
    const config = FORM_CONFIGS[formType];
    const safeName = config.shortName + '-' + ts + '.pdf';
    const storagePath = userId + '/' + transactionId + '/' + safeName;
    storagePathForCleanup = storagePath;
    await supabaseStorageUpload(storagePath, buffer, 'application/pdf');

    const docResp = await supabaseRest('documents', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        transaction_id: transactionId,
        user_id: userId,
        file_name: safeName,
        file_type: 'application/pdf',
        document_type: config.documentType,
        storage_path: storagePath,
        file_size: buffer.length,
        status: 'filled',
      }),
    });
    if (!docResp.ok) {
      const text = await docResp.text().catch(function() { return ''; });
      throw new Error('documents insert failed (' + docResp.status + '): ' + text.slice(0, 300));
    }
    const docRows = await docResp.json();
    const docRow = Array.isArray(docRows) ? docRows[0] : docRows;

    // If this is a wire fraud warning, insert a delivery tracking row.
    if (formType === 'wire-fraud-warning' && docRow && docRow.id) {
      const wfdPayload = {
        transaction_id: transactionId,
        user_id: userId,
        document_id: docRow.id,
        delivered_at: new Date().toISOString(),
        buyer_name: mergedFields.buyer_name || null,
        buyer_email: mergedFields.buyer_email || null,
      };
      const wfdResp = await supabaseRest('wire_fraud_deliveries', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(wfdPayload),
      });
      if (!wfdResp.ok) {
        const text = await wfdResp.text().catch(function() { return ''; });
        console.warn('[fill-form] wire_fraud_deliveries insert failed (non-fatal):', wfdResp.status, text.slice(0, 200));
      }
    }

    const signedUrl = await supabaseStorageSignedUrl(storagePath, 3600);

    return res.status(200).json({
      ok: true,
      documentId: docRow && docRow.id ? docRow.id : null,
      storagePath,
      signedUrl,
      fileName: safeName,
      formName: config.name,
      formType,
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