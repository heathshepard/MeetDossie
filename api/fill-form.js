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
  // Block 9B — HOA Addendum (TREC 36-10)
  'hoa-addendum': {
    name: 'Addendum for Property Subject to Mandatory Membership (TREC 36-10)',
    shortName: 'TREC-HOA-Addendum',
    getBase64: function() { return require('./_assets/trec-hoa-addendum-base64.js'); },
    documentType: 'hoa_addendum',
  },
  // Block 9C — Lead-Based Paint Addendum (OP-L)
  'lead-paint-addendum': {
    name: 'Addendum for Sellers Disclosure of Information on Lead-Based Paint',
    shortName: 'OP-L-Lead-Paint',
    getBase64: function() { return require('./_assets/trec-lead-paint-base64.js'); },
    documentType: 'lead_paint_addendum',
  },
  // Seller's Disclosure Notice (TREC 55-0)
  'sellers-disclosure': {
    name: "Seller's Disclosure Notice (TREC 55-0)",
    shortName: 'TREC-55-SDN',
    getBase64: function() { return require('./_assets/trec-sellers-disclosure-base64.js'); },
    documentType: 'sellers_disclosure',
  },
  // Amendment to Contract (TREC 39-10)
  'amendment': {
    name: 'Amendment to Contract (TREC 39-10)',
    shortName: 'TREC-39-Amendment',
    getBase64: function() { return require('./_assets/trec-39-10-base64.js'); },
    documentType: 'amendment',
  },
  // Block 9E — Buyer Representation Agreement (TAR 1501)
  // NOTE: Replace api/_assets/tar-buyer-rep-base64.js with the real TAR 1501 PDF.
  'buyer-rep-agreement': {
    name: 'Residential Buyer Representation Agreement (TAR 1501)',
    shortName: 'TAR-Buyer-Rep',
    getBase64: function() { return require('./_assets/tar-buyer-rep-base64.js'); },
    documentType: 'buyer_rep_agreement',
  },
  // Block 10 — TREC 49-1 Appraisal Termination
  // NOTE: Replace api/_assets/trec-49-1-base64.js with the real TREC 49-1 PDF.
  'appraisal-termination': {
    name: 'Right to Terminate Due to Lenders Appraisal (TREC 49-1)',
    shortName: 'TREC-49-1',
    getBase64: function() { return require('./_assets/trec-49-1-base64.js'); },
    documentType: 'appraisal_termination',
  },
  // Block 12 — T-47 Affidavit
  // NOTE: Replace api/_assets/t47-affidavit-base64.js with the real T-47 PDF.
  't47-affidavit': {
    name: 'T-47 Residential Real Property Affidavit',
    shortName: 'T-47-Affidavit',
    getBase64: function() { return require('./_assets/t47-affidavit-base64.js'); },
    documentType: 't47_affidavit',
  },
  // TREC 9-17 — Unimproved Property Contract (land purchase)
  // PDF has 270 AcroForm fields. Field names verified against AcroForm inspection of 9-17.pdf.
  'unimproved-property': {
    name: 'Unimproved Property Contract (TREC 9-17)',
    shortName: 'TREC-9-Unimproved-Property',
    getBase64: function() { return require('./_assets/trec-unimproved-property-base64.js'); },
    documentType: 'unimproved_property_contract',
  },
  // TREC 23-18 — New Home Contract (Incomplete Construction)
  // PDF has AcroForm dict but 0 named fields — flat PDF, no AcroForm widget names.
  // Handler fills what it can; layout-based text overlay not implemented yet.
  'new-home-incomplete': {
    name: 'New Home Contract - Incomplete Construction (TREC 23-18)',
    shortName: 'TREC-23-New-Home-Incomplete',
    getBase64: function() { return require('./_assets/trec-new-home-incomplete-base64.js'); },
    documentType: 'new_home_contract_incomplete',
  },
  // TREC 24-18 — New Home Contract (Completed Construction)
  // PDF has AcroForm dict but 0 named fields — flat PDF, no AcroForm widget names.
  // Handler fills what it can; layout-based text overlay not implemented yet.
  'new-home-complete': {
    name: 'New Home Contract - Completed Construction (TREC 24-18)',
    shortName: 'TREC-24-New-Home-Complete',
    getBase64: function() { return require('./_assets/trec-new-home-complete-base64.js'); },
    documentType: 'new_home_contract_complete',
  },
  // TREC 25-14 — Farm and Ranch Contract (land with improvements)
  // PDF has AcroForm dict but 0 named fields — flat PDF, no AcroForm widget names.
  // Handler fills what it can via shared field names with TREC 9-17.
  'farm-ranch': {
    name: 'Farm and Ranch Contract (TREC 25-14)',
    shortName: 'TREC-25-Farm-Ranch',
    getBase64: function() { return require('./_assets/trec-farm-ranch-base64.js'); },
    documentType: 'farm_ranch_contract',
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
// HOA ADDENDUM (TREC 36-10)
// Block 9B — verified field names from AcroForm inspection of TREC 36-10 PDF
// ---------------------------------------------------------------------------
async function fillHoaAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  safeSetText(form, 'Name of Property Owners Association Association and Phone Number',
    [fv.hoa_name, fv.hoa_phone].filter(Boolean).join(' '));
  if (fv.hoa_transfer_fee != null && fv.hoa_transfer_fee !== '') {
    safeSetText(form, 'D DEPOSITS FOR RESERVES Buyer shall pay any deposits...', formatMoney(fv.hoa_transfer_fee));
  }
  // Default: Seller obtains subdivision info (Paragraph A1, most common)
  safeCheck(form, '1 Within');
  safeSetText(form, 'the Subdivision Information to the Buyer If Seller delivers...', fv.subdivision_info_days || '10');
  // Default: Buyer does NOT require updated resale cert
  safeCheck(form, 'does not require an updated resale certificate...');
  // Default: Buyer pays title company for info (Paragraph D)
  safeCheck(form, 'Buyer');
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// LEAD-BASED PAINT ADDENDUM (OP-L)
// Block 9C — verified field names from AcroForm inspection of OP-L PDF
// ---------------------------------------------------------------------------
async function fillLeadPaintAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  // Date fields — fill today's date for all six signature date slots
  const today = formatDate(new Date().toISOString().slice(0, 10));
  ['Date', 'Date_2', 'Date_3', 'Date_4', 'Date_5', 'Date_6'].forEach(function(f) { safeSetText(form, f, today); });
  // Default: Seller has no knowledge, no reports
  safeCheck(form, 'Check Box8');   // B1(b): no knowledge
  safeCheck(form, 'Check Box10');  // B2(b): no reports
  // Default: Buyer retains 10-day inspection right
  safeCheck(form, 'Check Box12'); // C2: retains right
  safeCheck(form, 'Check Box13'); // D1: acknowledges receipt
  safeCheck(form, 'Check Box14'); // D2: acknowledges EPA pamphlet
  // Overrides from field_values
  if (fv.seller_aware_of_hazards) {
    safeCheck(form, 'Check Box7'); // B1(a): seller IS aware
    if (fv.hazard_explanation) safeSetText(form, 'undefined', fv.hazard_explanation);
  }
  if (fv.seller_has_records) {
    safeCheck(form, 'Check Box9'); // B2(a): seller HAS records
    if (fv.documents_list) safeSetText(form, 'undefined_2', fv.documents_list);
  }
  if (fv.buyer_waives_inspection) safeCheck(form, 'Check Box11'); // C1: waives
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// SELLER'S DISCLOSURE NOTICE (TREC 55-0)
// XFA-based form — address fields use subform path notation
// ---------------------------------------------------------------------------
async function fillSellersDisclosure(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) {
    safeSetText(form, 'form1[0].#subform[0].TextField1[0]', addr);
    safeSetText(form, 'form1[0].#subform[1].TextField1[1]', addr);
    safeSetText(form, 'form1[0].#subform[2].TextField1[2]', addr);
    safeSetText(form, 'form1[0].#subform[4].TextField1[3]', addr);
  }
  if (fv.seller_occupied === true) safeCheck(form, 'form1[0].#subform[0].CheckBox1[0]');
  else if (fv.seller_occupied === false) safeCheck(form, 'form1[0].#subform[0].CheckBox2[0]');
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// AMENDMENT TO CONTRACT (TREC 39-10)
// Pre-fills party names, property address, and effective date from transaction.
// Agent supplies the specific amendment change via field_values.
// ---------------------------------------------------------------------------
async function fillAmendment(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  if (fv.buyer_name) safeSetText(form, 'Buyer', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'Seller', fv.seller_name);
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  if (fv.contract_effective_date) {
    safeSetText(form, 'Date', formatDate(fv.contract_effective_date));
  }
  const today = new Date().toISOString().slice(0, 10);
  safeSetText(form, 'Date_2', formatDate(today));
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// BUYER REPRESENTATION AGREEMENT (TAR 1501)
// Block 9E — pre-fills agent/brokerage info from profile
// NOTE: Field names are best-guess. Verify against actual AcroForm after PDF is installed.
// ---------------------------------------------------------------------------
async function fillBuyerRepAgreement(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  if (fv.buyer_name_1) safeSetText(form, 'Client Name', fv.buyer_name_1);
  if (fv.buyer_name_2) safeSetText(form, 'Client Name 2', fv.buyer_name_2);
  if (fv.listing_agent_name) safeSetText(form, 'Broker Associate', fv.listing_agent_name);
  if (fv.listing_agent_license) safeSetText(form, 'License No', fv.listing_agent_license);
  if (fv.listing_broker_firm) safeSetText(form, 'Broker', fv.listing_broker_firm);
  if (fv.listing_agent_phone) safeSetText(form, 'Phone', fv.listing_agent_phone);
  if (fv.representation_start_date) safeSetText(form, 'Start Date', formatDate(fv.representation_start_date));
  if (fv.representation_end_date) safeSetText(form, 'End Date', formatDate(fv.representation_end_date));
  if (fv.compensation_percentage != null && fv.compensation_percentage !== '') {
    safeSetText(form, 'Compensation', String(fv.compensation_percentage) + '%');
  }
  if (fv.geographic_area) safeSetText(form, 'Geographic Area', fv.geographic_area);
  const today = new Date().toISOString().slice(0, 10);
  safeSetText(form, 'Date', formatDate(today));
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// TREC 49-1 — Right to Terminate Due to Lender's Appraisal
// Block 10 — pre-fills appraisal_value from transaction
// NOTE: Field names are best-guess. Verify against actual AcroForm after PDF is installed.
// ---------------------------------------------------------------------------
async function fillAppraisalTermination(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  if (fv.buyer_name) safeSetText(form, 'Buyer', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'Seller', fv.seller_name);
  if (fv.property_address) safeSetText(form, 'Property Address', fv.property_address);
  if (fv.contract_date) safeSetText(form, 'Contract Date', formatDate(fv.contract_date));
  if (fv.appraisal_deadline) safeSetText(form, 'Appraisal Deadline', formatDate(fv.appraisal_deadline));
  if (fv.appraised_value != null && fv.appraised_value !== '') {
    safeSetText(form, 'Appraised Value', formatMoney(fv.appraised_value));
  }
  if (fv.sales_price != null && fv.sales_price !== '') {
    safeSetText(form, 'Sales Price', formatMoney(fv.sales_price));
  }
  if (fv.termination_date) safeSetText(form, 'Termination Date', formatDate(fv.termination_date));
  const today = new Date().toISOString().slice(0, 10);
  if (!fv.termination_date) safeSetText(form, 'Termination Date', formatDate(today));
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// T-47 AFFIDAVIT — Residential Real Property Affidavit
// Block 12 — pre-fills seller names and property address
// NOTE: Field names are best-guess. Verify against actual AcroForm after PDF is installed.
// ---------------------------------------------------------------------------
async function fillT47Affidavit(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  if (fv.seller_name_1) safeSetText(form, 'Affiant Name', fv.seller_name_1);
  if (fv.seller_name_2) safeSetText(form, 'Affiant Name 2', fv.seller_name_2);
  if (fv.property_address) safeSetText(form, 'Property Address', fv.property_address);
  if (fv.survey_date) safeSetText(form, 'Survey Date', formatDate(fv.survey_date));
  if (fv.surveyor_name) safeSetText(form, 'Surveyor Name', fv.surveyor_name);
  const today = new Date().toISOString().slice(0, 10);
  safeSetText(form, 'Date', formatDate(today));
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// UNIMPROVED PROPERTY CONTRACT (TREC 9-17)
// Field names verified against AcroForm inspection of 9-17.pdf (270 fields).
// Shares several field names with TREC 20 resale contract (same TREC template family).
// Land-specific fields: acres, $ per acre, Block/Lot/Addition are used for legal description.
// ---------------------------------------------------------------------------
async function fillUnimprovedProperty(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // Parties (field names match TREC 9-17 AcroForm inspection)
  if (fv.buyer_name) safeSetText(form, '1 PARTIES The parties to this contract are', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'and', fv.seller_name);

  // Property address (TREC 9 uses "Texas known as" for the street address line)
  const addr = fv.property_address || '';
  if (addr) {
    safeSetText(form, 'Texas known as', addr);
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Address of Property_2', addr);
  }
  if (fv.county) safeSetText(form, 'County of', fv.county);
  if (fv.city_state_zip) safeSetText(form, 'City of', fv.city_state_zip);

  // Legal description fields (lot/block/subdivision for land)
  if (fv.legal_description) safeSetText(form, 'Addition', fv.legal_description);
  if (fv.land_parcel_id) safeSetText(form, 'Block', fv.land_parcel_id);

  // Acreage (land-specific — TREC 9 has an "acres" field on the property description line)
  if (fv.land_acreage != null && fv.land_acreage !== '') safeSetText(form, 'acres', String(fv.land_acreage));

  // Price fields
  // TREC 9-17 AcroForm inspection: undefined_2 = cash/down, undefined_3 = financed amount,
  // undefined_4 = total sale price, undefined_5 = additional cash at closing
  // (Best-guess mapping — same pattern as TREC 20-16 resale contract)
  if (fv.sale_price != null && fv.sale_price !== '') safeSetText(form, 'undefined_4', formatMoney(fv.sale_price));
  if (fv.down_payment_amt != null && fv.down_payment_amt !== '') safeSetText(form, 'undefined_2', formatMoney(fv.down_payment_amt));
  if (fv.loan_amount != null && fv.loan_amount !== '') safeSetText(form, 'undefined_3', formatMoney(fv.loan_amount));

  // Earnest money + option fee (same field names as TREC 20)
  if (fv.earnest_money != null && fv.earnest_money !== '') safeSetText(form, 'earnest money of', formatMoney(fv.earnest_money));
  if (fv.option_fee != null && fv.option_fee !== '') safeSetText(form, 'Option Fee in the form of', formatMoney(fv.option_fee));

  // Closing date — TREC 9 uses same two-field pattern as resale: month+day in one field, 2-digit year in "20"
  if (fv.closing_date) {
    const cd = String(fv.closing_date);
    if (cd.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd));
      safeSetText(form, '20', formatTwoDigitYear(cd));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd);
    }
  }

  // Contract effective date
  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-')
      ? formatDate(fv.contract_effective_date)
      : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }

  // Title company (same field names as TREC 20)
  if (fv.title_company) {
    safeSetText(form, 'title insurance Title Policy issued by', fv.title_company);
    safeSetText(form, 'Escrow Agent', fv.title_company);
  }

  // Financing addendum checkbox (same field name as TREC 20)
  const isFinanced = fv.loan_amount && Number(fv.loan_amount) > 0;
  if (isFinanced || fv.financing_addendum === true) {
    safeCheck(form, 'Third Party Financing Addendum');
    safeCheck(form, 'Third Party Financing Addendum_2');
  }

  // Accept property As-Is (checkbox — same name as TREC 20)
  safeCheck(form, '1 Buyer accepts the Property As Is');

  // Agent info (TREC 9-17 broker section — same listing agent fields as TREC 20)
  if (fv.listing_agent_name) safeSetText(form, 'Listing Associates Name', fv.listing_agent_name);
  if (fv.listing_broker_firm) safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm);
  if (fv.listing_agent_phone) safeSetText(form, 'Phone_3', fv.listing_agent_phone);
  if (fv.listing_agent_email) safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email);
  if (fv.listing_agent_license) safeSetText(form, 'License No_5', fv.listing_agent_license);

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// NEW HOME CONTRACT — INCOMPLETE CONSTRUCTION (TREC 23-18)
// PDF is a flat file with AcroForm dict but 0 named widget fields.
// safeSetText calls will silently warn but produce no fills.
// TREC 23 covers new construction where the home is not yet complete.
// Builder-specific fields: builder name, expected completion date, CO date.
// NOTE: When TREC releases a version with AcroForm fields, update field names
// below by running: node -e "require('pdf-lib').PDFDocument.load(...)"
// ---------------------------------------------------------------------------
async function fillNewHomeIncomplete(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // Common fields that TREC new-home forms share with the resale family.
  // These are best-guess names — TREC 23-18 has no AcroForm widget names to verify against.
  if (fv.buyer_name) safeSetText(form, '1 PARTIES The parties to this contract are', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'and', fv.seller_name);

  const addr = fv.property_address || '';
  if (addr) {
    safeSetText(form, 'Texas known as', addr);
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Street Address and City', addr);
  }
  if (fv.county) safeSetText(form, 'County of', fv.county);
  if (fv.city_state_zip) safeSetText(form, 'City of', fv.city_state_zip);
  if (fv.legal_description) safeSetText(form, 'Addition', fv.legal_description);

  if (fv.sale_price != null && fv.sale_price !== '') safeSetText(form, 'undefined_4', formatMoney(fv.sale_price));
  if (fv.down_payment_amt != null && fv.down_payment_amt !== '') safeSetText(form, 'undefined_2', formatMoney(fv.down_payment_amt));
  if (fv.loan_amount != null && fv.loan_amount !== '') safeSetText(form, 'undefined_3', formatMoney(fv.loan_amount));

  if (fv.earnest_money != null && fv.earnest_money !== '') safeSetText(form, 'earnest money of', formatMoney(fv.earnest_money));
  if (fv.option_fee != null && fv.option_fee !== '') safeSetText(form, 'Option Fee in the form of', formatMoney(fv.option_fee));

  if (fv.closing_date) {
    const cd = String(fv.closing_date);
    if (cd.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd));
      safeSetText(form, '20', formatTwoDigitYear(cd));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd);
    }
  }

  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-')
      ? formatDate(fv.contract_effective_date)
      : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }

  if (fv.title_company) {
    safeSetText(form, 'title insurance Title Policy issued by', fv.title_company);
    safeSetText(form, 'Escrow Agent', fv.title_company);
  }

  const isFinanced = fv.loan_amount && Number(fv.loan_amount) > 0;
  if (isFinanced || fv.financing_addendum === true) safeCheck(form, 'Third Party Financing Addendum');

  // New construction-specific fields (best-guess names for TREC 23)
  if (fv.builder_name) safeSetText(form, 'Builder Name', fv.builder_name);
  if (fv.expected_completion_date) safeSetText(form, 'Expected Completion Date', formatDate(fv.expected_completion_date));
  if (fv.builder_rep_name) safeSetText(form, 'Builder Representative', fv.builder_rep_name);
  if (fv.builder_rep_phone) safeSetText(form, 'Builder Phone', fv.builder_rep_phone);

  if (fv.listing_agent_name) safeSetText(form, 'Listing Associates Name', fv.listing_agent_name);
  if (fv.listing_broker_firm) safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm);
  if (fv.listing_agent_phone) safeSetText(form, 'Phone_3', fv.listing_agent_phone);
  if (fv.listing_agent_email) safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email);
  if (fv.listing_agent_license) safeSetText(form, 'License No_5', fv.listing_agent_license);

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// NEW HOME CONTRACT — COMPLETED CONSTRUCTION (TREC 24-18)
// PDF is a flat file with AcroForm dict but 0 named widget fields.
// TREC 24 covers new construction where the home is substantially complete.
// Differs from TREC 23 mainly in the completion/CO sections.
// NOTE: Field names below are best-guess — verify after TREC publishes AcroForm version.
// ---------------------------------------------------------------------------
async function fillNewHomeComplete(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // Same common fields as TREC 23 (best-guess names for flat PDF)
  if (fv.buyer_name) safeSetText(form, '1 PARTIES The parties to this contract are', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'and', fv.seller_name);

  const addr = fv.property_address || '';
  if (addr) {
    safeSetText(form, 'Texas known as', addr);
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Street Address and City', addr);
  }
  if (fv.county) safeSetText(form, 'County of', fv.county);
  if (fv.city_state_zip) safeSetText(form, 'City of', fv.city_state_zip);
  if (fv.legal_description) safeSetText(form, 'Addition', fv.legal_description);

  if (fv.sale_price != null && fv.sale_price !== '') safeSetText(form, 'undefined_4', formatMoney(fv.sale_price));
  if (fv.down_payment_amt != null && fv.down_payment_amt !== '') safeSetText(form, 'undefined_2', formatMoney(fv.down_payment_amt));
  if (fv.loan_amount != null && fv.loan_amount !== '') safeSetText(form, 'undefined_3', formatMoney(fv.loan_amount));

  if (fv.earnest_money != null && fv.earnest_money !== '') safeSetText(form, 'earnest money of', formatMoney(fv.earnest_money));
  if (fv.option_fee != null && fv.option_fee !== '') safeSetText(form, 'Option Fee in the form of', formatMoney(fv.option_fee));

  if (fv.closing_date) {
    const cd = String(fv.closing_date);
    if (cd.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd));
      safeSetText(form, '20', formatTwoDigitYear(cd));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd);
    }
  }

  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-')
      ? formatDate(fv.contract_effective_date)
      : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }

  if (fv.title_company) {
    safeSetText(form, 'title insurance Title Policy issued by', fv.title_company);
    safeSetText(form, 'Escrow Agent', fv.title_company);
  }

  const isFinanced = fv.loan_amount && Number(fv.loan_amount) > 0;
  if (isFinanced || fv.financing_addendum === true) safeCheck(form, 'Third Party Financing Addendum');

  // Completed construction-specific fields (best-guess names for TREC 24)
  if (fv.builder_name) safeSetText(form, 'Builder Name', fv.builder_name);
  if (fv.co_received_date) safeSetText(form, 'Certificate of Occupancy Date', formatDate(fv.co_received_date));
  if (fv.co_number) safeSetText(form, 'Certificate of Occupancy Number', fv.co_number);
  if (fv.builder_rep_name) safeSetText(form, 'Builder Representative', fv.builder_rep_name);
  if (fv.builder_rep_phone) safeSetText(form, 'Builder Phone', fv.builder_rep_phone);
  if (fv.builder_warranty_company) safeSetText(form, 'Warranty Company', fv.builder_warranty_company);

  if (fv.listing_agent_name) safeSetText(form, 'Listing Associates Name', fv.listing_agent_name);
  if (fv.listing_broker_firm) safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm);
  if (fv.listing_agent_phone) safeSetText(form, 'Phone_3', fv.listing_agent_phone);
  if (fv.listing_agent_email) safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email);
  if (fv.listing_agent_license) safeSetText(form, 'License No_5', fv.listing_agent_license);

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// FARM AND RANCH CONTRACT (TREC 25-14)
// PDF has AcroForm dict but 0 named widget fields — flat PDF.
// TREC 25 covers residential-use land with improvements (house, barn, fences).
// Has additional sections for minerals, water rights, easements vs TREC 9.
// NOTE: Field names below are best-guess — verify after TREC publishes AcroForm version.
// Key difference from TREC 9: TREC 25 includes mineral/surface rights addenda.
// ---------------------------------------------------------------------------
async function fillFarmRanch(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // Common party/property fields (best-guess, shared with TREC 9-17 family)
  if (fv.buyer_name) safeSetText(form, '1 PARTIES The parties to this contract are', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'and', fv.seller_name);

  const addr = fv.property_address || '';
  if (addr) {
    safeSetText(form, 'Texas known as', addr);
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Street Address and City', addr);
  }
  if (fv.county) safeSetText(form, 'County of', fv.county);
  if (fv.city_state_zip) safeSetText(form, 'City of', fv.city_state_zip);
  if (fv.legal_description) safeSetText(form, 'A LAND Lot', fv.legal_description);

  // Land-specific acreage
  if (fv.land_acreage != null && fv.land_acreage !== '') safeSetText(form, 'acres', String(fv.land_acreage));

  // Price fields (best-guess naming shared with TREC 9 family)
  if (fv.sale_price != null && fv.sale_price !== '') safeSetText(form, 'undefined_4', formatMoney(fv.sale_price));
  if (fv.down_payment_amt != null && fv.down_payment_amt !== '') safeSetText(form, 'undefined_2', formatMoney(fv.down_payment_amt));
  if (fv.loan_amount != null && fv.loan_amount !== '') safeSetText(form, 'undefined_3', formatMoney(fv.loan_amount));

  if (fv.earnest_money != null && fv.earnest_money !== '') safeSetText(form, 'earnest money of', formatMoney(fv.earnest_money));
  if (fv.option_fee != null && fv.option_fee !== '') safeSetText(form, 'Option Fee in the form of', formatMoney(fv.option_fee));

  if (fv.closing_date) {
    const cd = String(fv.closing_date);
    if (cd.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd));
      safeSetText(form, '20', formatTwoDigitYear(cd));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd);
    }
  }

  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-')
      ? formatDate(fv.contract_effective_date)
      : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }

  if (fv.title_company) {
    safeSetText(form, 'title insurance Title Policy issued by', fv.title_company);
    safeSetText(form, 'Escrow Agent', fv.title_company);
  }

  const isFinanced = fv.loan_amount && Number(fv.loan_amount) > 0;
  if (isFinanced || fv.financing_addendum === true) safeCheck(form, 'Third Party Financing Addendum');

  safeCheck(form, '1 Buyer accepts the Property As Is');

  if (fv.listing_agent_name) safeSetText(form, 'Listing Associates Name', fv.listing_agent_name);
  if (fv.listing_broker_firm) safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm);
  if (fv.listing_agent_phone) safeSetText(form, 'Phone_3', fv.listing_agent_phone);
  if (fv.listing_agent_email) safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email);
  if (fv.listing_agent_license) safeSetText(form, 'License No_5', fv.listing_agent_license);

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
    case 'resale-contract':       await fillResaleContract(pdfDoc, fv); break;
    case 'financing-addendum':    await fillFinancingAddendum(pdfDoc, fv); break;
    case 'termination-notice':    await fillTerminationNotice(pdfDoc, fv); break;
    case 'wire-fraud-warning':    await fillWireFraudWarning(pdfDoc, fv); break;
    case 'hoa-addendum':          await fillHoaAddendum(pdfDoc, fv); break;
    case 'lead-paint-addendum':   await fillLeadPaintAddendum(pdfDoc, fv); break;
    case 'sellers-disclosure':    await fillSellersDisclosure(pdfDoc, fv); break;
    case 'amendment':             await fillAmendment(pdfDoc, fv); break;
    case 'buyer-rep-agreement':   await fillBuyerRepAgreement(pdfDoc, fv); break;
    case 'appraisal-termination': await fillAppraisalTermination(pdfDoc, fv); break;
    case 't47-affidavit':         await fillT47Affidavit(pdfDoc, fv); break;
    case 'unimproved-property':   await fillUnimprovedProperty(pdfDoc, fv); break;
    case 'new-home-incomplete':   await fillNewHomeIncomplete(pdfDoc, fv); break;
    case 'new-home-complete':     await fillNewHomeComplete(pdfDoc, fv); break;
    case 'farm-ranch':            await fillFarmRanch(pdfDoc, fv); break;
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
    const fieldValues = (body.field_values && typeof body.field_values === 'object') ? body.field_values : {};

    // Support both form_type (canonical) and trec_number (legacy bundle format).
    // trec_number -> form_type translation table:
    const TREC_NUMBER_MAP = {
      '20-16': 'resale-contract',
      '20-17': 'resale-contract',
      '40-9':  'financing-addendum',
      '40-11': 'financing-addendum',
      '38-7':  'termination-notice',
      '39-10': 'amendment',
      '9-17':  'unimproved-property',
      '23-18': 'new-home-incomplete',
      '24-18': 'new-home-complete',
      '25-14': 'farm-ranch',
    };
    const rawFormType = sanitizeString(body.form_type, { maxLength: 50 });
    const rawTrecNumber = sanitizeString(body.trec_number, { maxLength: 20 });
    const formType = rawFormType || TREC_NUMBER_MAP[rawTrecNumber] || null;

    if (!transactionId) throw new ValidationError('transaction_id is required.');
    if (!formType) throw new ValidationError('form_type (or trec_number) is required.');
    if (!ALLOWED_FORM_TYPES.has(formType)) {
      throw new ValidationError('form_type must be one of: ' + [...ALLOWED_FORM_TYPES].join(', '));
    }

    const safeUid = encodeURIComponent(userId);
    const safeTx = encodeURIComponent(transactionId);
    const txResp = await supabaseRest(
      'transactions?id=eq.' + safeTx + '&user_id=eq.' + safeUid + '&select=id,property_address,city_state_zip,buyer_name,seller_name,sale_price,earnest_money,option_fee,option_days,closing_date,contract_effective_date,county,legal_description,title_company,loan_amount,financing_type,lender_name,year_built,hoa_name,hoa_phone,hoa_management_company,appraisal_value,appraisal_deadline,transaction_type,land_acreage,land_legal_description,land_parcel_id,builder_name,builder_rep_name,builder_rep_phone,builder_rep_email,builder_warranty_company,co_received_date,co_number,expected_completion_date&limit=1',
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

    // Auto-upgrade form type based on transaction_type when the caller sent the generic
    // resale-contract form type but the transaction is actually land or new construction.
    // This fires when the legacy bundle sends trec_number:"20-16" for a non-resale tx.
    let resolvedFormType = formType;
    if (formType === 'resale-contract' && tx.transaction_type) {
      const txType = String(tx.transaction_type).toLowerCase();
      if (txType === 'land') resolvedFormType = 'unimproved-property';
      else if (txType === 'land_purchase') resolvedFormType = 'unimproved-property';
      else if (txType === 'farm_ranch') resolvedFormType = 'farm-ranch';
      else if (txType === 'new_home_purchase') {
        // Default to incomplete; complete if co_received_date is set on the tx
        resolvedFormType = tx.co_received_date ? 'new-home-complete' : 'new-home-incomplete';
      }
      if (resolvedFormType !== formType) {
        console.log('[fill-form] auto-upgraded form type from', formType, 'to', resolvedFormType, 'based on transaction_type:', tx.transaction_type);
      }
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
      // HOA fields (Block 9B)
      hoa_name:                tx.hoa_name || '',
      hoa_phone:               tx.hoa_phone || '',
      hoa_management_company:  tx.hoa_management_company || '',
      // Appraisal fields (Block 10)
      appraised_value:         tx.appraisal_value != null ? String(tx.appraisal_value) : '',
      appraisal_deadline:      tx.appraisal_deadline || '',
      sales_price:             tx.sale_price != null ? String(tx.sale_price) : '',
      // Seller name split for T-47 and other multi-seller forms
      seller_name_1:           tx.seller_name || '',
      // Year built for lead paint trigger
      year_built:              tx.year_built || null,
      // Transaction type (used by chat.js routing for form selection)
      transaction_type:        tx.transaction_type || '',
      // Land fields (TREC 9 + TREC 25)
      land_acreage:            tx.land_acreage != null ? String(tx.land_acreage) : '',
      land_legal_description:  tx.land_legal_description || '',
      land_parcel_id:          tx.land_parcel_id || '',
      // Builder/new construction fields (TREC 23 + TREC 24)
      builder_name:            tx.builder_name || '',
      builder_rep_name:        tx.builder_rep_name || '',
      builder_rep_phone:       tx.builder_rep_phone || '',
      builder_rep_email:       tx.builder_rep_email || '',
      builder_warranty_company: tx.builder_warranty_company || '',
      co_received_date:        tx.co_received_date || '',
      co_number:               tx.co_number || '',
      expected_completion_date: tx.expected_completion_date || '',
    };

    // Agent-supplied field_values override transaction defaults
    const mergedFields = Object.assign({}, txDefaults, fieldValues);

    console.log('[fill-form] filling', resolvedFormType, 'for tx', transactionId);
    const filledBytes = await fillForm(resolvedFormType, mergedFields);
    const buffer = Buffer.from(filledBytes);

    const ts = Date.now();
    const config = FORM_CONFIGS[resolvedFormType];
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
    if (resolvedFormType === 'wire-fraud-warning' && docRow && docRow.id) {
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
      formType: resolvedFormType,
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
    const msg = (error && error.message) ? error.message : String(error);
    console.error('[fill-form] error:', msg);
    return res.status(422).json({ ok: false, error: msg || 'Could not fill that form.' });
  }
};