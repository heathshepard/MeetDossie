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

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';
// Template created 2026-06-03: TREC 20-19 (replaces 20-18, mandatory July 1 2026)
// 22 fields: buyer/seller initials pages 1-8 + signatures page 9
const DOCUSEAL_TREC_20_19_TEMPLATE_ID = Number(process.env.DOCUSEAL_TREC_20_19_TEMPLATE_ID) || 4111319;

// Module-scope requires — loaded at cold-start, not per-request.
// Prevents 500 errors on first request to a cold Vercel instance.
const TREC_RESALE_B64 = require('./_assets/trec-resale-20-19-base64.js');
const TREC_FINANCING_B64 = require('./_assets/trec-financing-base64.js');
const TREC_TERMINATION_B64 = require('./_assets/trec-termination-base64.js');
const TAR_WIRE_FRAUD_B64 = require('./_assets/tar-wire-fraud-base64.js');
const TREC_HOA_ADDENDUM_B64 = require('./_assets/trec-hoa-addendum-36-11-base64.js');
const TREC_LEAD_PAINT_B64 = require('./_assets/trec-lead-paint-base64.js');
const TREC_SELLERS_DISCLOSURE_B64 = require('./_assets/trec-sellers-disclosure-55-1-base64.js');
const TREC_39_10_B64 = require('./_assets/trec-amendment-39-11-base64.js');
const TAR_BUYER_REP_B64 = require('./_assets/tar-buyer-rep-base64.js');
const TREC_49_1_B64 = require('./_assets/trec-49-1-base64.js');
const T47_AFFIDAVIT_B64 = require('./_assets/t47-affidavit-base64.js');
const TREC_UNIMPROVED_PROPERTY_B64 = require('./_assets/trec-unimproved-property-base64.js');
const TREC_NEW_HOME_INCOMPLETE_B64 = require('./_assets/trec-new-home-incomplete-23-20-base64.js');
const TREC_NEW_HOME_COMPLETE_B64 = require('./_assets/trec-new-home-complete-24-20-base64.js');
const TREC_FARM_RANCH_B64 = require('./_assets/trec-farm-ranch-25-17-base64.js');
const TREC_SELLER_FINANCING_B64 = require('./_assets/trec-seller-financing-base64.js');
const TREC_BUYERS_TEMP_LEASE_B64 = require('./_assets/trec-buyers-temp-lease-base64.js');
const TREC_SELLERS_TEMP_LEASE_B64 = require('./_assets/trec-sellers-temp-lease-base64.js');
const TREC_SALE_OTHER_PROPERTY_B64 = require('./_assets/trec-sale-other-property-base64.js');
const TREC_OIL_GAS_MINERALS_B64 = require('./_assets/trec-oil-gas-minerals-base64.js');
const TREC_BACKUP_CONTRACT_B64 = require('./_assets/trec-backup-contract-11-9-base64.js');
const TREC_COASTAL_AREA_B64 = require('./_assets/trec-coastal-area-base64.js');
const TREC_HYDROSTATIC_TESTING_B64 = require('./_assets/trec-hydrostatic-testing-base64.js');
const TREC_ENVIRONMENTAL_B64 = require('./_assets/trec-environmental-base64.js');
const TREC_SHORT_SALE_B64 = require('./_assets/trec-short-sale-base64.js');
const TREC_GULF_WATERWAY_B64 = require('./_assets/trec-gulf-waterway-base64.js');
const TREC_PROPANE_GAS_B64 = require('./_assets/trec-propane-gas-base64.js');
const TREC_RESIDENTIAL_LEASES_B64 = require('./_assets/trec-residential-leases-base64.js');
const TREC_FIXTURE_LEASES_B64 = require('./_assets/trec-fixture-leases-base64.js');
const TREC_LOAN_ASSUMPTION_B64 = require('./_assets/trec-loan-assumption-base64.js');
const TREC_IMPROVEMENT_DISTRICT_B64 = require('./_assets/trec-improvement-district-base64.js');

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
    getBase64: () => TREC_RESALE_B64,
    documentType: 'resale_contract',
  },
  'financing-addendum': {
    name: 'Third Party Financing Addendum (TREC 40)',
    shortName: 'TREC-Financing-Addendum',
    getBase64: () => TREC_FINANCING_B64,
    documentType: 'financing_addendum',
  },
  'termination-notice': {
    name: 'Notice of Sellers Termination of Contract',
    shortName: 'TREC-Termination-Notice',
    getBase64: () => TREC_TERMINATION_B64,
    documentType: 'termination_notice',
  },
  'wire-fraud-warning': {
    name: 'Wire Fraud Warning (TAR 2517)',
    shortName: 'TAR-Wire-Fraud-Warning',
    getBase64: () => TAR_WIRE_FRAUD_B64,
    documentType: 'wire_fraud_warning',
  },
  // Block 9B — HOA Addendum (TREC 36-10)
  'hoa-addendum': {
    name: 'Addendum for Property Subject to Mandatory Membership (TREC 36-10)',
    shortName: 'TREC-HOA-Addendum',
    getBase64: () => TREC_HOA_ADDENDUM_B64,
    documentType: 'hoa_addendum',
  },
  // Block 9C — Lead-Based Paint Addendum (OP-L)
  'lead-paint-addendum': {
    name: 'Addendum for Sellers Disclosure of Information on Lead-Based Paint',
    shortName: 'OP-L-Lead-Paint',
    getBase64: () => TREC_LEAD_PAINT_B64,
    documentType: 'lead_paint_addendum',
  },
  // Seller's Disclosure Notice (TREC 55-0)
  'sellers-disclosure': {
    name: "Seller's Disclosure Notice (TREC 55-0)",
    shortName: 'TREC-55-SDN',
    getBase64: () => TREC_SELLERS_DISCLOSURE_B64,
    documentType: 'sellers_disclosure',
  },
  // Amendment to Contract (TREC 39-10)
  'amendment': {
    name: 'Amendment to Contract (TREC 39-10)',
    shortName: 'TREC-39-Amendment',
    getBase64: () => TREC_39_10_B64,
    documentType: 'amendment',
  },
  // Block 9E — Buyer Representation Agreement (TAR 1501)
  // NOTE: Replace api/_assets/tar-buyer-rep-base64.js with the real TAR 1501 PDF.
  'buyer-rep-agreement': {
    name: 'Residential Buyer Representation Agreement (TAR 1501)',
    shortName: 'TAR-Buyer-Rep',
    getBase64: () => TAR_BUYER_REP_B64,
    documentType: 'buyer_rep_agreement',
  },
  // Block 10 — TREC 49-1 Appraisal Termination
  // NOTE: Replace api/_assets/trec-49-1-base64.js with the real TREC 49-1 PDF.
  'appraisal-termination': {
    name: 'Right to Terminate Due to Lenders Appraisal (TREC 49-1)',
    shortName: 'TREC-49-1',
    getBase64: () => TREC_49_1_B64,
    documentType: 'appraisal_termination',
  },
  // Block 12 — T-47 Affidavit
  // NOTE: Replace api/_assets/t47-affidavit-base64.js with the real T-47 PDF.
  't47-affidavit': {
    name: 'T-47 Residential Real Property Affidavit',
    shortName: 'T-47-Affidavit',
    getBase64: () => T47_AFFIDAVIT_B64,
    documentType: 't47_affidavit',
  },
  // TREC 9-17 — Unimproved Property Contract (land purchase)
  // PDF has 270 AcroForm fields. Field names verified against AcroForm inspection of 9-17.pdf.
  'unimproved-property': {
    name: 'Unimproved Property Contract (TREC 9-17)',
    shortName: 'TREC-9-Unimproved-Property',
    getBase64: () => TREC_UNIMPROVED_PROPERTY_B64,
    documentType: 'unimproved_property_contract',
  },
  // TREC 23-18 — New Home Contract (Incomplete Construction)
  // PDF has AcroForm dict but 0 named fields — flat PDF, no AcroForm widget names.
  // Handler fills what it can; layout-based text overlay not implemented yet.
  'new-home-incomplete': {
    name: 'New Home Contract - Incomplete Construction (TREC 23-18)',
    shortName: 'TREC-23-New-Home-Incomplete',
    getBase64: () => TREC_NEW_HOME_INCOMPLETE_B64,
    documentType: 'new_home_contract_incomplete',
  },
  // TREC 24-18 — New Home Contract (Completed Construction)
  // PDF has AcroForm dict but 0 named fields — flat PDF, no AcroForm widget names.
  // Handler fills what it can; layout-based text overlay not implemented yet.
  'new-home-complete': {
    name: 'New Home Contract - Completed Construction (TREC 24-18)',
    shortName: 'TREC-24-New-Home-Complete',
    getBase64: () => TREC_NEW_HOME_COMPLETE_B64,
    documentType: 'new_home_contract_complete',
  },
  // TREC 25-14 — Farm and Ranch Contract (land with improvements)
  // PDF has AcroForm dict but 0 named fields — flat PDF, no AcroForm widget names.
  // Handler fills what it can via shared field names with TREC 9-17.
  'farm-ranch': {
    name: 'Farm and Ranch Contract (TREC 25-14)',
    shortName: 'TREC-25-Farm-Ranch',
    getBase64: () => TREC_FARM_RANCH_B64,
    documentType: 'farm_ranch_contract',
  },
  // ---------------------------------------------------------------------------
  // PARAGRAPH 22 ADDENDA — field names verified against AcroForm inspection.
  // ---------------------------------------------------------------------------
  'seller-financing': {
    name: 'Seller Financing Addendum (TREC 26-8)',
    shortName: 'TREC-26-Seller-Financing',
    getBase64: () => TREC_SELLER_FINANCING_B64,
    documentType: 'seller_financing_addendum',
  },
  'buyers-temp-lease': {
    name: "Buyer's Temporary Residential Lease (TREC 16-7)",
    shortName: 'TREC-16-Buyers-Temp-Lease',
    getBase64: () => TREC_BUYERS_TEMP_LEASE_B64,
    documentType: 'buyers_temp_lease',
  },
  'sellers-temp-lease': {
    name: "Seller's Temporary Residential Lease (TREC 15-7)",
    shortName: 'TREC-15-Sellers-Temp-Lease',
    getBase64: () => TREC_SELLERS_TEMP_LEASE_B64,
    documentType: 'sellers_temp_lease',
  },
  'sale-other-property': {
    name: 'Addendum for Sale of Other Property by Buyer (TREC 10-6)',
    shortName: 'TREC-10-Sale-Other-Property',
    getBase64: () => TREC_SALE_OTHER_PROPERTY_B64,
    documentType: 'sale_other_property_addendum',
  },
  'oil-gas-minerals': {
    name: 'Addendum for Reservation of Oil, Gas and Other Minerals (TREC 44-3)',
    shortName: 'TREC-44-Oil-Gas-Minerals',
    getBase64: () => TREC_OIL_GAS_MINERALS_B64,
    documentType: 'oil_gas_minerals_addendum',
  },
  'backup-contract': {
    name: 'Addendum for Back-Up Contract (TREC 11-8)',
    shortName: 'TREC-11-Backup-Contract',
    getBase64: () => TREC_BACKUP_CONTRACT_B64,
    documentType: 'backup_contract_addendum',
  },
  'coastal-area': {
    name: 'Addendum for Coastal Area Property (TREC 33-2)',
    shortName: 'TREC-33-Coastal-Area',
    getBase64: () => TREC_COASTAL_AREA_B64,
    documentType: 'coastal_area_addendum',
  },
  'hydrostatic-testing': {
    name: 'Addendum for Authorizing Hydrostatic Testing (TREC 48-1)',
    shortName: 'TREC-48-Hydrostatic-Testing',
    getBase64: () => TREC_HYDROSTATIC_TESTING_B64,
    documentType: 'hydrostatic_testing_addendum',
  },
  'environmental': {
    name: 'Environmental Assessment, Threatened or Endangered Species and Wetlands Addendum (TREC 28-2)',
    shortName: 'TREC-28-Environmental',
    getBase64: () => TREC_ENVIRONMENTAL_B64,
    documentType: 'environmental_addendum',
  },
  'short-sale': {
    name: 'Short Sale Addendum (TREC 45-2)',
    shortName: 'TREC-45-Short-Sale',
    getBase64: () => TREC_SHORT_SALE_B64,
    documentType: 'short_sale_addendum',
  },
  'gulf-waterway': {
    name: 'Gulf Intracoastal Waterway Addendum (TREC 34-4)',
    shortName: 'TREC-34-Gulf-Waterway',
    getBase64: () => TREC_GULF_WATERWAY_B64,
    documentType: 'gulf_waterway_addendum',
  },
  'propane-gas': {
    name: 'Addendum for Property in a Propane Gas System Service Area (TREC 47-0)',
    shortName: 'TREC-47-Propane-Gas',
    getBase64: () => TREC_PROPANE_GAS_B64,
    documentType: 'propane_gas_addendum',
  },
  'residential-leases': {
    name: 'Addendum Regarding Residential Leases (TREC 51-1)',
    shortName: 'TREC-51-Residential-Leases',
    getBase64: () => TREC_RESIDENTIAL_LEASES_B64,
    documentType: 'residential_leases_addendum',
  },
  'fixture-leases': {
    name: 'Addendum Regarding Fixture Leases (TREC 52-1)',
    shortName: 'TREC-52-Fixture-Leases',
    getBase64: () => TREC_FIXTURE_LEASES_B64,
    documentType: 'fixture_leases_addendum',
  },
  'loan-assumption': {
    name: 'Addendum for Loan Assumption (TREC 41-3)',
    shortName: 'TREC-41-Loan-Assumption',
    getBase64: () => TREC_LOAN_ASSUMPTION_B64,
    documentType: 'loan_assumption_addendum',
  },
  'improvement-district': {
    name: 'Improvement District Assessment Notice',
    shortName: 'TREC-IDN-Improvement-District',
    getBase64: () => TREC_IMPROVEMENT_DISTRICT_B64,
    documentType: 'improvement_district_notice',
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
// RESALE CONTRACT (TREC 20-18) — DocuSeal template path
// Creates a DocuSeal submission from template 4018208 with pre-filled values.
// Returns { submissionId, signers: [{role, name, email, signingUrl}] }.
// Template fields use semantic names we control (buyer_name, seller_name, etc.)
// rather than AcroForm machine names ("undefined_2").
// ---------------------------------------------------------------------------
async function fillResaleContractDocuSeal(fv, buyerName, buyerEmail, sellerName, sellerEmail) {
  if (!DOCUSEAL_API_KEY) {
    throw new Error('DOCUSEAL_API_KEY not configured — cannot create DocuSeal submission for resale contract.');
  }

  const isFinanced = fv.loan_amount && Number(String(fv.loan_amount).replace(/[^0-9.]/g, '')) > 0;

  // Closing date: prefer "Month Day, Year" format for the text field
  let closingDateDisplay = fv.closing_date || '';
  if (closingDateDisplay && /^\d{4}-\d{2}-\d{2}/.test(closingDateDisplay)) {
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(closingDateDisplay);
    if (m) closingDateDisplay = months[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
  }

  // NOTE: DocuSeal template 4111319 currently only has signature/date/initial fields.
  // Prefilled data fields (buyer_name, property_address, etc.) do not exist in the template.
  // Phase 2 will add these fields to the template via the DocuSeal UI.
  // For Phase 1, we submit without prefill fields — just signatures.
  const buyerFields = [];
  const sellerFields = [];

  // DOCUSEAL TEMPLATE ROLE MAPPING
  // Template 4111319 (TREC 20-19) uses "First Party" as the role name, not "Buyer"/"Seller".
  // If the template doesn't support those role names, we submit with a single "First Party" role
  // and only include buyer fields for now (Phase 1: buyer-side signing).
  // Phase 2 will require updating the DocuSeal template to support two-party signing.

  const res = await fetch(DOCUSEAL_BASE + '/submissions', {
    method: 'POST',
    headers: { 'X-Auth-Token': DOCUSEAL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      template_id: DOCUSEAL_TREC_20_19_TEMPLATE_ID,
      send_email: false,
      // DocuSeal template only has "First Party" role for Phase 1.
      // Phase 2 will require template redesign to support buyer + seller two-party signing.
      submitters: [
        { role: 'First Party', name: buyerName || fv.buyer_name || 'Buyer', email: buyerEmail || '', fields: buyerFields },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('DocuSeal submission failed (' + res.status + '): ' + text.slice(0, 300));
  }

  const submitters = await res.json();
  const submissionId = (Array.isArray(submitters) && submitters[0]) ? String(submitters[0].submission_id) : null;

  const signers = (Array.isArray(submitters) ? submitters : []).map((s) => ({
    role: s.role,
    name: s.name,
    email: s.email,
    slug: s.slug,
    signingUrl: s.slug ? 'https://docuseal.com/s/' + s.slug : (s.embed_src || null),
    status: s.status,
  }));

  return { submissionId, signers };
}

// ---------------------------------------------------------------------------
// RESALE CONTRACT (TREC 20-18) — 263 AcroForm fields (mandatory since 01/03/2025)
// Field map source: scripts/trec-20-18-field-map-readable.txt (all 263 fields with
// page + x/y coordinates). Legal content source: Shepard-Ventures/Legal/TREC-20-18-
// Field-Dictionary.md (Hadley, 2026-05-29). Complete rebuild 2026-05-29.
// ---------------------------------------------------------------------------
async function fillResaleContract(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // SECTION 1 — PARTIES
  // Page 1: The form text reads "The parties to this contract are ___ (Seller) and ___ (Buyer)"
  // However, the PDF field names are backwards:
  //   '1 PARTIES The parties to this contract are' = Seller blank (despite its name)
  //   'Seller and' = Buyer blank (despite its name)
  // This is a TREC PDF quirk. Fixed 2026-06-15 per Quinn visual QA Round 5.
  safeSetText(form, '1 PARTIES The parties to this contract are', fv.seller_name || '');
  safeSetText(form, 'Seller and', fv.buyer_name || '');

  // SECTION 2 — PROPERTY
  // Page 1 "Texas known as" (y=0.2392) = street address line
  // Page 9 "Address of Property" + Page 11 "Address of Property_2" = address repeats
  // Page 10 "Addr of Prop" = address repeat on broker info page
  // "Contract Concerning" and variants = address header on each page
  const addr = fv.property_address || '';
  safeSetText(form, 'Texas known as', addr);
  safeSetText(form, 'Address of Property', addr);
  safeSetText(form, 'Address of Property_2', addr);
  safeSetText(form, 'Addr of Prop', addr);
  safeSetText(form, 'Contract Concerning', addr);
  safeSetText(form, 'Contract Concerning_2', addr);
  safeSetText(form, 'Contract Concerning_3', addr);
  safeSetText(form, 'Contract Concerning_4', addr);

  // Section 2A legal description fields (Page 1)
  // "A LAND Lot" (y=0.2131) = lot number (legal_lot column not in transactions — leave blank)
  // "Block" (y=0.2115) = block number (legal_block column not in transactions — leave blank)
  // "undefined" (y=0.2107) = lot number repeat field (AcroForm quirk — leave blank)
  // "Addition City of" (y=0.2250) = subdivision/addition name (NOT city_state_zip)
  // "County of" (y=0.2258) = county name only (e.g. "Bexar")
  // CRITICAL (2026-06-15): TREC 20-17 §2A has NO SEPARATE "City of ___" blank.
  // The city is embedded in the full property_address that fills "Texas known as".
  // The "Addition City of" field is ONLY for the subdivision name; city fills via property_address.
  // Do NOT try to fill property_city separately — no field exists. Quinn visual QA Round 5 confirmed.
  safeSetText(form, 'A LAND Lot', '');
  safeSetText(form, 'Block', '');
  safeSetText(form, 'undefined', '');
  safeSetText(form, 'Addition City of', fv.legal_description || '');
  safeSetText(form, 'County of', fv.county || '');

  // Section 2C accessories / 2D exclusions
  // "be removed prior to delivery of possession" (Page 1 y=0.5082) = exclusions/items removed
  safeSetText(form, 'be removed prior to delivery of possession', fv.exclusions || fv.items_removed || '');

  // SECTION 3 — SALES PRICE
  // Coordinate map positions on Page 1:
  //   "undefined_2"  y=0.5209 — Section 2 accessories area, NOT a sales price field; leave blank
  //   "undefined_3"  y=0.5880 — 3A: buyer's cash down payment (purchase_price - loan_amount)
  //   "undefined_4"  y=0.6508 — 3B: loan amount (sum of all financing)
  //   "undefined_5"  y=0.6656 — 3C: total sales price (3A + 3B must equal 3C)
  // Per Hadley: 3A is down payment ONLY, NOT closing costs. 3A + 3B = 3C exactly.
  const isFinanced = fv.loan_amount && Number(fv.loan_amount) > 0;
  if (isFinanced) safeCheck(form, 'B Sum of all financing described in the attached');

  // 3A cash/down payment — accept both field names as aliases (2026-06-15)
  // Callers may pass either down_payment_amt or cash_amount; both refer to the same blank
  const cashAmountToFill = fv.down_payment_amt != null && fv.down_payment_amt !== ''
    ? fv.down_payment_amt
    : (fv.cash_amount != null && fv.cash_amount !== '' ? fv.cash_amount : null);
  safeSetText(form, 'undefined_3', cashAmountToFill != null ? formatMoney(cashAmountToFill) : '');

  safeSetText(form, 'undefined_4', fv.loan_amount != null && fv.loan_amount !== '' ? formatMoney(fv.loan_amount) : '');
  safeSetText(form, 'undefined_5', fv.sale_price != null && fv.sale_price !== '' ? formatMoney(fv.sale_price) : '');

  // Section 3 option fee credit checkbox (Page 1 y=0.6309 and Page 6 y=0.6046/0.6050)
  // Per Hadley: "will not be credited" is the overwhelming TX default for sale price.
  // Option fee itself IS credited per 2021 change — that is the Page 6 checkbox.
  if (fv.sale_price_credited === true) {
    safeCheck(form, 'will');
  } else {
    safeCheck(form, 'will not be credited to the Sales Price at closing Time is of the');
  }

  // Page 6 option fee credit checkboxes (y=0.6046/0.6050)
  // Per Hadley: option fee "will be credited" to sales price is now mandatory in 20-18.
  // "will 1.1" = option fee WILL be credited (check this)
  // "will not be credited to the Sales Price at closing Time is of the 1" = not credited (leave unchecked)
  safeCheck(form, 'will 1.1');

  // SECTION 4 — LEASES
  // Coordinate-verified (2026-05-30) against actual AcroForm widget positions on Page 2:
  //   "is"     x=0.7101 y≈0.78 = Section 4A: property IS subject to a residential lease
  //   "is not" x=0.8160 y≈0.78 = Section 4A: property is NOT subject to a residential lease
  //   "2Within" x=0.1242 y≈0.77 = Section 4C.1: seller has delivered NRL copies within ___ days
  //   "3Within" x=0.1231 y≈0.78 = Section 4C.2: seller has NOT delivered NRL copies
  //
  // NOTE: "is" and "is not" were previously (incorrectly) checked based on hoa_exists. The HOA
  // Section 2 disclosure in TREC 20-18 has no AcroForm checkbox — it uses only a text field.
  // Checking "is" for HOA was checking Section 4A, making it appear that the property has a
  // residential lease on every HOA transaction. Fixed 2026-05-30.
  //
  // CRITICAL FIX (2026-06-14): ONLY check "is" or "is not" if explicitly specified.
  // Do NOT auto-default to "is not" if agent didn't specify.
  if (fv.has_tenant_lease === true) {
    safeCheck(form, 'is');
  } else if (fv.has_tenant_lease === false) {
    safeCheck(form, 'is not');
  }
  // If has_tenant_lease is null/undefined, leave both unchecked

  if (fv.has_natural_resource_lease === true) {
    if (fv.nrl_delivered === true) {
      safeCheck(form, '2Within');
    } else {
      safeCheck(form, '3Within');
    }
  }

  // SECTION 5A — EARNEST MONEY
  // Page 2 coordinate map (verified 2026-05-30 against actual widget annotations):
  //   "undefined_6"          nx=0.249 ny=0.111 — Section 5A earnest delivery days (3 calendar days TX standard)
  //   "other party in..."    nx=0.659 ny=0.111 — Section 8A license holder disclosure name; leave blank
  //   "as earnest money to"  nx=0.478 ny=0.124 — Section 5A earnest money DOLLAR amount
  //   "as earnest money to 2" nx=0.798 ny=0.124 — Section 5B option fee DOLLAR amount
  //   "earnest money of"     nx=0.558 ny=0.164 — additional earnest money amount
  //   "to escrow agent within" nx=0.154 ny=0.179 — Section 5A earnest delivery days (alternate field)
  //
  // Page 1:
  //   "to escrow agent within 1" x=0.5505 y=0.9123 — earnest delivery days on page 1 footer
  //
  // Per Hadley: earnest money goes to escrow agent (title company). 3 days is TX standard.
  const earnestDays = fv.earnest_delivery_days != null && fv.earnest_delivery_days !== '' ? String(fv.earnest_delivery_days) : '';
  safeSetText(form, 'undefined_6', earnestDays);
  safeSetText(form, 'to escrow agent within', earnestDays);
  safeSetText(form, 'to escrow agent within 1', earnestDays);
  safeSetText(form, 'as earnest money to', fv.earnest_money != null && fv.earnest_money !== '' ? formatMoney(fv.earnest_money) : '');
  safeSetText(form, 'as earnest money to 2', fv.option_fee != null && fv.option_fee !== '' ? formatMoney(fv.option_fee) : '');
  safeSetText(form, 'earnest money of', fv.additional_earnest_money != null && fv.additional_earnest_money !== '' ? formatMoney(fv.additional_earnest_money) : '');
  // NOTE: "Earnest Money in the form of" is a Page 11 receipts field filled by escrow agent — do not pre-fill.

  // SECTION 5B — TERMINATION OPTION (OPTION PERIOD)
  // Field name CORRECTED 2026-06-15: 'undefined_7' is actually the §5A ESCROW AGENT NAME blank,
  // NOT the option period days field. This was identified during visual QA Round 8 when the
  // value 10 (option_period_days) appeared in the wrong location on the PDF.
  // The real field mapping for §5A page 2 is:
  //   "undefined_6"          y=0.1046 — earnest delivery days
  //   "undefined_7"          y=0.1184 — ESCROW AGENT NAME
  //   "as earnest money to"  y=0.1174 — earnest money dollar amount
  //   "as earnest money to 2" y=0.1178 — option fee dollar amount
  //   "to escrow agent within" y=0.1725 — earnest delivery days (alternate)
  // DEFERRED: §5B option period days field location TBD. Currently unmapped. Visual spec:
  // TREC §5D "Seller grants Buyer the option to terminate... within ___ days" blank.
  // TODO: find the correct AcroForm field name for the option period "days" blank and wire it.
  // Leaving unwritten for now (acceptable; closing date is more critical than option period).
  // safeSetText(form, '[OPTION_PERIOD_FIELD_TBD]', fv.option_period_days != null ? String(fv.option_period_days) : '');

  // "Seller or Listing Broker" (Page 11 y=0.1668) = option fee receipt "Seller or Listing Broker" line
  // Per Hadley (post-Apr 2021): option fee goes to ESCROW AGENT (title company), not seller.
  // This field is the receipts section on Page 11 — leave blank (title company fills at receipt).
  // However current usage maps listing_agent_name here. Per Hadley this field on Page 11
  // is the "Seller or Listing Broker" signature line for option fee receipt — NOT agent-filled.
  // Leave blank. The title company fills Page 11.

  // SECTION 6A — TITLE POLICY
  // "A TITLE POLICY Seller shall furnish to Buyer at" (Page 1 y=0.8180) = Seller pays title (DEFAULT)
  // "Sellers" (Page 2 y=0.5442) = Seller pays title (repeat checkbox on page 2)
  // "Buyers expense no later" (Page 2 y=0.5442) = Buyer pays title (override)
  // Per Hadley: Seller pays owner's title policy is the overwhelming TX standard. BOTH
  // Page 1 and Page 2 checkboxes must be set consistently.
  if (fv.title_buyer_expense === true) {
    safeCheck(form, 'Buyers expense no later');
  } else {
    safeCheck(form, 'A TITLE POLICY Seller shall furnish to Buyer at');
    safeCheck(form, 'Sellers_2');
  }

  // "insurance Title Policy issued by" (Page 2 y=0.5589) = title company name
  safeSetText(form, 'insurance Title Policy issued by', fv.title_company || '');

  // SECTION 5A — ESCROW AGENT NAME (Page 2 §5A)
  // Field: "undefined_7" (x=0.1234, y=0.1184, w=0.2466 on page 2)
  // This field was previously misidentified as option_period_days. Corrected per visual QA
  // Round 8 (2026-06-15). Per Hadley: The escrow agent name is typically the title company.
  safeSetText(form, 'undefined_7', fv.escrow_agent || fv.title_company || '');

  // Section 6A.8 — Survey amendment to title policy
  // "i will not be amended or deleted from the title policy or" (Page 1 y=0.7421) = NOT amended
  // "ii will be amended to read shortages in area at the expense of" (Page 1 y=0.7736) = AMENDED (default)
  // Per Hadley: check 6A.8 amended (protects buyer from survey discrepancies). DEFAULT: CHECKED.
  if (fv.title_area_amendment === false) {
    safeCheck(form, 'i will not be amended or deleted from the title policy or');
  } else {
    safeCheck(form, 'ii will be amended to read shortages in area at the expense of');
  }

  // Title objection days: "receipt or the date specified in this paragraph whichever is earlier"
  // (Page 3 y=0.3287) — days buyer has to object to title commitment. Standard: 5 days.
  safeSetText(form, 'receipt or the date specified in this paragraph whichever is earlier', fv.title_objection_days != null && fv.title_objection_days !== '' ? fv.title_objection_days : '');

  // Exception document objection days: "the Commitment Exception Documents and the survey..."
  // (Page 3 y=0.3411) — days buyer has to object to exception documents. Standard: 5 days.
  safeSetText(form, 'the Commitment Exception Documents and the survey Buyers failure to object within the', fv.exception_objection_days != null && fv.exception_objection_days !== '' ? fv.exception_objection_days : '');

  // SECTION 6C — SURVEY OPTIONS (Page 3 y=0.5899/0.5908)
  // "1Within" (y=0.5899) = C.1: seller provides existing survey + T-47/T-47.1 (DEFAULT)
  // "2 Within" (y=0.5908) = C.2: new survey at buyer's expense
  // Per Hadley: C.1 is the most common option in San Antonio.
  // When C.1 is selected, sub-checkboxes handle who pays for new survey if existing is unacceptable:
  //   "Sellers" (Page 2 y=0.5442 — note: same field name used in 6A!) — this is ambiguous in the PDF
  //   "Buyer" (Page 3 y=0.0957) = buyer pays if existing survey unacceptable
  const surveyOption = fv.survey_option != null && fv.survey_option !== '' ? fv.survey_option : '';
  if (surveyOption === 'c2' || fv.survey_buyer_new === true) {
    safeCheck(form, '2 Within');
  } else if (surveyOption === 'c3' || fv.survey_seller_new === true) {
    // C.3 not a distinct checkbox — TREC 20-18 PDF has no separate "Sellers" checkbox in survey section.
    // "Sellers" on Page 1 (y=0.8641) is in the title expense area, NOT the survey section.
    // Use 1Within (C.1) as the closest match; the seller-provides sub-option has no AcroForm widget.
    safeCheck(form, '1Within');
  } else if (surveyOption === 'c1') {
    // CRITICAL FIX (2026-06-14): ONLY check C.1 if explicitly specified. Do NOT auto-default.
    // C.1 seller provides existing survey
    safeCheck(form, '1Within');
    // Sub-checkbox: if existing survey is unacceptable, who pays for new one?
    // "Buyer" (Page 3 y=0.0957) is the only survey sub-checkbox in the PDF.
    // "Sellers" checkbox exists only on Page 1 (title area) � do NOT check it for survey purposes.
    // Only check "Buyer" if explicitly specified AND seller_provides_survey is true
    if (fv.survey_sellers_expense !== true && fv.seller_provides_survey === true) {
      safeCheck(form, 'Buyer');
    }
  }


  // Section 6C survey delivery days (Page 3 y=0.0971)
  // Actual field name verified against 20-18 map: "than 3 days prior to Closing Date"
  // ("3 days prior" does not exist in the PDF — would silently fail).
  safeSetText(form, 'than 3 days prior to Closing Date', fv.survey_delivery_days != null ? String(fv.survey_delivery_days) : '');

  // Section 6D — Permitted use and property use objection days
  // "Commitment other than items 6A1 through 9 above or which prohibit the following use"
  // (Page 3 y=0.3287) = permitted use text field
  safeSetText(form, 'Commitment other than items 6A1 through 9 above or which prohibit the following use', fv.permitted_use != null && fv.permitted_use !== '' ? fv.permitted_use : '');

  // SECTION 7B — SELLER'S DISCLOSURE NOTICE
  // "Within one" (Page 3 y=0.1811) / "Within two" (y=0.1807) / "Within three" (y=0.1934) /
  // "Within four" (y=0.2574) = SDN delivery option checkboxes
  // "receipt or the date specified..." (y=0.2566 on Page 3) = SDN delivery days
  // When sdn_received === true: SDN already delivered — check the SDN received option
  // For simplicity: leave these SDN checkbox options to agent; only check §22 addendum checkbox.

  // SECTION 7D — PROPERTY CONDITION
  // "1 Buyer accepts the Property As Is" (Page 4 y=0.7998) = As-Is (DEFAULT)
  // "2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the"
  //   (Page 4 y=0.8136) = As-Is with specific required repairs
  // "As Is" (Page 5 y=0.1279) and "As Is except" (Page 5 y=0.1433) = repeat on page 5
  // Per Hadley: As-Is is the overwhelming TX default. Does NOT waive inspection rights.
  if (fv.as_is_with_repairs === true) {
    safeCheck(form, '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the');
    safeCheck(form, 'As Is except');
    safeSetText(form, 'following specific repairs and treatments', fv.required_repairs || '');
    safeSetText(form, 'undefined_13', fv.repairs_additional || '');
  } else {
    safeCheck(form, '1 Buyer accepts the Property As Is');
    safeCheck(form, 'As Is');
  }

  // "upon" (Page 4 y=0.8890) = Seller agrees to complete lender-required repairs
  // This checkbox is in Section 7 area. Per Hadley, standard: seller agrees "upon".
  safeCheck(form, 'upon');

  // Repair completion days before closing (Section 7E)
  // "Within" (Page 4 y=0.8134) = number of days before closing repairs must be complete
  safeSetText(form, 'Within', fv.repair_completion_days != null ? String(fv.repair_completion_days) : '');

  // SECTION 7H — HOME WARRANTY (Residential Service Contract)
  // "service contract in an amount not exceeding" (Page 5 y=0.5361) = seller-paid warranty amount
  // Per Hadley: only fill if seller agreed to provide warranty. Default: blank.
  // (2026-06-15) Added home_warranty_amount alias — callers may pass either service_contract_amount or home_warranty_amount
  const warrantyAmountToFill = fv.service_contract_amount != null && fv.service_contract_amount !== ''
    ? fv.service_contract_amount
    : (fv.home_warranty_amount != null && fv.home_warranty_amount !== '' ? fv.home_warranty_amount : null);
  safeSetText(form, 'service contract in an amount not exceeding', warrantyAmountToFill != null ? formatMoney(warrantyAmountToFill) : '');

  // SECTION 9 — CLOSING DATE
  // "A The closing of the sale will be on or before" (Page 5 y=0.7416) = "Month Day" (no year)
  // "20" (Page 5 y=0.7416) = 2-digit year
  if (fv.closing_date) {
    const cd = String(fv.closing_date);
    if (cd.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd));
      safeSetText(form, '20', formatTwoDigitYear(cd));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd);
    }
  }

  // SECTION 10 — POSSESSION
  // "upon" = possession upon closing and funding (DEFAULT per Hadley)
  // Already checked above (Page 4 y=0.8890 is the same "upon" field)
  // The "upon closing and funding" checkbox is the Page 4 "upon" field already checked.

  // SECTION 11 — SPECIAL PROVISIONS (Page 6, 3-line free text block)
  // "Text3" (y=0.4420) = line 1, "Text3 2" (y=0.4554) = line 2, "Text3 3" (y=0.4687) = line 3
  // Per Hadley: usually blank. Only factual statements/business details, never new legal obligations.
  if (fv.special_provisions) {
    const lines = fv.special_provisions.split('\n');
    safeSetText(form, 'Text3', lines[0] || '');
    safeSetText(form, 'Text3 2', lines[1] || '');
    safeSetText(form, 'Text3 3', lines[2] || '');
  }

  // SECTION 12 — SETTLEMENT AND OTHER EXPENSES
  // Section 12A(1)(b): Seller contribution to buyer's broker fee
  // "Brokers and Sales" (Page 5 y=0.6706) and "Brokers and Sales 2" (y=0.6843) = broker fee contribution fields
  safeSetText(form, 'Brokers and Sales', fv.seller_buyer_broker_contribution != null && fv.seller_buyer_broker_contribution !== '' ? formatMoney(fv.seller_buyer_broker_contribution) : '');

  // Section 12A(1)(c): Seller closing cost credit to buyer.
  // NOTE: "Buyers Expenses as allowed by the lender" (Page 5 x=0.4133 y=0.9605) is one of four footer
  // initials fields at the bottom of Page 5, NOT a closing cost credit field.
  // TREC 20-18 has no dedicated AcroForm field for Section 12 closing cost credit — agents enter it
  // in Special Provisions (Text3/Text3 2/Text3 3 on Page 6) or leave it for manual entry.
  // Do not write buyer_closing_cost_credit into the initials footer.

  // Page 6 seller concession / credited fields
  // "acknowledged by Seller and Buyers agreement to pay Seller 1" (y=0.6050) = seller contribution amount field
  // "acknowledged by Seller and Buyers agreement to pay Seller2" (y=0.6046) = secondary field
  // "acknowledged by Seller and Buyers agreement to pay Seller" (y=0.6173) = third field
  safeSetText(form, 'acknowledged by Seller and Buyers agreement to pay Seller 1', fv.listing_commission_total != null && fv.listing_commission_total !== '' ? formatMoney(fv.listing_commission_total) : '');

  // SECTION 18 — ATTORNEYS
  // "Attorney is" (Page 8 y=0.7283) = buyer's attorney name
  // "Attorney is_2" (Page 8 y=0.7284) = seller's attorney name
  safeSetText(form, 'Attorney is', fv.buyer_attorney || '');
  safeSetText(form, 'Attorney is_2', fv.seller_attorney || '');

  // SECTION 21 — NOTICES (Page 8)
  // "when mailed to handdelivered at or transmitted by fax or electronic transmission as follows"
  //   (Page 8 y=0.1034 x=0.2181) = buyer's notice contact info
  // "undefined_19" (Page 8 y=0.1024 x=0.6307) = seller's notice contact info
  // "at" (Page 8 y=0.1332) = buyer's notice sub-field (address or email)
  // "at_2" (Page 8 y=0.1345) = seller's notice sub-field
  // Per Hadley: DO NOT leave both blank. Use buyer_email as default for buyer notice.
  safeSetText(form, 'when mailed to handdelivered at or transmitted by fax or electronic transmission as follows', fv.notice_address || fv.buyer_email || '');
  safeSetText(form, 'undefined_19', fv.notice_address_2 || fv.seller_email || '');
  safeSetText(form, 'at', fv.buyer_email || '');
  safeSetText(form, 'at_2', fv.seller_email || '');

  // HOA MEMBERSHIP (Page 2, Section 2 membership disclosure)
  // TREC 20-18 Section 2 does not have AcroForm checkboxes for HOA "is/is not" membership.
  // The "is" and "is not" fields in this PDF are Section 4A lease checkboxes (already handled above).
  // Section 2 only has a text field for HOA description — filled here.
  safeSetText(form, '2 MEMBERSHIP IN PROPERTY OWNERS ASSOCIATIONS The Property', fv.hoa_description || '');

  // SECTION 20 — FEDERAL REQUIREMENTS (FIRPTA)
  // Per Hadley: "Seller is not a foreign person" is the default for virtually all TX sellers.
  // The checkbox name in the PDF matches the pre-printed text at Page 8 area.
  // Not a named checkbox in the coordinate map — skip (TREC pre-prints this area).

  // SECTION 22 — AGREEMENT OF PARTIES (addendum checkboxes, Page 8)
  // Coordinates verified against field map. Check only when condition is true.
  // Per Hadley: never auto-check propane or other specialty addenda without explicit flag.
  // (2026-06-15) Added third_party_financing alias and explicit isFinanced check
  const hasFinancingAddendum = isFinanced || fv.financing_addendum === true || fv.third_party_financing === true;
  if (hasFinancingAddendum) {
    safeCheck(form, 'Third Party Financing Addendum');
  }
  if (fv.seller_financing_addendum === true)         safeCheck(form, 'Seller Financing Addendum');
  if (fv.environmental_addendum === true)            safeCheck(form, 'Environmental Assessment Threatened or');
  if (fv.hoa_exists === true || fv.hoa_addendum === true) safeCheck(form, 'Addendum for Property Subject to');
  if (fv.seller_leaseback_addendum === true)         safeCheck(form, 'Sellers Temporary Residential Lease');
  if (fv.short_sale_addendum === true)               safeCheck(form, 'Short Sale Addendum');
  if (fv.buyer_leaseback_addendum === true)          safeCheck(form, 'Buyers Temporary Residential Lease');
  // "Loan Assumption Addendum" (Page 1 y=0.6483) is in the Section 3B financing area — do NOT check for Section 22.
  // "Loan Assumption Addendum_2" (Page 8 y=0.4326) is the correct Section 22 addendum checkbox.
  if (fv.loan_assumption_addendum === true)          safeCheck(form, 'Loan Assumption Addendum_2');
  if (fv.coastal_addendum === true)                  safeCheck(form, 'Addendum for Property Located Seaward');
  if (fv.other_property_addendum === true)           safeCheck(form, 'Addendum for Sale of Other Property by');
  // "Sellers Disclos" (Page 8 y=0.4710) = Lead-Based Paint Addendum (OP-L, pre-1978 properties)
  // "Addend. for Sellers Disclos" (Page 8 y=0.5005) = Seller's Disclosure Notice (OP-H) attachment
  if (fv.lead_paint_addendum === true || (fv.year_built && Number(fv.year_built) < 1978)) {
    safeCheck(form, 'Sellers Disclos');
  }
  if (fv.sdn_received === true || fv.sellers_disclosure_addendum === true) {
    safeCheck(form, 'Addend. for Sellers Disclos');
  }
  if (fv.oil_gas_addendum === true)                  safeCheck(form, 'Addendum for Reservation of Oil Gas');
  if (fv.backup_contract_addendum === true)          safeCheck(form, 'Addendum for BackUp Contract');
  if (fv.propane_addendum === true)                  safeCheck(form, 'Addendum for Property in a Propane Gas');
  if (fv.pid_addendum === true)                      safeCheck(form, 'PID');
  if (fv.exchange_1031 === true)                     safeCheck(form, 'Addendum for Section 1031');
  if (fv.residential_leases_addendum === true || fv.has_tenant_lease === true) {
    safeCheck(form, 'Check Box8');
  }
  if (fv.fixture_leases_addendum === true || fv.has_fixture_lease === true) {
    safeCheck(form, 'Check Box9');
  }
  if (fv.appraisal_addendum === true || (isFinanced && fv.financing_type !== 'fha' && fv.financing_type !== 'va')) {
    safeCheck(form, 'Check box 10');
  }
  safeSetText(form, 'System Service Area', fv.propane_system_area || '');
  safeSetText(form, 'The private transfer fee', fv.private_transfer_fee || '');

  // EXECUTION DATE (Page 9)
  // "EXECUTED the" (y=0.2811) = day number, "day of" (y=0.2837) = month name, "20_2" (y=0.2830) = 2-digit year
  // Per Hadley: buyer's agent fills execution date. Leave seller execution date blank.
  // STRICT MODE (2026-06-14): Do NOT auto-set to today. Only fill if explicitly provided.
  if (fv.execution_date) {
    const execDate = new Date(fv.execution_date);
    const execMonths = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    safeSetText(form, 'EXECUTED the', String(execDate.getUTCDate()));
    safeSetText(form, 'day of', execMonths[execDate.getUTCMonth()]);
    safeSetText(form, '20_2', String(execDate.getUTCFullYear()).slice(2));
  } else {
    // Leave all three fields blank if execution_date not provided
    safeSetText(form, 'EXECUTED the', '');
    safeSetText(form, 'day of', '');
    safeSetText(form, '20_2', '');
  }

  // Effective date field: "Date" (Page 9 y=0.2617 area via Page 11 "Date" field)
  // Per Hadley: leave blank at contract creation — filled when last party accepts.
  if (fv.contract_effective_date) {
    safeSetText(form, 'Date', fv.contract_effective_date);
  }

  // CONTACT EMAILS (Page 8)
  // "Email" (y=0.9252) = buyer email, "Email_2" (y=0.9256) = seller email
  safeSetText(form, 'Email', fv.buyer_email || '');
  safeSetText(form, 'Email_2', fv.seller_email || '');

  // PAGE 10 — BROKER INFORMATION
  // Listing broker = agent representing the seller
  safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm || '');
  safeSetText(form, 'License No_4', fv.listing_broker_license || '');
  safeSetText(form, 'List Assoc Name', fv.listing_agent_name || '');
  safeSetText(form, 'License No_5', fv.listing_agent_license || '');
  safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email || '');
  safeSetText(form, 'Phone_3', fv.listing_agent_phone || '');
  safeSetText(form, 'Licensed Supervisor of Listing Associate', fv.listing_supervisor || '');
  safeSetText(form, 'License No_6', fv.listing_supervisor_license || '');
  safeSetText(form, 'Listing Brokers Office Address', fv.listing_broker_address || '');
  safeSetText(form, 'Phone_4', fv.listing_broker_phone || '');
  safeSetText(form, 'City_2', fv.listing_broker_city || '');
  safeSetText(form, 'State_2', fv.listing_broker_state || '');
  safeSetText(form, 'Zip_2', fv.listing_broker_zip || '');

  // Listing broker representation: "Seller only as Sellers agent" = default (checked)
  if (fv.listing_intermediary === true) {
    safeCheck(form, 'Seller and Buyer as an intermediary');
  } else {
    safeCheck(form, 'Seller only as Sellers agent');
  }

  // Other/selling broker = agent representing the buyer (cooperating agent)
  // STRICT MODE ROUTING (2026-06-14): If other_broker_firm is specified, the
  // selling_agent_name goes in the LEFT column (Other Broker → Associates Name),
  // NOT the RIGHT column (Selling Associates). This follows TREC 20-18 convention
  // for separate brokerages: buy-side cooperating agent is under "Other Broker".
  const otherBrokerFirmProvided = fv.other_broker_firm && String(fv.other_broker_firm).trim();
  const sellingAgentNameProvided = fv.selling_agent_name && String(fv.selling_agent_name).trim();
  const routeToOtherBroker = otherBrokerFirmProvided && sellingAgentNameProvided;

  safeSetText(form, 'Other Broker Firm', fv.other_broker_firm || '');
  safeSetText(form, 'License No', fv.other_broker_license || '');
  // LEFT COLUMN — Other Broker Associate's Name
  // If routing to other broker, use selling_agent_name here; otherwise use other_broker_assoc_name
  safeSetText(form, 'Associates Name numb 1', routeToOtherBroker ? fv.selling_agent_name : (fv.other_broker_assoc_name || ''));
  // RIGHT COLUMN — Selling Associates (intra-firm agent)
  // Only fill if NOT routing to other broker (i.e., same brokerage scenario)
  safeSetText(form, 'Selling Associates Name', routeToOtherBroker ? '' : (fv.selling_agent_name || ''));
  safeSetText(form, 'Selling Associates Name-1', routeToOtherBroker ? '' : (fv.selling_agent_name || ''));
  safeSetText(form, 'License No_2', routeToOtherBroker ? (fv.selling_agent_license || '') : (fv.other_broker_assoc_license || ''));
  safeSetText(form, 'Associates Email Address', routeToOtherBroker ? (fv.selling_agent_email || '') : (fv.other_broker_assoc_email || ''));
  safeSetText(form, 'Phone', fv.other_broker_phone || '');
  safeSetText(form, 'Licensed Supervisor of Associate', fv.other_broker_supervisor || '');
  safeSetText(form, 'License No_3', fv.other_broker_supervisor_license || '');
  safeSetText(form, 'Other Brokers Address', fv.other_broker_address || '');
  safeSetText(form, 'Phone_2', fv.other_broker_address_phone || '');
  safeSetText(form, 'City', fv.other_broker_city || '');
  safeSetText(form, 'State', fv.other_broker_state || '');
  safeSetText(form, 'Zip', fv.other_broker_zip || '');
  safeSetText(form, 'License No_7', routeToOtherBroker ? '' : (fv.selling_agent_license || ''));
  safeSetText(form, 'Selling Associates Email Address', routeToOtherBroker ? '' : (fv.selling_agent_email || ''));
  safeSetText(form, 'Phone_5', routeToOtherBroker ? '' : (fv.selling_agent_phone || ''));
  safeSetText(form, 'Licensed Supervisor of Selling Associate', routeToOtherBroker ? '' : (fv.selling_supervisor || ''));
  safeSetText(form, 'License No_8', routeToOtherBroker ? '' : (fv.selling_supervisor_license || ''));
  safeSetText(form, 'Selling Associates Office Address', routeToOtherBroker ? '' : (fv.selling_broker_address || ''));
  safeSetText(form, 'City_3', routeToOtherBroker ? '' : (fv.selling_broker_city || ''));
  safeSetText(form, 'State_3', routeToOtherBroker ? '' : (fv.selling_broker_state || ''));
  safeSetText(form, 'Zip_3', routeToOtherBroker ? '' : (fv.selling_broker_zip || ''));

  // Selling broker representation: "Buyer only" = default when other broker data present
  if (fv.buyer_only_agent === true || (fv.other_broker_firm && fv.buyer_only_agent !== false)) {
    safeCheck(form, 'Buyer only');
  }

  // BAC commission percentage field (Page 10)
  // "when mailed to" (Page 10 y=0.8023) = BAC dollar/pct amount field in broker compensation disclosure
  // "Percentage" checkbox (y=0.8027) = check if expressing BAC as percentage
  // Per Hadley: leave commission amounts blank unless agent explicitly provides them.
  // AC numb 1 through AC numb 4 are phone area code fields — do NOT use for commission.
  const bac = fv.buyer_agent_commission || fv.buyers_agent_commission_pct || '';
  if (bac) {
    const commStr = String(bac).replace('%', '').trim();
    safeSetText(form, 'when the Listing Brokers fee is received Escrow agent is authorized and directed to pay Other Broker from', commStr);
    safeCheck(form, 'Percentage');
  }

  // PAGE 11 — RECEIPTS (DO NOT PRE-FILL — title company fills when funds arrive)
  // Per Hadley: all Page 11 fields are post-execution, filled by escrow agent.
  // Option Fee Receipt: "is acknowledged" (Page 11 y=0.1205), "Seller or Listing Broker" (y=0.1668)
  // Earnest Money Receipt: "is acknowledged_2" (y=0.2290), "Escrow Agent" (y=0.2617)
  // Additional Earnest: "is acknowledged_3" (y=0.5488)
  // Leave all Page 11 fields blank at contract creation.

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// THIRD PARTY FINANCING ADDENDUM (TREC 40-9/40-11) — 64 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js.
// Every field wired; agent can override via field_values.
//
// PROPERTY
//   [TextField] "Street Address and City" -> property_full
//   [TextField] "Address of Property" -> property_address (repeat)
// LOAN TYPE CHECKBOXES
//   [CheckBox] "1 Conventional Financing" -> financing_conventional
//   [CheckBox] "2 Texas Veterans Loan..." -> financing_tx_veterans
//   [CheckBox] "3 FHA Insured Financing..." -> financing_fha
//   [CheckBox] "4 VA Guaranteed Financing..." -> financing_va
//   [CheckBox] "5 USDA Guaranteed Financing..." -> financing_usda
//   [CheckBox] "6 Reverse Mortgage Financing..." -> financing_reverse
//   [CheckBox] "a A first mortgage loan in the principal amount of" -> first_mortgage (auto if financed)
//   [CheckBox] "b A second mortgage loan in the principal amount of" -> second_mortgage
// CONVENTIONAL LOAN FIELDS
//   [TextField] "any financed PMI premium due in full in 1" -> loan_amount (first conventional loan amount)
//   [TextField] "any financed PMI premium due in full in 2" -> loan_amount_2 (second conventional loan amount)
//   [TextField] "per annum for the first" -> interest_rate_cap
//   [TextField] "shown on Buyers Loan Estimate for the loan not to exceed" -> origination_charges_cap
//   [TextField] "excluding" -> pmi_exclusion
//   [TextField] "any financed PMI premium due in full in 1_2" -> second_loan_amount
//   [TextField] "any financed PMI premium due in full in 2_2" -> second_loan_amount_2
//   [TextField] "per annum for the first_2" -> second_interest_rate_cap
//   [TextField] "shown on Buyers Loan Estimate for the loan not to exceed_2" -> second_origination_charges_cap
// TEXAS VETERANS LOAN
//   [TextField] "for a period in the total amount of" -> tx_vet_loan_amount
//   [TextField] "years at the interest rate established by the" -> tx_vet_loan_years
// FHA LOAN FIELDS
//   [TextField] "undefined" -> fha_loan_section
//   [TextField] "excluding any financed MIP amortizable monthly for not less" -> loan_amount (FHA)
//   [TextField] "than" -> fha_amortization_years
//   [TextField] "years with interest not to exceed_2" -> fha_interest_rate_cap
//   [TextField] "Charges as shown on Buyers Loan Estimate for the loan not to exceed" -> fha_origination_cap
//   [CheckBox] "will not be an FHA insured loan" -> fha_may_not_be_insured
//   [CheckBox] "Check Box2" -> fha_check_box_2
//   [TextField] "Conversion Mortgage loan in the original principal amount of" -> fha_conversion_amount
//   [TextField] "not to exceed" -> fha_conversion_not_exceed
// VA LOAN FIELDS
//   [TextField] "excluding any financed Funding Fee amortizable monthly for not less than" -> loan_amount (VA)
//   [TextField] "years" -> va_amortization_years
//   [TextField] "with interest not to exceed" -> va_interest_rate_cap
//   [TextField] "per annum for the first_4" -> va_per_annum_first
//   [TextField] "Origination Charges as shown on Buyers Loan Estimate for the loan not to exceed" -> va_origination_cap
//   [TextField] "value of the Property established by the Department of Veterans Affairs" -> va_appraised_value
// USDA FIELDS
//   [TextField] "any financed PMI premium or other costs with interest not to exceed" -> usda_loan_amount
// REVERSE MORTGAGE FIELDS
//   [TextField] "excluding_2" -> reverse_exclusion
//   [TextField] "not to exceed_2" -> reverse_not_exceed
//   [TextField] "any financed Funding Fee amortizable monthly for not less than" -> reverse_funding_fee
//   [TextField] "per annum for the first_3" -> reverse_per_annum
//   [TextField] "Text2" -> reverse_text2
// BUYER APPROVAL
//   [CheckBox] "This contract is subject to Buyer obtaining Buyer Approval..." -> buyer_approval (auto if financed)
// MISC LOAN FIELDS
//   [TextField] "Initialed for identification by Buyer" -> buyer_initials
//   [TextField] "undefined_2" -> buyer_initials_page2
//   [TextField] "and Seller" -> seller_initials
//   [TextField] "undefined_3" -> seller_initials_page2
//   [TextField] "Text1" -> misc_text1
//   [TextField] "for the first" -> per_annum_for_first_misc
//   [TextField] "Estimate for the loan not to exceed" -> estimate_misc
//   [CheckBox] "will" -> will_checkbox
//   [CheckBox] "will-1","will-2" -> will_checkbox variants
// ---------------------------------------------------------------------------
async function fillFinancingAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PROPERTY
  const propertyFull = fv.property_full || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  safeSetText(form, 'Street Address and City', propertyFull);
  safeSetText(form, 'Address of Property', fv.property_address || '');

  let ft = String(fv.financing_type || '').toLowerCase();
  const loanAmt = fv.loan_amount != null && fv.loan_amount !== '' ? formatMoney(fv.loan_amount) : '';

  // Default to conventional if loan amount present but no explicit type
  if (!ft && fv.loan_amount && Number(fv.loan_amount) > 0) {
    ft = 'conventional';
  }

  // FIRST MORTGAGE CHECKBOX (auto-checked if any financed loan)
  if (ft && ft !== 'cash') {
    safeCheck(form, 'a A first mortgage loan in the principal amount of');
    safeCheck(form, 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer');
  }
  if (fv.second_mortgage === true) {
    safeCheck(form, 'b A second mortgage loan in the principal amount of');
  }

  // LOAN TYPE — wire each type's fields
  if (ft === 'conventional' || fv.financing_conventional === true) {
    safeCheck(form, '1 Conventional Financing');
    // PRINCIPAL AMOUNT: Field verified from PDF inspector as 'any financed PMI premium due in full in 1'
    safeSetText(form, 'any financed PMI premium due in full in 1', loanAmt);
    // TERM YEARS: Conventional term stored in same "years" field as other loan types
    const loanTermYears = fv.loan_term_years || 30;
    safeSetText(form, 'years', String(loanTermYears));
    // INTEREST RATE: "with interest not to exceed" [X] "% per annum"
    const interestRate = fv.interest_rate_max || '';
    safeSetText(form, 'with interest not to exceed', interestRate);
    // ORIGINATION CHARGES CAP: "shown on Buyers Loan Estimate for the loan not to exceed"
    safeSetText(form, 'shown on Buyers Loan Estimate for the loan not to exceed', fv.origination_charges_cap || '');

    // Second loan (if applicable)
    safeSetText(form, 'any financed PMI premium due in full in 2', fv.second_loan_amount != null && fv.second_loan_amount !== '' ? formatMoney(fv.second_loan_amount) : '');
    safeSetText(form, 'per annum for the first', fv.second_interest_rate_cap || '');
    safeSetText(form, 'shown on Buyers Loan Estimate for the loan not to exceed', fv.second_origination_charges_cap || '');
  }

  if (ft === 'tx_veterans' || fv.financing_tx_veterans === true) {
    safeCheck(form, '2 Texas Veterans Loan A loans from the Texas Veterans Land Board of');
    safeSetText(form, 'for a period in the total amount of', loanAmt);
    safeSetText(form, 'years at the interest rate established by the', fv.tx_vet_loan_years || '');
  }

  if (ft === 'fha' || fv.financing_fha === true) {
    safeCheck(form, '3 FHA Insured Financing A Section');
    // FHA loan amount (principal) — Field verified from PDF: 'excluding any financed MIP amortizable monthly for not less'
    safeSetText(form, 'excluding any financed MIP amortizable monthly for not less', loanAmt);
    // FHA amortization years — Field verified from PDF: 'than'
    const fhaYears = fv.loan_term_years || fv.fha_amortization_years || 30;
    safeSetText(form, 'than', String(fhaYears));
    // FHA interest rate cap — Field verified from PDF: 'years with interest not to exceed_2'
    const fhaRate = fv.interest_rate_max || fv.fha_interest_rate_cap || '';
    safeSetText(form, 'years with interest not to exceed_2', fhaRate);
    // FHA origination charges — Field verified from PDF: 'Charges as shown on Buyers Loan Estimate for the loan not to exceed'
    safeSetText(form, 'Charges as shown on Buyers Loan Estimate for the loan not to exceed', fv.fha_origination_cap || '');
    if (fv.fha_conversion_amount) {
      safeSetText(form, 'Conversion Mortgage loan in the original principal amount of', formatMoney(fv.fha_conversion_amount));
      safeSetText(form, 'not to exceed', fv.fha_conversion_not_exceed || '');
    }
  }

  if (ft === 'va' || fv.financing_va === true) {
    safeCheck(form, '4 VA Guaranteed Financing A VA guaranteed loan of not less than');
    // VA loan amount — Field verified from PDF: 'excluding any financed Funding Fee amortizable monthly for not less than'
    safeSetText(form, 'excluding any financed Funding Fee amortizable monthly for not less than', loanAmt);
    // VA amortization years — Field verified from PDF: 'years'
    const vaYears = fv.loan_term_years || fv.va_amortization_years || 30;
    safeSetText(form, 'years', String(vaYears));
    // VA interest rate — Field verified from PDF: 'with interest not to exceed'
    const vaRate = fv.interest_rate_max || fv.va_interest_rate_cap || '';
    safeSetText(form, 'with interest not to exceed', vaRate);
    // VA per annum first — Field verified from PDF: 'per annum for the first_4'
    safeSetText(form, 'per annum for the first_4', fv.va_per_annum_first || '');
    // VA origination charges — Field verified from PDF: 'Origination Charges as shown on Buyers Loan Estimate for the loan not to exceed'
    safeSetText(form, 'Origination Charges as shown on Buyers Loan Estimate for the loan not to exceed', fv.va_origination_cap || '');
    // VA appraised value
    safeSetText(form, 'value of the Property established by the Department of Veterans Affairs', fv.va_appraised_value != null && fv.va_appraised_value !== '' ? formatMoney(fv.va_appraised_value) : '');
  }

  if (ft === 'usda' || fv.financing_usda === true) {
    safeCheck(form, '5 USDA Guaranteed Financing A USDAguaranteed loan of not less than');
    // USDA loan amount — Field verified from PDF: 'any financed PMI premium or other costs with interest not to exceed'
    // NOTE: This field was incorrectly holding interest_rate_max in tests; ensure only loan amount is set here
    safeSetText(form, 'any financed PMI premium or other costs with interest not to exceed', loanAmt);
    // TODO: Add USDA amortization years and interest rate fields once PDF structure is fully audited
  }

  if (ft === 'reverse' || fv.financing_reverse === true) {
    safeCheck(form, '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity');
    // Reverse mortgage fields — verified from PDF inspection
    safeSetText(form, 'excluding_2', fv.reverse_exclusion || '');
    safeSetText(form, 'not to exceed_2', fv.reverse_not_exceed || '');
    safeSetText(form, 'any financed Funding Fee amortizable monthly for not less than', loanAmt);
    safeSetText(form, 'per annum for the first_3', fv.reverse_per_annum || '');
  }

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// NOTICE OF SELLERS TERMINATION OF CONTRACT — 14 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js.
//
// [TextField] "Street Address and City" -> property_full
// [TextField] "BETWEEN THE UNDERSIGNED SELLER AND" -> seller_name
// [TextField] "BUYER" -> buyer_name
// [RadioGroup] "1 Buyer failed to deliver the earnest money within the time required under Paragraph 5 of"
//   -> termination_reason: "undefined" = earnest money failure, "undefined_2" = other (paragraph)
// [TextField] "2 Other identify the paragraph number of contract or the addendum 1..6"
//   -> termination_other_1..6 (specify other termination reason paragraph references)
// [TextField] "Date" -> contract_effective_date
// [TextField] "Date_2" -> termination_notice_date (defaults to today)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// BUYER TERMINATION NOTICE (TREC 38-7) — FLAT PDF, COORDINATE-BASED
// Uses field map from api/_assets/field-maps/trec-38-7-coords.json
// ---------------------------------------------------------------------------
async function fillTerminationNotice(pdfDoc, fv) {
  const fieldMapModule = require('./_assets/field-maps/trec-38-7-coords.json');
  const { fillFlatPdfFromMap } = require('./_assets/flat-pdf-filler.js');

  // Prepare values with formatting
  const flatFieldValues = {
    buyer_name: fv.buyer_name || '',
    seller_name: fv.seller_name || '',
    property_address: fv.property_address || '',
    contract_effective_date: fv.contract_effective_date ? formatDate(fv.contract_effective_date) : '',
    termination_notice_date: fv.termination_notice_date ? formatDate(fv.termination_notice_date) : formatDate(new Date().toISOString().slice(0, 10)),
    termination_reason: fv.termination_reason || '',
    termination_other_reasons: fv.termination_other_reasons || '',
  };

  await fillFlatPdfFromMap(pdfDoc, flatFieldValues, fieldMapModule);
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
// HOA ADDENDUM (TREC 36-10) — 17 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js.
//
// [TextField] "Street Address and City" -> property_full
// [TextField] "Name of Property Owners Association Association and Phone Number"
//   -> hoa_name + hoa_phone concatenated
// [TextField] "the Subdivision Information to the Buyer If Seller delivers the Subdivision
//   Information Buyer may terminate" -> subdivision_info_days (# of days, default 10)
// [CheckBox] "1 Within" -> subdivision_method_seller_obtains (default: Seller obtains)
// [CheckBox] "undefined" -> subdivision_method_buyer_obtains (Buyer obtains info directly)
// [CheckBox] "3Buyer has received and approved the Subdivision Information before signing
//   the contract Buyer" -> subdivision_buyer_already_received
// [CheckBox] "4Buyer does not require delivery of the Subdivision Information"
//   -> subdivision_not_required
// [TextField] "copy of the Subdivision Information to the Seller"
//   -> subdivision_info_copy_days (days to deliver copy to Seller, default 3)
// [CheckBox] "does" -> requires_updated_resale_cert
// [CheckBox] "does not require an updated resale certificate If Buyer requires an updated
//   resale certificate Seller at" -> no_updated_resale_cert (default)
// [TextField] "D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required
//   at closing by the Association" -> hoa_transfer_fee (reserve deposit amount)
// [CheckBox] "Buyer" -> buyer_pays_title_info (default: Buyer pays)
// [CheckBox] "Seller shall pay the Title Company the cost of obtaining the"
//   -> seller_pays_title_info
// ---------------------------------------------------------------------------
async function fillHoaAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PROPERTY
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  safeSetText(form, 'Street Address and City', addr);

  // HOA NAME + PHONE
  safeSetText(form, 'Name of Property Owners Association Association and Phone Number',
    [fv.hoa_name, fv.hoa_phone].filter(Boolean).join(' '));

  // SUBDIVISION INFORMATION DELIVERY METHOD (Para A)
  // Options: seller_obtains (default), buyer_obtains, already_received, not_required
  var subMethod = fv.subdivision_method || 'seller_obtains';
  if (subMethod === 'buyer_obtains') {
    safeCheck(form, 'undefined');
  } else if (subMethod === 'already_received') {
    safeCheck(form, '3Buyer has received and approved the Subdivision Information before signing the contract Buyer');
  } else if (subMethod === 'not_required') {
    safeCheck(form, '4Buyer does not require delivery of the Subdivision Information');
  } else {
    safeCheck(form, '1 Within');
  }

  // Days to deliver subdivision info (Para A1)
  safeSetText(form, 'the Subdivision Information to the Buyer If Seller delivers the Subdivision Information Buyer may terminate',
    fv.subdivision_info_days != null ? String(fv.subdivision_info_days) : '10');

  // Days for buyer to provide copy to seller (Para A — Buyer obtains option)
  safeSetText(form, 'copy of the Subdivision Information to the Seller',
    fv.subdivision_info_copy_days != null ? String(fv.subdivision_info_copy_days) : '3');

  // UPDATED RESALE CERTIFICATE (Para B)
  if (fv.requires_updated_resale_cert === true) {
    safeCheck(form, 'does');
  } else {
    safeCheck(form, 'does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at');
  }

  // DEPOSITS FOR RESERVES (Para D)
  safeSetText(form, 'D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required at closing by the Association',
    fv.hoa_transfer_fee != null && fv.hoa_transfer_fee !== '' ? formatMoney(fv.hoa_transfer_fee) : '');

  // WHO PAYS FOR SUBDIVISION INFO (Para D — title company cost)
  if (fv.seller_pays_title_info === true) {
    safeCheck(form, 'Seller shall pay the Title Company the cost of obtaining the');
  } else {
    safeCheck(form, 'Buyer');
  }

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// LEAD-BASED PAINT ADDENDUM (OP-L) — 25 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js.
// Required for pre-1978 homes (year_built < 1978).
//
// [TextField] "Street Address and City" -> property_full
// SECTION B — SELLER'S DISCLOSURE
// B1 — Knowledge of lead-based paint/hazards:
//   [CheckBox] "Check Box7" -> seller_aware_of_hazards (B1a: seller IS aware)
//   [CheckBox] "Check Box8" -> seller_no_knowledge (B1b: seller has no knowledge — default)
//   [TextField] "undefined" -> hazard_explanation (if seller aware, explain known hazards)
//   [TextField] "b Seller has no actual knowledge of leadbased paint andor leadbased paint
//     hazards in the Property" -> no_knowledge_statement (auto-filled if no knowledge)
// B2 — Records/reports:
//   [CheckBox] "Check Box9" -> seller_has_records (B2a: seller HAS records/reports)
//   [CheckBox] "Check Box10" -> seller_no_records (B2b: seller has no records — default)
//   [TextField] "undefined_2" -> documents_list (if seller has records, list them)
//   [TextField] "b Seller has no reports or records pertaining to leadbased paint andor
//     leadbased paint hazards in the" -> no_records_statement (auto-filled if no records)
// SECTION C — BUYER'S RIGHTS
//   [CheckBox] "Check Box11" -> buyer_waives_inspection (C1: buyer WAIVES 10-day right)
//   [CheckBox] "Check Box12" -> buyer_retains_inspection (C2: buyer RETAINS — default)
// SECTION D — AGENT ACKNOWLEDGMENTS
//   [CheckBox] "Check Box13" -> agent_acknowledges_receipt (D1: agent acknowledges — default)
//   [CheckBox] "Check Box14" -> agent_acknowledges_pamphlet (D2: EPA pamphlet — default)
// SIGNATURE DATE FIELDS (all 6 filled with today or lead_paint_date)
//   [TextField] "Date","Date_2","Date_3","Date_4","Date_5","Date_6" -> lead_paint_date
// ---------------------------------------------------------------------------
async function fillLeadPaintAddendum(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PROPERTY
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  safeSetText(form, 'Street Address and City', addr);

  // DATE FIELDS — all six signature date slots
  const signDate = fv.lead_paint_date
    ? formatDate(fv.lead_paint_date)
    : formatDate(new Date().toISOString().slice(0, 10));
  ['Date', 'Date_2', 'Date_3', 'Date_4', 'Date_5', 'Date_6'].forEach(function(f) {
    safeSetText(form, f, signDate);
  });

  // SECTION B1 — SELLER KNOWLEDGE OF HAZARDS
  if (fv.seller_aware_of_hazards === true) {
    safeCheck(form, 'Check Box7');
    safeSetText(form, 'undefined', fv.hazard_explanation || '');
  } else {
    safeCheck(form, 'Check Box8');
    safeSetText(form, 'b Seller has no actual knowledge of leadbased paint andor leadbased paint hazards in the Property', '');
  }

  // SECTION B2 — SELLER RECORDS/REPORTS
  if (fv.seller_has_records === true) {
    safeCheck(form, 'Check Box9');
    safeSetText(form, 'undefined_2', fv.documents_list || '');
  } else {
    safeCheck(form, 'Check Box10');
    safeSetText(form, 'b Seller has no reports or records pertaining to leadbased paint andor leadbased paint hazards in the', '');
  }

  // SECTION C — BUYER'S INSPECTION RIGHTS
  if (fv.buyer_waives_inspection === true) {
    safeCheck(form, 'Check Box11');
  } else {
    safeCheck(form, 'Check Box12');
  }

  // SECTION D — AGENT ACKNOWLEDGMENTS (default: both checked)
  if (fv.agent_acknowledges_receipt !== false) safeCheck(form, 'Check Box13');
  if (fv.agent_acknowledges_pamphlet !== false) safeCheck(form, 'Check Box14');

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// SELLER'S DISCLOSURE NOTICE (TREC 55-0) — 179 AcroForm fields (XFA stripped)
// Field map verified via scripts/inspect_all_fields.js.
//
// This form is an Adobe XFA dynamic PDF. pdf-lib strips XFA and writes the AcroForm
// compatibility layer only. The XFA dynamic binding is lost, but field values are
// preserved in the AcroForm widget annotations.
//
// STRUCTURE:
//   subform[0] = Page 1 (property info + question responses 0..59)
//   subform[1] = Page 2 (question responses 60..94, explanation fields)
//   subform[2] = Page 3 (question responses 95..110, seller certifications)
//   subform[4] = Page 5 (signature page)
//
// KEY FIELDS (all auto-wired from transaction or field_values):
//   TextField1[0..6] = property address (repeated on each page header)
//   CheckBox1[0] = seller_occupied (Yes)
//   CheckBox2[0] = seller_not_occupied (No)
//   TextField2[0] = year_built (seller estimate)
//   TextField3[0..110] = Y/N single-character question responses (maxLen=1)
//     -> pass as sdn_responses: [{index: N, value: 'Y'|'N'}]
//     -> or as individual sdn_response_N keys
//   TextField3[31] = seller_notes (general notes, maxLen=255)
//   TextField3[32] = seller_notes_2 (additional notes)
//   TextField3[34] = year_built_field (5-char year in question section)
//   TextField4[0] = seller_name_1 (first seller, page 1)
//   TextField4[1] = seller_name_2 (second seller, page 1)
//   TextField5[0..28] = explanation text boxes
//     -> pass as sdn_explanations: ['text for box 0', 'text for box 1', ...]
//     -> or as individual sdn_explain_N keys
//   CheckBox3[n] = section Yes checkboxes
//   CheckBox4[n] = section No checkboxes
//   CheckBox5[n] = section Unknown checkboxes
//   CheckBox6[n] = Section 15 Yes
//   CheckBox7[n] = Section 15 No
//   TextField1[3..7] = signature page fields (seller names, dates, agent notes)
// ---------------------------------------------------------------------------
async function fillSellersDisclosure(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PROPERTY ADDRESS — all page headers
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) {
    safeSetText(form, 'form1[0].#subform[0].TextField1[0]', addr);
    safeSetText(form, 'form1[0].#subform[1].TextField1[1]', addr);
    safeSetText(form, 'form1[0].#subform[2].TextField1[2]', addr);
    safeSetText(form, 'form1[0].#subform[4].TextField1[3]', addr);
    safeSetText(form, 'form1[0].#subform[4].TextField1[4]', addr);
    safeSetText(form, 'form1[0].#subform[4].TextField1[5]', addr);
    safeSetText(form, 'form1[0].#subform[4].TextField1[6]', addr);
  }

  // SELLER OCCUPANCY
  if (fv.seller_occupied === true) safeCheck(form, 'form1[0].#subform[0].CheckBox1[0]');
  else safeCheck(form, 'form1[0].#subform[0].CheckBox2[0]');

  // YEAR BUILT
  if (fv.year_built) {
    safeSetText(form, 'form1[0].#subform[0].TextField2[0]', String(fv.year_built));
    safeSetText(form, 'form1[0].#subform[0].TextField3[34]', String(fv.year_built).slice(0, 5));
  }

  // SELLER NAMES
  safeSetText(form, 'form1[0].#subform[0].TextField4[0]', fv.seller_name_1 || fv.seller_name || '');
  safeSetText(form, 'form1[0].#subform[0].TextField4[1]', fv.seller_name_2 || '');

  // SELLER NOTES
  safeSetText(form, 'form1[0].#subform[0].TextField3[31]', fv.seller_notes || '');
  safeSetText(form, 'form1[0].#subform[0].TextField3[32]', fv.seller_notes_2 || '');

  // Y/N RESPONSES — TextField3[0..110]
  // Index range -> subform mapping:
  //   0-59   -> subform[0].TextField3[i]
  //   60-94  -> subform[1].TextField3[i]
  //   95-102 -> subform[2].TextField3[i]
  //   103-110 -> subform[4].TextField3[i]
  function sdnFieldName(i) {
    if (i <= 59) return 'form1[0].#subform[0].TextField3[' + i + ']';
    if (i <= 94) return 'form1[0].#subform[1].TextField3[' + i + ']';
    if (i <= 102) return 'form1[0].#subform[2].TextField3[' + i + ']';
    return 'form1[0].#subform[4].TextField3[' + i + ']';
  }

  var responses = fv.sdn_responses || [];
  if (Array.isArray(responses)) {
    responses.forEach(function(r) {
      if (r && r.index != null && r.value != null) {
        var idx = Number(r.index);
        if (idx >= 0 && idx <= 110) {
          safeSetText(form, sdnFieldName(idx), String(r.value).slice(0, 1));
        }
      }
    });
  }
  // Individual sdn_response_N keys (override array)
  for (var i = 0; i <= 110; i++) {
    var key = 'sdn_response_' + i;
    if (fv[key] != null && fv[key] !== '') {
      safeSetText(form, sdnFieldName(i), String(fv[key]).slice(0, 1));
    }
  }

  // EXPLANATION TEXT BOXES — TextField5[0..28]
  // subform[0]: indices 0..3
  // subform[1]: indices 4..16
  // subform[2]: indices 17..25
  // subform[4]: indices 26..28
  function explainFieldName(j) {
    if (j <= 3) return 'form1[0].#subform[0].TextField5[' + j + ']';
    if (j <= 16) return 'form1[0].#subform[1].TextField5[' + j + ']';
    if (j <= 25) return 'form1[0].#subform[2].TextField5[' + j + ']';
    return 'form1[0].#subform[4].TextField5[' + j + ']';
  }

  var explanations = fv.sdn_explanations || [];
  for (var j = 0; j <= 28; j++) {
    var val = (Array.isArray(explanations) ? explanations[j] : null)
           || fv['sdn_explain_' + j]
           || '';
    safeSetText(form, explainFieldName(j), String(val));
  }

  // SECTION-LEVEL YES/NO/UNKNOWN CHECKBOXES
  if (fv.sdn_s0_yes === true) safeCheck(form, 'form1[0].#subform[0].CheckBox3[0]');
  if (fv.sdn_s0_no === true) safeCheck(form, 'form1[0].#subform[0].CheckBox4[0]');
  if (fv.sdn_s0_unknown === true) safeCheck(form, 'form1[0].#subform[0].CheckBox5[0]');
  if (fv.sdn_s1_yes === true) safeCheck(form, 'form1[0].#subform[1].CheckBox3[1]');
  if (fv.sdn_s1_no === true) safeCheck(form, 'form1[0].#subform[1].CheckBox4[1]');
  if (fv.sdn_s1_unknown === true) safeCheck(form, 'form1[0].#subform[1].CheckBox5[1]');
  if (fv.sdn_s2_check1 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox4[2]');
  if (fv.sdn_s2_check2 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox4[3]');
  if (fv.sdn_s2_yes === true) safeCheck(form, 'form1[0].#subform[2].CheckBox3[2]');
  if (fv.sdn_s2_section15_yes_1 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox6[0]');
  if (fv.sdn_s2_section15_no_1 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox7[0]');
  if (fv.sdn_s2_section15_yes_2 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox6[1]');
  if (fv.sdn_s2_section15_no_2 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox7[1]');
  if (fv.sdn_s2_field150 === true) safeCheck(form, 'form1[0].#subform[2].#field[150]');
  if (fv.sdn_s2_field151 === true) safeCheck(form, 'form1[0].#subform[2].#field[151]');
  if (fv.sdn_s2_cb4_4 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox4[4]');
  if (fv.sdn_s2_cb4_5 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox4[5]');
  if (fv.sdn_s2_field154 === true) safeCheck(form, 'form1[0].#subform[2].#field[154]');
  if (fv.sdn_s2_cb4_6 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox4[6]');
  if (fv.sdn_s2_field156 === true) safeCheck(form, 'form1[0].#subform[2].#field[156]');
  if (fv.sdn_s2_cb4_7 === true) safeCheck(form, 'form1[0].#subform[2].CheckBox4[7]');
  if (fv.sdn_s2_field158 === true) safeCheck(form, 'form1[0].#subform[2].#field[158]');

  // SIGNATURE PAGE NOTES
  safeSetText(form, 'form1[0].#subform[4].TextField5[26]', fv.sdn_sig_notes_1 || '');
  safeSetText(form, 'form1[0].#subform[4].TextField5[27]', fv.sdn_sig_notes_2 || '');
  safeSetText(form, 'form1[0].#subform[4].TextField5[28]', fv.sdn_sig_notes_3 || '');
  safeSetText(form, 'form1[0].#subform[4].TextField1[7]', fv.sdn_agent_notes || '');

  return pdfDoc;
}

// ---------------------------------------------------------------------------
// AMENDMENT TO CONTRACT (TREC 39-10) — 45 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js.
// Every field wired. Agent selects amendment type(s) via boolean flags or
// amendment_type shorthand, and passes specific values via field_values.
//
// HEADER FIELDS
//   [TextField] "Street Address and City" -> property_full
//   [TextField] "BROKER FILL IN THE" -> contract_effective_date (broker's effective date)
//   [TextField] "Date" -> contract_effective_date (repeat)
//   [TextField] "Date_2" -> amendment_date (defaults to today)
//   [TextField] "DATE OF FINAL ACCEPTANCE" -> date_of_final_acceptance
//   [TextField] "20_4" -> date_of_final_acceptance year (2-digit)
// PARAGRAPH 1 — SALES PRICE CHANGE
//   [CheckBox] "1 The Sales Price in Paragraph 3 of the contract is" -> amend_sales_price
//   [CheckBox] "will" -> sales_price_will_be_credited
//   [CheckBox] "will not" -> sales_price_will_not_be_credited (default if amend_sales_price)
//   [TextField] "be credited to the Sales Price" -> new_sales_price (money)
//   [TextField] "20_2" -> price_change_year_2digit
// PARAGRAPH 2 — REPAIRS
//   [CheckBox] "2 In addition to any repairs..." -> amend_repairs
//   [TextField] "as follows" -> repairs_description
// PARAGRAPH 3 — CLOSING DATE CHANGE
//   [CheckBox] "3 The date in Paragraph 9 of the contract is changed to" -> amend_closing_date
//   [TextField] "undefined" -> closing_day (day of month, numeric string)
//   [TextField] "undefined_2" -> closing_month (month name)
//   [TextField] "undefined_3" -> closing_year (4-digit year)
//   [TextField] "20" -> closing_year_2digit
// PARAGRAPH 4 — SELLER CONCESSIONS
//   [CheckBox] "4 The amount in Paragraph 12A1b of the contract is changed to" -> amend_seller_concession
//   [TextField] "undefined_5" -> new_seller_concession_amount (money)
// PARAGRAPH 5 — LENDER REPAIRS
//   [CheckBox] "5 The cost of lender required repairs..." -> amend_lender_repairs
//   [TextField] "undefined_4" -> lender_repairs_amount (money)
// PARAGRAPH 6 — ADDITIONAL OPTION FEE / OPTION EXTENSION
//   [CheckBox] "6 Buyer has paid Seller an additional Option Fee of" -> amend_option_fee
//   [TextField] "for an extension of the" -> additional_option_fee_amount (money)
//   [TextField] "contract" -> option_period_days
//   [CheckBox] "Fee" -> option_fee_form_check
//   [CheckBox] "Fee 2" -> option_fee_form_check_2
// PARAGRAPH 7 — WAIVE OPTION RIGHT
//   [CheckBox] "7 Buyer waives the unrestricted right to terminate..." -> amend_waive_option
// PARAGRAPH 8 — BUYER APPROVAL DATE CHANGE
//   [CheckBox] "8 The date for Buyer to give written notice..." -> amend_buyer_approval_date
//   [TextField] "Text6" -> new_buyer_approval_date_text
//   [TextField] "20_3" -> new_buyer_approval_year_2digit (2-digit)
// PARAGRAPH 9 — OTHER MODIFICATIONS (up to 8 text lines)
//   [CheckBox] "9 Other Modifications..." -> amend_other
//   [TextField] "Text3.1" -> other_mod_1
//   [TextField] "Text4.1" -> other_mod_2
//   [TextField] "Text5.1" -> other_mod_3
//   [TextField] "Text7 1" -> other_mod_4
//   [TextField] "Text1" -> other_mod_5
//   [TextField] "Text 8" -> other_mod_6
//   [TextField] "Text 9" -> other_mod_7
//   [TextField] "Text 10" -> other_mod_8
// PARAGRAPH 10 — ADDENDA
//   [CheckBox] "10" -> amend_addenda
// TERMINATION DEADLINE
//   [TextField] "date 5" -> termination_deadline_date
//   [TextField] "20_25" -> termination_deadline_year_2digit
// ---------------------------------------------------------------------------
async function fillAmendment(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PROPERTY + HEADER
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  safeSetText(form, 'Street Address and City', addr);
  if (fv.contract_effective_date) {
    safeSetText(form, 'BROKER FILL IN THE', formatDate(fv.contract_effective_date));
    safeSetText(form, 'Date', formatDate(fv.contract_effective_date));
  }
  const today = new Date().toISOString().slice(0, 10);
  safeSetText(form, 'Date_2', fv.amendment_date ? formatDate(fv.amendment_date) : formatDate(today));
  if (fv.date_of_final_acceptance) {
    safeSetText(form, 'DATE OF FINAL ACCEPTANCE', formatDate(fv.date_of_final_acceptance));
    safeSetText(form, '20_4', formatTwoDigitYear(fv.date_of_final_acceptance));
  }

  // PARAGRAPH 1 — SALES PRICE CHANGE
  if (fv.amend_sales_price === true || fv.amendment_type === 'price_change') {
    safeCheck(form, '1 The Sales Price in Paragraph 3 of the contract is');
    if (fv.new_sales_price != null && fv.new_sales_price !== '') {
      safeSetText(form, 'be credited to the Sales Price', formatMoney(fv.new_sales_price));
    }
    safeSetText(form, '20_2', fv.price_change_year_2digit || '');
    if (fv.sales_price_will_be_credited === true) safeCheck(form, 'will');
    else safeCheck(form, 'will not');
  }

  // PARAGRAPH 2 — REPAIRS
  if (fv.amend_repairs === true) {
    safeCheck(form, '2 In addition to any repairs and treatments otherwise required by the contract Seller at Sellers');
    safeSetText(form, 'as follows', fv.repairs_description || '');
  }

  // PARAGRAPH 3 — CLOSING DATE CHANGE
  if (fv.amend_closing_date === true || fv.amendment_type === 'closing_date') {
    safeCheck(form, '3 The date in Paragraph 9 of the contract is changed to');
    var ncd = fv.new_closing_date || '';
    if (ncd && ncd.includes('-')) {
      var m39 = /^(\d{4})-(\d{2})-(\d{2})/.exec(ncd);
      if (m39) {
        var months39 = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        safeSetText(form, 'undefined', String(parseInt(m39[3], 10)));
        safeSetText(form, 'undefined_2', months39[parseInt(m39[2], 10) - 1]);
        safeSetText(form, 'undefined_3', m39[1]);
        safeSetText(form, '20', m39[1].slice(2));
      }
    } else {
      safeSetText(form, 'undefined', fv.closing_day || '');
      safeSetText(form, 'undefined_2', fv.closing_month || '');
      safeSetText(form, 'undefined_3', fv.closing_year || '');
      safeSetText(form, '20', fv.closing_year_2digit || '');
    }
  }

  // PARAGRAPH 4 — SELLER CONCESSIONS
  if (fv.amend_seller_concession === true) {
    safeCheck(form, '4 The amount in Paragraph 12A1b of the contract is changed to');
    if (fv.new_seller_concession_amount != null && fv.new_seller_concession_amount !== '') {
      safeSetText(form, 'undefined_5', formatMoney(fv.new_seller_concession_amount));
    }
  }

  // PARAGRAPH 5 — LENDER REPAIRS
  if (fv.amend_lender_repairs === true) {
    safeCheck(form, '5 The cost of lender required repairs and treatment as itemized on the attached list will be paid');
    if (fv.lender_repairs_amount != null && fv.lender_repairs_amount !== '') {
      safeSetText(form, 'undefined_4', formatMoney(fv.lender_repairs_amount));
    }
  }

  // PARAGRAPH 6 — ADDITIONAL OPTION FEE / OPTION EXTENSION
  if (fv.amend_option_fee === true || fv.amendment_type === 'option_extension') {
    safeCheck(form, '6 Buyer has paid Seller an additional Option Fee of');
    if (fv.additional_option_fee_amount != null && fv.additional_option_fee_amount !== '') {
      safeSetText(form, 'for an extension of the', formatMoney(fv.additional_option_fee_amount));
    }
    if (fv.option_period_days) safeSetText(form, 'contract', String(fv.option_period_days));
    if (fv.option_fee_form_check === true) safeCheck(form, 'Fee');
    if (fv.option_fee_form_check_2 === true) safeCheck(form, 'Fee 2');
  }

  // PARAGRAPH 7 — WAIVE OPTION
  if (fv.amend_waive_option === true) {
    safeCheck(form, '7 Buyer waives the unrestricted right to terminate the contract for which the Option Fee was paid');
  }

  // PARAGRAPH 8 — BUYER APPROVAL DATE
  if (fv.amend_buyer_approval_date === true) {
    safeCheck(form, '8 The date for Buyer to give written notice to Seller that Buyer cannot obtain Buyer Approval as');
    safeSetText(form, 'Text6', fv.new_buyer_approval_date_text || '');
    safeSetText(form, '20_3', fv.new_buyer_approval_year_2digit || '');
  }

  // PARAGRAPH 9 — OTHER MODIFICATIONS (up to 8 lines)
  var hasOther = fv.amend_other === true || fv.other_mod_1 || (Array.isArray(fv.other_modifications) && fv.other_modifications.length);
  if (hasOther) {
    safeCheck(form, '9 Other Modifications Insert only factual statements and business details applicable to this sale');
    var mods39 = fv.other_modifications || [];
    if (typeof mods39 === 'string') mods39 = [mods39];
    var modFields39 = ['Text3.1','Text4.1','Text5.1','Text7 1','Text1','Text 8','Text 9','Text 10'];
    modFields39.forEach(function(fieldName, idx) {
      var val = fv['other_mod_' + (idx + 1)] || (mods39[idx] != null ? String(mods39[idx]) : '');
      safeSetText(form, fieldName, val);
    });
  }

  // PARAGRAPH 10 — ADDENDA
  if (fv.amend_addenda === true) safeCheck(form, '10');

  // TERMINATION DEADLINE
  if (fv.termination_deadline_date) {
    safeSetText(form, 'date 5', formatDate(fv.termination_deadline_date));
    safeSetText(form, '20_25', formatTwoDigitYear(fv.termination_deadline_date));
  }

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
// TREC 49-1 — Right to Terminate Due to Lender's Appraisal — 11 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js against embedded PDF.
//
// [TextField] "Street Address and City" -> property_full
// [CheckBox] "1 WAIVER Buyer waives Buyers right to terminate the contract under Paragraph 2B of the"
//   -> appraisal_waiver (Buyer waives right entirely)
// [CheckBox] "2 PARTIAL WAIVER Buyer waives Buyers right to terminate the contract under Paragraph 2B"
//   -> appraisal_partial_waiver (Buyer waives if appraised value >= threshold)
// [CheckBox] "3 ADDITIONAL" -> appraisal_additional (additional terms)
// [TextField] "ii the opinion of value is" -> appraised_value (money — minimum acceptable value)
// [TextField] "days after the Effective Date if" -> appraisal_days_after_effective
// [TextField] "than" -> appraisal_price_threshold (sales price threshold for partial waiver)
// ---------------------------------------------------------------------------
async function fillAppraisalTermination(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PROPERTY
  const propertyFull = fv.property_full || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  safeSetText(form, 'Street Address and City', propertyFull);

  // WAIVER TYPE (select one)
  var waiverType = fv.appraisal_waiver_type || (fv.appraisal_waiver === true ? 'full' : fv.appraisal_partial_waiver === true ? 'partial' : '');
  if (waiverType === 'full') {
    safeCheck(form, '1 WAIVER Buyer w aives Buyers right to terminate the contract under Paragraph 2B of the');
  } else if (waiverType === 'partial') {
    safeCheck(form, '2 PARTIAL WAIVER Buyer w aives Buyers right to terminate the contract under Paragraph 2B');
    // Partial waiver: "ii the opinion of value is" = minimum acceptable appraised value
    if (fv.appraised_value != null && fv.appraised_value !== '') {
      safeSetText(form, 'ii the opinion of value is', formatMoney(fv.appraised_value));
    }
    // "days after the Effective Date if" = number of days after effective date for appraisal
    if (fv.appraisal_days_after_effective) {
      safeSetText(form, 'days after the Effective Date if', String(fv.appraisal_days_after_effective));
    }
    // "than" = sales price threshold for partial waiver comparison
    if (fv.sales_price != null && fv.sales_price !== '') {
      safeSetText(form, 'than', formatMoney(fv.sales_price));
    }
  } else if (fv.appraisal_additional === true) {
    safeCheck(form, '3 ADDITIONAL');
    if (fv.appraised_value != null && fv.appraised_value !== '') {
      safeSetText(form, 'ii the opinion of value is', formatMoney(fv.appraised_value));
    }
    if (fv.appraisal_days_after_effective) {
      safeSetText(form, 'days after the Effective Date if', String(fv.appraisal_days_after_effective));
    }
    if (fv.sales_price != null && fv.sales_price !== '') {
      safeSetText(form, 'than', formatMoney(fv.sales_price));
    }
  }

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
// UNIMPROVED PROPERTY CONTRACT (TREC 9-17) — 270 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js against embedded PDF.
// Shares many field names with TREC 20 resale (same TREC template family).
//
// SECTION 1 — PARTIES
//   [TextField] "1 PARTIES The parties to this contract are" -> buyer_name
//   [TextField] "and" -> seller_name
// SECTION 2 — PROPERTY
//   [TextField] "Texas known as" -> property_address (street line)
//   [TextField] "Address of Property" -> property_address (repeat)
//   [TextField] "Address of Property_2" -> property_address (repeat)
//   [TextField] "2 PROPERTY Lot" -> legal_lot
//   [TextField] "Block" -> legal_block (or land_parcel_id)
//   [TextField] "Addition" -> legal_description (subdivision name)
//   [TextField] "City of" -> city_state_zip
//   [TextField] "County of" -> county
//   [TextField] "undefined" -> legal_abstract
//   [TextField] "acres" -> land_acreage
//   [TextField] "$ per acre" -> price_per_acre
//   [TextField] "undefined_2" -> down_payment_amt
//   [TextField] "undefined_3" -> loan_amount (financed portion)
//   [TextField] "undefined_4" -> sale_price (total price)
//   [TextField] "within days" -> title_objection_days
//   [TextField] "undefined_8" -> mineral_rights_notes
// SECTION 5 — EARNEST MONEY
//   [TextField] "earnest money of" -> earnest_money
//   [TextField] "as earnest money to" -> escrow_agent_name
//   [TextField] "agent at" -> escrow_agent_address
//   [TextField] "Option Fee in the form of" -> option_fee
//   [TextField] "Seller or Listing Broker" -> listing_agent_name (option recipient)
//   [TextField] "is acknowledged" -> option_acknowledged_date
//   [TextField] "Earnest Money in the form of" -> earnest_money_form
//   [TextField] "is acknowledged_2" -> earnest_acknowledged_date
//   [TextField] "is acknowledged_3" -> add_earnest_acknowledged_date
//   [TextField] "additional Earnest Money in the form of" -> additional_earnest_form
// SECTION 6 — TITLE
//   [TextField] "title insurance Title Policy issued by" -> title_company
//   [TextField] "Escrow Agent" -> title_company (repeat)
//   [TextField] "Escrow Agent_2" -> title_company
//   [TextField] "Escrow Agent_3" -> title_company
//   [CheckBox] "Buyer" -> buyer_pays_survey
//   [CheckBox] "Seller" -> seller_pays_survey
//   [CheckBox] "i will not be amended or deleted from the title policy or" -> title_exception_not_amended
//   [CheckBox] "ii will be amended to read shortages in area at the expense of" -> title_exception_amended
//   [TextField] "3 days" -> funding_notice_days
//   [TextField] "Buyer must object the earlier of i the Closing Date or ii" -> title_objection_deadline
//   [TextField] "4 days" -> closing_statement_days
// SECTION 8 — PROPERTY CONDITION
//   [CheckBox] "1 Buyer accepts the Property As Is" -> as_is (default)
//   [CheckBox] "2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the" -> as_is_with_repairs
//   [TextField] "following specific repairs and treatments" -> required_repairs
//   [TextField] "undefined_12" -> repairs_additional
// SECTION 9 — CLOSING DATE
//   [TextField] "A The closing of the sale will be on or before" -> closing_date (month+day)
//   [TextField] "20" -> closing_date (2-digit year)
// SECTION 22 — ADDENDUM CHECKBOXES
//   [CheckBox] "Third Party Financing Addendum" -> financing_addendum
//   [CheckBox] "Third Party Financing Addendum_2" -> financing_addendum (repeat)
//   [CheckBox] "Seller Financing Addendum" -> seller_financing_addendum
//   [CheckBox] "Addendum for Coastal Area Property" -> coastal_addendum
//   [CheckBox] "Environmental Assessment Threatened or" -> environmental_addendum
//   [CheckBox] "Addendum for Property Located Seaward" -> seaward_addendum
//   [CheckBox] "Addendum for Sale of Other Property by" -> other_property_addendum
//   [CheckBox] "Addendum for Property in a Propane Gas" -> propane_addendum
//   [CheckBox] "Addendum for Property Subject to" -> hoa_addendum
//   [CheckBox] "Buyers Temporary Residential Lease" -> buyer_leaseback_addendum
//   [CheckBox] "Sellers Temporary Residential Lease" -> seller_leaseback_addendum
//   [CheckBox] "Addendum for Reservation of Oil Gas" -> oil_gas_addendum
//   [CheckBox] "Addendum for BackUp Contract" -> backup_contract_addendum
//   [CheckBox] "Addendum Concerning Right to" -> right_to_terminate_addendum
//   [CheckBox] "PID" -> pid_addendum
//   [CheckBox] "Section 1031 Exchange" -> section_1031_exchange
//   [CheckBox] "Texas Agricultural Development District..." (multiple) -> agri_district_n
//   [CheckBox] "is_2" (multiple) -> agri_district_is_n
// LAND-SPECIFIC CHECKBOXES
//   [CheckBox] "is" -> mineral_rights_included
//   [CheckBox] "is no. 1" -> mineral_rights_excluded_1
//   [CheckBox] "is not 2" -> mineral_rights_excluded_2
//   [CheckBox] "i 1" -> title_option_1
//   [CheckBox] "ii 2" -> title_option_2
//   [CheckBox] "is not subject to" -> not_subject_to_hoa
//   [CheckBox] "Sellers" -> sellers_expense_checkbox
//   [CheckBox] "Buyers expense an owners policy of" -> buyers_expense_owners_policy
//   [CheckBox] "3a" -> price_per_acre_3a
//   [CheckBox] "3b" -> price_per_acre_3b
//   [CheckBox] "proportinately to 3a and 3b" -> price_prorated
//   [CheckBox] "Seller is" -> seller_is_checkbox
//   [CheckBox] "Seller is not" -> seller_is_not_checkbox
//   [CheckBox] "Check dollar amount" -> check_dollar_amount
//   [CheckBox] "Check percentage" -> check_percentage
//   [CheckBox] "Other list" -> other_list_checkbox
//   [CheckBox] "Buyer only as Buyers agent" -> buyer_only_agent
//   [CheckBox] "Seller as Listing Brokers subagent" -> seller_subagent
//   [CheckBox] "Seller and Buyer as an intermediary" -> listing_intermediary
//   [CheckBox] "Seller only as Sellers agent" -> listing_only_seller
//   [CheckBox] "Buyer dollar amount" -> buyer_dollar_amount_checkbox
//   [CheckBox] "Buyer percentage" -> buyer_percentage_checkbox
// PRICE ALLOCATION (Paragraphs 3a/3b for per-acre vs lump sum)
//   [TextField] "% of sales price" -> price_percent_of_sales
//   [TextField] "dollar amount" -> price_dollar_amount
//   [TextField] "agreed to pay dollar amount" -> agreed_dollar_amount
//   [TextField] "agreed to pay percentage" -> agreed_pay_percentage
// EXECUTION
//   [TextField] "Date" -> contract_effective_date
//   [TextField] "EXECUTED the" -> execution_day
//   [TextField] "day of" -> execution_month
//   [TextField] "20_2" -> execution_year_2digit
//   [TextField] "Email" -> buyer_email
//   [TextField] "Email_2" -> seller_email
// BROKER SECTION
//   [TextField] "Listing Broker Firm" -> listing_broker_firm
//   [TextField] "License No_4" -> listing_broker_license
//   [TextField] "License No_5" -> listing_agent_license
//   [TextField] "Listing Associates Email Address" -> listing_agent_email
//   [TextField] "Phone_3" -> listing_agent_phone
//   [TextField] "Licensed Supervisor of Listing Associate" -> listing_supervisor
//   [TextField] "License No_6" -> listing_supervisor_license
//   [TextField] "Listing Brokers Office Address" -> listing_broker_address
//   [TextField] "Phone_4" -> listing_broker_phone
//   [TextField] "City_2" -> listing_broker_city
//   [TextField] "State_2" -> listing_broker_state
//   [TextField] "Zip_2" -> listing_broker_zip
//   [TextField] "Other Broker Firm" -> other_broker_firm
//   [TextField] "License No" -> other_broker_license
//   [TextField] "License No_2" -> other_broker_assoc_license
//   [TextField] "Associates Email Address" -> other_broker_assoc_email
//   [TextField] "Phone" -> other_broker_phone
//   [TextField] "Licensed Supervisor of Associate" -> other_broker_supervisor
//   [TextField] "License No_3" -> other_broker_supervisor_license
//   [TextField] "Other Brokers Address" -> other_broker_address
//   [TextField] "Phone_2" -> other_broker_address_phone
//   [TextField] "City" -> other_broker_city
//   [TextField] "State" -> other_broker_state
//   [TextField] "Zip" -> other_broker_zip
//   [TextField] "Associates Name" -> other_broker_assoc_name
//   [TextField] "Team Name" -> listing_team_name
//   [TextField] "Listing Associates Name" -> listing_agent_name
//   [TextField] "Team Name 2" -> listing_team_name_2
//   [TextField] "Selling Associates Name" -> selling_agent_name
//   [TextField] "Team Name 3" -> selling_team_name
//   [TextField] "License No_7" -> selling_agent_license
//   [TextField] "Selling Associates Email Address" -> selling_agent_email
//   [TextField] "Phone_5" -> selling_agent_phone
//   [TextField] "Licensed Supervisor of Selling Associate" -> selling_supervisor
//   [TextField] "License No_8" -> selling_supervisor_license
//   [TextField] "Selling Associates Office Address" -> selling_broker_address
//   [TextField] "City_3" -> selling_broker_city
//   [TextField] "State_3" -> selling_broker_state
//   [TextField] "Zip_3" -> selling_broker_zip
// RECEIPT SECTION
//   [TextField] "Received by" -> earnest_received_by
//   [TextField] "Address" -> escrow_address
//   [TextField] "City_4" -> escrow_city
//   [TextField] "State_4" -> escrow_state
//   [TextField] "Zip_4" -> escrow_zip
//   [TextField] "Email Address" -> escrow_email
//   [TextField] "DateTime" -> earnest_receipt_datetime
//   [TextField] "Phone_6" -> escrow_phone
//   [TextField] "Fax" -> escrow_fax
//   [TextField] "Received by_2" -> earnest_received_by_2
//   ... (same pattern as TREC 20 escrow receipt section)
// ATTORNEYS
//   [TextField] "Attorney is" -> buyer_attorney
//   [TextField] "Attorney is_2" -> seller_attorney
// INITIALS
//   [TextField] "Initialed for identification by Buyer_2" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer_3" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer_4" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer_5" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer" -> buyer_initials
//   [TextField] "and Seller_2".."and Seller_6" -> seller_initials
// ---------------------------------------------------------------------------
async function fillUnimprovedProperty(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // Load base64 — asset exports { base64Pdf }
  // (Already loaded by fillForm; pdfDoc is passed in)

  // PARTIES
  // Note: First field after "1. PARTIES" is the Seller slot, second field is the Buyer slot
  safeSetText(form, '1 PARTIES The parties to this contract are', fv.seller_name || '');
  safeSetText(form, 'and', fv.buyer_name || '');

  // PROPERTY ADDRESS
  const addr = fv.property_address || '';
  safeSetText(form, 'Texas known as', addr);
  safeSetText(form, 'Address of Property', addr);
  safeSetText(form, 'Address of Property_2', addr);
  safeSetText(form, 'Contract Concerning', addr);
  safeSetText(form, 'Contract Concerning_2', addr);
  safeSetText(form, 'Contract Concerning_3', addr);
  safeSetText(form, 'Contract Concerning_4', addr);
  safeSetText(form, 'Contract Address 8', addr);

  // LEGAL DESCRIPTION (land-specific)
  safeSetText(form, '2 PROPERTY Lot', fv.legal_lot || '');
  safeSetText(form, 'Block', fv.legal_block || fv.land_parcel_id || '');
  safeSetText(form, 'Addition', fv.legal_description || '');
  safeSetText(form, 'undefined', fv.legal_abstract || '');
  safeSetText(form, 'City of', fv.city_state_zip || '');
  safeSetText(form, 'County of', fv.county || '');

  // ACREAGE + PRICE PER ACRE
  safeSetText(form, 'acres', fv.land_acreage != null && fv.land_acreage !== '' ? String(fv.land_acreage) : '');
  safeSetText(form, '$ per acre', fv.price_per_acre != null && fv.price_per_acre !== '' ? formatMoney(fv.price_per_acre) : '');
  safeSetText(form, '% of sales price', fv.price_percent_of_sales || '');
  safeSetText(form, 'dollar amount', fv.price_dollar_amount != null && fv.price_dollar_amount !== '' ? formatMoney(fv.price_dollar_amount) : '');
  safeSetText(form, 'agreed to pay dollar amount', fv.agreed_dollar_amount != null && fv.agreed_dollar_amount !== '' ? formatMoney(fv.agreed_dollar_amount) : '');
  safeSetText(form, 'agreed to pay percentage', fv.agreed_pay_percentage || '');

  // SALES PRICE (Section 3)
  safeSetText(form, 'undefined_2', fv.down_payment_amt != null && fv.down_payment_amt !== '' ? formatMoney(fv.down_payment_amt) : '');
  safeSetText(form, 'undefined_3', fv.loan_amount != null && fv.loan_amount !== '' ? formatMoney(fv.loan_amount) : '');
  safeSetText(form, 'undefined_4', fv.sale_price != null && fv.sale_price !== '' ? formatMoney(fv.sale_price) : '');

  // Price allocation checkboxes
  if (fv.price_per_acre_3a === true) safeCheck(form, '3a');
  if (fv.price_per_acre_3b === true) safeCheck(form, '3b');
  if (fv.price_prorated === true) safeCheck(form, 'proportinately to 3a and 3b');
  if (fv.check_dollar_amount === true) safeCheck(form, 'Check dollar amount');
  if (fv.check_percentage === true) safeCheck(form, 'Check percentage');
  if (fv.other_list_checkbox === true) safeCheck(form, 'Other list');

  // EARNEST MONEY / OPTION FEE (Section 5)
  safeSetText(form, 'earnest money of', fv.earnest_money != null && fv.earnest_money !== '' ? formatMoney(fv.earnest_money) : '');
  safeSetText(form, 'as earnest money to', fv.earnest_money_to || fv.title_company || '');
  safeSetText(form, 'agent at', fv.escrow_agent_address || '');
  safeSetText(form, 'Option Fee in the form of', fv.option_fee != null && fv.option_fee !== '' ? formatMoney(fv.option_fee) : '');
  safeSetText(form, 'Seller or Listing Broker', fv.listing_agent_name || '');
  safeSetText(form, 'is acknowledged', fv.option_acknowledged_date || '');
  safeSetText(form, 'Earnest Money in the form of', fv.earnest_money_form || '');
  safeSetText(form, 'is acknowledged_2', fv.earnest_acknowledged_date || '');
  safeSetText(form, 'is acknowledged_3', fv.add_earnest_acknowledged_date || '');
  safeSetText(form, 'additional Earnest Money in the form of', fv.additional_earnest_form || '');

  // TITLE COMPANY / ESCROW
  safeSetText(form, 'title insurance Title Policy issued by', fv.title_company || '');
  safeSetText(form, 'Escrow Agent', fv.title_company || '');
  safeSetText(form, 'Escrow Agent_2', fv.title_company || '');
  safeSetText(form, 'Escrow Agent_3', fv.title_company || '');
  // Survey expense: default Seller
  if (fv.buyer_pays_survey === true) {
    safeCheck(form, 'Buyer');
  } else {
    safeCheck(form, 'Seller');
  }
  // Title exception handling
  if (fv.title_exception_not_amended !== false) safeCheck(form, 'i will not be amended or deleted from the title policy or');
  safeSetText(form, 'within days', fv.title_objection_days || '');
  safeSetText(form, 'Buyer must object the earlier of i the Closing Date or ii', fv.title_objection_deadline || '');
  safeSetText(form, '3 days', fv.funding_notice_days || '');
  safeSetText(form, '4 days', fv.closing_statement_days || '');

  // MINERAL RIGHTS (TREC 9-17 specific)
  if (fv.mineral_rights_included === true) safeCheck(form, 'is');
  if (fv.mineral_rights_excluded_1 === true) safeCheck(form, 'is no. 1');
  if (fv.mineral_rights_excluded_2 === true) safeCheck(form, 'is not 2');
  safeSetText(form, 'the other party in writing before entering into a contract of sale Disclose if applicable', fv.mineral_rights_notes || '');
  safeSetText(form, 'undefined_8', fv.mineral_rights_extra || '');

  // PROPERTY CONDITION (Section 8)
  if (fv.as_is_with_repairs === true) {
    safeCheck(form, '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the');
    safeSetText(form, 'following specific repairs and treatments', fv.required_repairs || '');
    safeSetText(form, 'undefined_12', fv.repairs_additional || '');
  } else {
    safeCheck(form, '1 Buyer accepts the Property As Is');
  }

  // CLOSING DATE (Section 9)
  if (fv.closing_date) {
    const cd9 = String(fv.closing_date);
    if (cd9.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd9));
      safeSetText(form, '20', formatTwoDigitYear(cd9));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd9);
    }
  }

  // CONTRACT EFFECTIVE DATE
  if (fv.contract_effective_date) {
    const ds9 = String(fv.contract_effective_date).includes('-')
      ? formatDate(fv.contract_effective_date)
      : fv.contract_effective_date;
    safeSetText(form, 'Date', ds9);
  }

  // SURVEY OPTIONS
  if (fv.title_option_1 === true) safeCheck(form, 'i 1');
  if (fv.title_option_2 === true) safeCheck(form, 'ii 2');
  if (fv.not_subject_to_hoa === true) safeCheck(form, 'is not subject to');

  // SELLERS_2 / BUYERS EXPENSE CHECKBOXES
  if (fv.sellers_expense_checkbox === true) safeCheck(form, 'Sellers');
  if (fv.buyers_expense_owners_policy === true) safeCheck(form, 'Buyers expense an owners policy of');
  if (fv.seller_is_checkbox === true) safeCheck(form, 'Seller is');
  if (fv.seller_is_not_checkbox === true) safeCheck(form, 'Seller is not');

  // ADDENDUM CHECKBOXES (Section 22)
  const isFinanced9 = fv.loan_amount && Number(fv.loan_amount) > 0;
  if (isFinanced9 || fv.financing_addendum === true) {
    safeCheck(form, 'Third Party Financing Addendum');
    safeCheck(form, 'Third Party Financing Addendum_2');
  }
  if (fv.seller_financing_addendum === true) {
    safeCheck(form, 'Seller Financing Addendum');
    safeCheck(form, 'Seller Financing Addendum_2');
  }
  if (fv.coastal_addendum === true) safeCheck(form, 'Addendum for Coastal Area Property');
  if (fv.environmental_addendum === true) safeCheck(form, 'Environmental Assessment Threatened or');
  if (fv.seaward_addendum === true) safeCheck(form, 'Addendum for Property Located Seaward');
  if (fv.other_property_addendum === true) safeCheck(form, 'Addendum for Sale of Other Property by');
  if (fv.propane_addendum === true) safeCheck(form, 'Addendum for Property in a Propane Gas');
  if (fv.hoa_addendum_check === true) safeCheck(form, 'Addendum for Property Subject to');
  if (fv.buyer_leaseback_addendum === true) safeCheck(form, 'Buyers Temporary Residential Lease');
  if (fv.seller_leaseback_addendum === true) safeCheck(form, 'Sellers Temporary Residential Lease');
  if (fv.oil_gas_addendum === true) safeCheck(form, 'Addendum for Reservation of Oil Gas');
  if (fv.backup_contract_addendum === true) safeCheck(form, 'Addendum for BackUp Contract');
  if (fv.right_to_terminate_addendum === true) safeCheck(form, 'Addendum Concerning Right to');
  if (fv.pid_addendum === true) safeCheck(form, 'PID');
  if (fv.section_1031_exchange === true) safeCheck(form, 'Section 1031 Exchange');

  // OTHER PROPERTY / DISCLOSE FIELDS (land-specific)
  safeSetText(form, 'Disclose', fv.disclose_1 || '');
  safeSetText(form, 'Disclose 2', fv.disclose_2 || '');
  safeSetText(form, 'escrow fee and other expenses payable by Seller under this contract', fv.seller_expense_notes || '');

  // EXECUTION DATE
  if (fv.contract_effective_date) {
    const ced9 = String(fv.contract_effective_date);
    if (ced9.includes('-')) {
      const ced9Parsed = new Date(ced9);
      const months9 = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      safeSetText(form, 'EXECUTED the', String(ced9Parsed.getUTCDate()));
      safeSetText(form, 'day of', months9[ced9Parsed.getUTCMonth()]);
      safeSetText(form, '20_2', ced9.slice(2, 4));
    }
  }
  safeSetText(form, 'Email', fv.buyer_email || '');
  safeSetText(form, 'Email_2', fv.seller_email || '');

  // ATTORNEYS
  safeSetText(form, 'Attorney is', fv.buyer_attorney || '');
  safeSetText(form, 'Attorney is_2', fv.seller_attorney || '');

  // BROKER SECTION
  safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm || '');
  safeSetText(form, 'License No_4', fv.listing_broker_license || '');
  safeSetText(form, 'Listing Associates Name', fv.listing_agent_name || '');
  safeSetText(form, 'Team Name', fv.listing_team_name || '');
  safeSetText(form, 'License No_5', fv.listing_agent_license || '');
  safeSetText(form, 'Listing Associates Email Address', fv.listing_agent_email || '');
  safeSetText(form, 'Phone_3', fv.listing_agent_phone || '');
  safeSetText(form, 'Licensed Supervisor of Listing Associate', fv.listing_supervisor || '');
  safeSetText(form, 'License No_6', fv.listing_supervisor_license || '');
  safeSetText(form, 'Listing Brokers Office Address', fv.listing_broker_address || '');
  safeSetText(form, 'Phone_4', fv.listing_broker_phone || '');
  safeSetText(form, 'City_2', fv.listing_broker_city || '');
  safeSetText(form, 'State_2', fv.listing_broker_state || '');

  safeSetText(form, 'Other Broker Firm', fv.other_broker_firm || '');
  safeSetText(form, 'License No', fv.other_broker_license || '');
  safeSetText(form, 'Associates Name', fv.other_broker_assoc_name || '');
  safeSetText(form, 'Selling Associates Name', fv.selling_agent_name || '');
  safeSetText(form, 'Team Name 2', fv.listing_team_name_2 || '');
  safeSetText(form, 'Team Name 3', fv.selling_team_name || '');
  safeSetText(form, 'License No_2', fv.other_broker_assoc_license || '');
  safeSetText(form, 'Associates Email Address', fv.other_broker_assoc_email || '');
  safeSetText(form, 'Phone', fv.other_broker_phone || '');
  safeSetText(form, 'Licensed Supervisor of Associate', fv.other_broker_supervisor || '');
  safeSetText(form, 'License No_3', fv.other_broker_supervisor_license || '');
  safeSetText(form, 'Other Brokers Address', fv.other_broker_address || '');
  safeSetText(form, 'Phone_2', fv.other_broker_address_phone || '');
  safeSetText(form, 'City', fv.other_broker_city || '');
  safeSetText(form, 'State', fv.other_broker_state || '');
  safeSetText(form, 'Zip', fv.other_broker_zip || '');
  safeSetText(form, 'License No_7', fv.selling_agent_license || '');
  safeSetText(form, 'Selling Associates Email Address', fv.selling_agent_email || '');
  safeSetText(form, 'Phone_5', fv.selling_agent_phone || '');
  safeSetText(form, 'Licensed Supervisor of Selling Associate', fv.selling_supervisor || '');
  safeSetText(form, 'License No_8', fv.selling_supervisor_license || '');
  safeSetText(form, 'Selling Associates Office Address', fv.selling_broker_address || '');
  safeSetText(form, 'City_3', fv.selling_broker_city || '');
  safeSetText(form, 'State_3', fv.selling_broker_state || '');
  safeSetText(form, 'Zip_3', fv.selling_broker_zip || '');
  if (fv.listing_intermediary === true) safeCheck(form, 'Seller and Buyer as an intermediary');
  else safeCheck(form, 'Seller only as Sellers agent');
  if (fv.buyer_only_agent === true) safeCheck(form, 'Buyer only as Buyers agent');
  if (fv.seller_subagent === true) safeCheck(form, 'Seller as Listing Brokers subagent');
  if (fv.buyer_dollar_amount_checkbox === true) safeCheck(form, 'Buyer dollar amount');
  if (fv.buyer_percentage_checkbox === true) safeCheck(form, 'Buyer percentage');

  // ESCROW RECEIPT FIELDS
  safeSetText(form, 'Received by', fv.earnest_received_by || '');
  safeSetText(form, 'Address', fv.escrow_address || '');
  safeSetText(form, 'City_4', fv.escrow_city || '');
  safeSetText(form, 'State_4', fv.escrow_state || '');
  safeSetText(form, 'Zip_4', fv.escrow_zip || '');
  safeSetText(form, 'Email Address', fv.escrow_email || '');
  safeSetText(form, 'DateTime', fv.earnest_receipt_datetime || '');
  safeSetText(form, 'Phone_6', fv.escrow_phone || '');
  safeSetText(form, 'Fax', fv.escrow_fax || '');
  safeSetText(form, 'Received by_2', fv.earnest_received_by_2 || '');
  safeSetText(form, 'Address_2', fv.escrow_address_2 || '');
  safeSetText(form, 'City_5', fv.escrow_city_2 || '');
  safeSetText(form, 'State_5', fv.escrow_state_2 || '');
  safeSetText(form, 'Zip_5', fv.escrow_zip_2 || '');
  safeSetText(form, 'Email Address_2', fv.escrow_email_2 || '');
  safeSetText(form, 'Date_2', fv.earnest_date_2 || '');
  safeSetText(form, 'Phone_7', fv.escrow_phone_2 || '');
  safeSetText(form, 'Fax_2', fv.escrow_fax_2 || '');
  safeSetText(form, 'Received by_3', fv.add_earnest_received_by || '');
  safeSetText(form, 'Address_3', fv.add_escrow_address || '');
  safeSetText(form, 'City_6', fv.add_escrow_city || '');
  safeSetText(form, 'State_6', fv.add_escrow_state || '');
  safeSetText(form, 'Zip_6', fv.add_escrow_zip || '');
  safeSetText(form, 'Email Address_3', fv.add_escrow_email || '');
  safeSetText(form, 'DateTime_2', fv.add_earnest_datetime || '');
  safeSetText(form, 'Phone_8', fv.add_escrow_phone || '');
  safeSetText(form, 'Fax_3', fv.add_escrow_fax || '');

  // NOTICE ADDRESS
  safeSetText(form, 'when mailed to handdelivered at or transmitted by fax or electronic transmission as follows', fv.notice_address || '');

  // BUYER/SELLER SIGNATURE PAGE FIELDS
  safeSetText(form, 'Buyer 4', fv.buyer_name || '');
  safeSetText(form, 'Buyer 5', fv.buyer_name_2 || '');
  safeSetText(form, 'Seller 4', fv.seller_name || '');
  safeSetText(form, 'Seller 5', fv.seller_name_2 || '');

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
// ---------------------------------------------------------------------------
// NEW HOME CONTRACT — INCOMPLETE CONSTRUCTION (TREC 23-20) — FLAT PDF, COORDINATE-BASED
// Uses field map from api/_assets/field-maps/trec-23-20-coords.json
// ---------------------------------------------------------------------------
async function fillNewHomeIncomplete(pdfDoc, fv) {
  const fieldMapModule = require('./_assets/field-maps/trec-23-20-coords.json');
  const { fillFlatPdfFromMap } = require('./_assets/flat-pdf-filler.js');

  // Prepare values with formatting
  const flatFieldValues = {
    buyer_name: fv.buyer_name || '',
    seller_name: fv.seller_name || '',
    property_address_header: fv.property_address || '',
    lot_number: fv.lot_number || '',
    block_number: fv.block_number || '',
    addition_name: fv.legal_description || fv.addition_name || '',
    city_state: fv.city_state || '',
    county: fv.county || '',
    property_zip: fv.property_zip || '',
    cash_down_payment: fv.down_payment_amt ? formatMoney(fv.down_payment_amt) : '',
    loan_amount: fv.loan_amount ? formatMoney(fv.loan_amount) : '',
    total_sales_price: fv.sale_price ? formatMoney(fv.sale_price) : '',
    natural_resource_lease_days: fv.natural_resource_lease_days || '',
    escrow_agent: fv.escrow_agent || fv.title_company || '',
    escrow_agent_address: fv.escrow_agent_address || '',
    earnest_money_amount: fv.earnest_money ? formatMoney(fv.earnest_money) : '',
    option_fee_amount: fv.option_fee ? formatMoney(fv.option_fee) : '',
    additional_earnest_days: fv.additional_earnest_days || '',
    additional_earnest_amount: fv.additional_earnest_amount ? formatMoney(fv.additional_earnest_amount) : '',
    option_period_days: fv.option_period_days || '',
    title_company_name: fv.title_company || '',
    title_company_address: fv.title_company_address || '',
    title_objection_days: fv.title_objection_days || '',
    exception_objection_days: fv.exception_objection_days || '',
    closing_date: fv.closing_date ? formatDate(fv.closing_date) : '',
    completion_date: fv.expected_completion_date ? formatDate(fv.expected_completion_date) : '',
    possession_date: fv.possession_date ? formatDate(fv.possession_date) : '',
    special_provisions: fv.special_provisions || '',
    listing_broker_name: fv.listing_broker_name || '',
    listing_broker_license: fv.listing_broker_license || '',
    listing_agent_name: fv.listing_agent_name || '',
    listing_agent_license: fv.listing_agent_license || '',
    listing_agent_phone: fv.listing_agent_phone || '',
    listing_agent_email: fv.listing_agent_email || '',
    selling_broker_name: fv.selling_broker_name || '',
    selling_broker_license: fv.selling_broker_license || '',
    selling_agent_name: fv.selling_agent_name || '',
    selling_agent_license: fv.selling_agent_license || '',
    selling_agent_phone: fv.selling_agent_phone || '',
    selling_agent_email: fv.selling_agent_email || '',
    contract_effective_date: fv.contract_effective_date ? formatDate(fv.contract_effective_date) : '',
    buyer_initials: fv.buyer_initials || '',
    seller_initials: fv.seller_initials || '',
  };

  await fillFlatPdfFromMap(pdfDoc, flatFieldValues, fieldMapModule);
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// NEW HOME CONTRACT — COMPLETED CONSTRUCTION (TREC 24-18)
// PDF is a flat file with AcroForm dict but 0 named widget fields.
// TREC 24 covers new construction where the home is substantially complete.
// Differs from TREC 23 mainly in the completion/CO sections.
// NOTE: Field names below are best-guess — verify after TREC publishes AcroForm version.
// ---------------------------------------------------------------------------
// NEW HOME CONTRACT — COMPLETED CONSTRUCTION (TREC 24-20) — FLAT PDF, COORDINATE-BASED
// Uses field map from api/_assets/field-maps/trec-24-20-coords.json
// ---------------------------------------------------------------------------
async function fillNewHomeComplete(pdfDoc, fv) {
  const fieldMapModule = require('./_assets/field-maps/trec-24-20-coords.json');
  const { fillFlatPdfFromMap } = require('./_assets/flat-pdf-filler.js');

  // Prepare values with formatting (same structure as TREC 23, with CO/warranty additions)
  const flatFieldValues = {
    buyer_name: fv.buyer_name || '',
    seller_name: fv.seller_name || '',
    property_address_header: fv.property_address || '',
    lot_number: fv.lot_number || '',
    block_number: fv.block_number || '',
    addition_name: fv.legal_description || fv.addition_name || '',
    city_state: fv.city_state || '',
    county: fv.county || '',
    property_zip: fv.property_zip || '',
    cash_down_payment: fv.down_payment_amt ? formatMoney(fv.down_payment_amt) : '',
    loan_amount: fv.loan_amount ? formatMoney(fv.loan_amount) : '',
    total_sales_price: fv.sale_price ? formatMoney(fv.sale_price) : '',
    escrow_agent: fv.escrow_agent || fv.title_company || '',
    escrow_agent_address: fv.escrow_agent_address || '',
    earnest_money_amount: fv.earnest_money ? formatMoney(fv.earnest_money) : '',
    option_fee_amount: fv.option_fee ? formatMoney(fv.option_fee) : '',
    additional_earnest_days: fv.additional_earnest_days || '',
    additional_earnest_amount: fv.additional_earnest_amount ? formatMoney(fv.additional_earnest_amount) : '',
    option_period_days: fv.option_period_days || '',
    title_company_name: fv.title_company || '',
    title_company_address: fv.title_company_address || '',
    title_objection_days: fv.title_objection_days || '',
    exception_objection_days: fv.exception_objection_days || '',
    closing_date: fv.closing_date ? formatDate(fv.closing_date) : '',
    completion_date: fv.co_received_date ? formatDate(fv.co_received_date) : '',
    co_number: fv.co_number || '',
    possession_date: fv.possession_date ? formatDate(fv.possession_date) : '',
    special_provisions: fv.special_provisions || '',
    builder_warranty_company: fv.builder_warranty_company || '',
    listing_broker_name: fv.listing_broker_name || '',
    listing_broker_license: fv.listing_broker_license || '',
    listing_agent_name: fv.listing_agent_name || '',
    listing_agent_license: fv.listing_agent_license || '',
    listing_agent_phone: fv.listing_agent_phone || '',
    listing_agent_email: fv.listing_agent_email || '',
    selling_broker_name: fv.selling_broker_name || '',
    selling_broker_license: fv.selling_broker_license || '',
    selling_agent_name: fv.selling_agent_name || '',
    selling_agent_license: fv.selling_agent_license || '',
    selling_agent_phone: fv.selling_agent_phone || '',
    selling_agent_email: fv.selling_agent_email || '',
    contract_effective_date: fv.contract_effective_date ? formatDate(fv.contract_effective_date) : '',
    buyer_initials: fv.buyer_initials || '',
    seller_initials: fv.seller_initials || '',
  };

  await fillFlatPdfFromMap(pdfDoc, flatFieldValues, fieldMapModule);
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// FARM AND RANCH CONTRACT (TREC 25-17) — FLAT PDF, COORDINATE-BASED
// Uses field map from api/_assets/field-maps/trec-25-17-coords.json
// TREC 25 covers land (acreage) with or without improvements.
// Includes mineral/water rights sections; mineral/oil/gas lease options.
// ---------------------------------------------------------------------------
async function fillFarmRanch(pdfDoc, fv) {
  const fieldMapModule = require('./_assets/field-maps/trec-25-17-coords.json');
  const { fillFlatPdfFromMap } = require('./_assets/flat-pdf-filler.js');

  // Prepare values with formatting
  const flatFieldValues = {
    buyer_name: fv.buyer_name || '',
    seller_name: fv.seller_name || '',
    property_address_header: fv.property_address || '',
    lot_number: fv.lot_number || '',
    block_number: fv.block_number || '',
    section_number: fv.section_number || '',
    township_range: fv.township_range || '',
    abstract_number: fv.abstract_number || '',
    addition_name: fv.legal_description || fv.addition_name || '',
    city_state: fv.city_state || '',
    county: fv.county || '',
    property_zip: fv.property_zip || '',
    land_acres: fv.land_acreage ? String(fv.land_acreage) : '',
    improvements_description: fv.improvements_description || '',
    cash_down_payment: fv.down_payment_amt ? formatMoney(fv.down_payment_amt) : '',
    loan_amount: fv.loan_amount ? formatMoney(fv.loan_amount) : '',
    total_sales_price: fv.sale_price ? formatMoney(fv.sale_price) : '',
    escrow_agent: fv.escrow_agent || fv.title_company || '',
    escrow_agent_address: fv.escrow_agent_address || '',
    earnest_money_amount: fv.earnest_money ? formatMoney(fv.earnest_money) : '',
    option_fee_amount: fv.option_fee ? formatMoney(fv.option_fee) : '',
    option_period_days: fv.option_period_days || '',
    title_company_name: fv.title_company || '',
    title_company_address: fv.title_company_address || '',
    title_objection_days: fv.title_objection_days || '',
    exception_objection_days: fv.exception_objection_days || '',
    closing_date: fv.closing_date ? formatDate(fv.closing_date) : '',
    possession_date: fv.possession_date ? formatDate(fv.possession_date) : '',
    special_provisions: fv.special_provisions || '',
    mineral_rights_provision: fv.mineral_rights_provision || '',
    oil_gas_lease_status: fv.oil_gas_lease_status || '',
    listing_broker_name: fv.listing_broker_name || '',
    listing_broker_license: fv.listing_broker_license || '',
    listing_agent_name: fv.listing_agent_name || '',
    listing_agent_license: fv.listing_agent_license || '',
    listing_agent_phone: fv.listing_agent_phone || '',
    listing_agent_email: fv.listing_agent_email || '',
    selling_broker_name: fv.selling_broker_name || '',
    selling_broker_license: fv.selling_broker_license || '',
    selling_agent_name: fv.selling_agent_name || '',
    selling_agent_license: fv.selling_agent_license || '',
    selling_agent_phone: fv.selling_agent_phone || '',
    selling_agent_email: fv.selling_agent_email || '',
    contract_effective_date: fv.contract_effective_date ? formatDate(fv.contract_effective_date) : '',
    buyer_initials: fv.buyer_initials || '',
    seller_initials: fv.seller_initials || '',
  };

  await fillFlatPdfFromMap(pdfDoc, flatFieldValues, fieldMapModule);
  return pdfDoc;
}


// ---------------------------------------------------------------------------
// SELLER FINANCING ADDENDUM (TREC 26-8)
// 49 fields. Auto-fills property address and note amount from transaction.
// ---------------------------------------------------------------------------
async function fillSellerFinancing(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) {
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Address of Property_2', addr);
  }
  if (fv.loan_amount != null && fv.loan_amount !== '') {
    safeSetText(form, 'C PROMISSORY NOTE The promissory note in the amount of', formatMoney(fv.loan_amount));
  }
  if (fv.seller_financing_interest_rate != null && fv.seller_financing_interest_rate !== '') {
    safeSetText(form, 'of', String(fv.seller_financing_interest_rate));
  }
  if (fv.seller_financing_years != null && fv.seller_financing_years !== '') {
    safeSetText(form, 'monthly thereafter for', String(fv.seller_financing_years));
  }
  safeCheck(form, '2 In monthly installments of');
  safeCheck(form, 'including interest');
  safeCheck(form, 'a Consent Not Required The Property may be sold conveyed or leased without the');
  safeCheck(form, 'a Escrow Not Required Buyer shall furnish Seller before each years ad valorem taxes');
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// BUYER'S TEMPORARY RESIDENTIAL LEASE (TREC 16-7)
// Buyer occupies before closing (max 90 days). Seller = Landlord, Buyer = Tenant.
// ---------------------------------------------------------------------------
async function fillBuyersTempLease(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  if (fv.seller_name) safeSetText(form, '1 PARTIES The parties to this Lease are', fv.seller_name);
  if (fv.buyer_name) safeSetText(form, 'Landlord and', fv.buyer_name);
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'and Tenant as Buyer known as', addr);
  if (fv.property_address) safeSetText(form, 'address', fv.property_address);
  if (fv.closing_date) safeSetText(form, '3 TERM The term of this Lease commences', formatDate(fv.closing_date));
  if (fv.buyers_temp_lease_daily_rate != null && fv.buyers_temp_lease_daily_rate !== '') {
    safeSetText(form, '4 RENTAL Rental will be', String(fv.buyers_temp_lease_daily_rate));
    safeSetText(form, 'pay to Landlord the full amount of rental of', String(fv.buyers_temp_lease_daily_rate));
  }
  if (fv.buyers_temp_lease_deposit != null && fv.buyers_temp_lease_deposit !== '') {
    safeSetText(form, '5 DEPOSIT Tenant has paid to Landlord', formatMoney(fv.buyers_temp_lease_deposit));
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// SELLER'S TEMPORARY RESIDENTIAL LEASE (TREC 15-7)
// Seller stays after closing (max 90 days). Buyer = Landlord, Seller = Tenant.
// ---------------------------------------------------------------------------
async function fillSellersTempLease(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  if (fv.buyer_name) safeSetText(form, '1 PARTIES The parties to this Lease are', fv.buyer_name);
  if (fv.seller_name) safeSetText(form, 'Landlord and', fv.seller_name);
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'and Tenant as Seller known as', addr);
  if (fv.property_address) safeSetText(form, 'address', fv.property_address);
  if (fv.sellers_temp_lease_daily_rate != null && fv.sellers_temp_lease_daily_rate !== '') {
    safeSetText(form, '4 RENTAL  Tenant shall pay to Landlord as rental', String(fv.sellers_temp_lease_daily_rate));
  }
  if (fv.sellers_temp_lease_deposit != null && fv.sellers_temp_lease_deposit !== '') {
    safeSetText(form, '5 DEPOSIT Tenant shall pay to Landlord at the time of funding of the sale', formatMoney(fv.sellers_temp_lease_deposit));
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM FOR SALE OF OTHER PROPERTY BY BUYER (TREC 10-6)
// Contingency addendum — buyer cannot close unless their existing property sells.
// ---------------------------------------------------------------------------
async function fillSaleOtherProperty(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Address of Property', addr);
  if (fv.contingency_property_address) {
    safeSetText(form, 'Address on or before', fv.contingency_property_address);
  }
  if (fv.contingency_date) {
    safeSetText(form, 'Contingency is not satisfied or waived by Buyer by the above date the contract will terminate', formatDate(fv.contingency_date));
    safeSetText(form, '20', formatTwoDigitYear(fv.contingency_date));
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM FOR RESERVATION OF OIL, GAS AND OTHER MINERALS (TREC 44-3)
// 10 fields. Default: seller reserves all minerals (Check Box2).
// ---------------------------------------------------------------------------
async function fillOilGasMinerals(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  if (fv.mineral_percentage_reserved != null && fv.mineral_percentage_reserved !== '') {
    safeSetText(form, 'Seller does not own all of the Mineral Estate Seller reserves only this percentage or fraction of', String(fv.mineral_percentage_reserved));
  }
  if (fv.minerals_reserve_all !== false) safeCheck(form, 'Check Box2');
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM FOR BACK-UP CONTRACT (TREC 11-8)
// 17 fields. Auto-fills property address. Agent fills backup position details.
// ---------------------------------------------------------------------------
async function fillBackupContract(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Address of Property', addr);
  if (fv.backup_amendment_deadline) {
    safeSetText(form, 'Except as provided by this Addendum neither party is required to perform under the', formatDate(fv.backup_amendment_deadline));
    safeSetText(form, '20', formatTwoDigitYear(fv.backup_amendment_deadline));
  }
  if (fv.backup_notice_date) {
    safeSetText(form, '20_2', formatTwoDigitYear(fv.backup_notice_date));
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM FOR COASTAL AREA PROPERTY (TREC 33-2)
// 8 fields. Auto-fills property address. Disclosure form.
// ---------------------------------------------------------------------------
async function fillCoastalArea(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Address of Property', addr);
  if (fv.coastal_exception_1) safeSetText(form, 'described in and subject to this contract except 1', fv.coastal_exception_1);
  if (fv.coastal_exception_2) safeSetText(form, 'described in and subject to this contract except 2', fv.coastal_exception_2);
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM FOR AUTHORIZING HYDROSTATIC TESTING (TREC 48-1)
// 9 fields. Default: Seller liable for test damages.
// ---------------------------------------------------------------------------
async function fillHydrostaticTesting(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  const liability = String(fv.hydrostatic_liability || 'seller').toLowerCase();
  if (liability === 'buyer') {
    safeCheck(form, '2 Buyer shall be liable for damages caused by the hydrostatic plumbing test');
  } else if (liability === 'buyer_capped') {
    safeCheck(form, '3 Buyer shall be liable for damages caused by the hydrostatic plumbing test in an amount not to');
    if (fv.hydrostatic_cap_amount != null && fv.hydrostatic_cap_amount !== '') {
      safeSetText(form, 'exceed', formatMoney(fv.hydrostatic_cap_amount));
    }
  } else {
    safeCheck(form, '1 Seller shall be liable for damages caused by the hydrostatic plumbing test');
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ENVIRONMENTAL ASSESSMENT ADDENDUM (TREC 28-2)
// 9 fields. Default: all three environmental studies required.
// ---------------------------------------------------------------------------
async function fillEnvironmental(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Address of Property', addr);
  if (fv.environmental_days != null && fv.environmental_days !== '') {
    safeSetText(form, 'furnishing Seller a copy of any report noted above that adversely affects the use of the Property', String(fv.environmental_days));
  }
  if (fv.env_assessment !== false) safeCheck(form, 'Check Box1');
  if (fv.env_species !== false) safeCheck(form, 'Check Box2');
  if (fv.env_wetlands !== false) safeCheck(form, 'Check Box3');
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// SHORT SALE ADDENDUM (TREC 45-2)
// 6 fields. Auto-fills property address and lienholder consent deadline.
// ---------------------------------------------------------------------------
async function fillShortSale(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  if (fv.short_sale_deadline) {
    safeSetText(form, 'earnest money will be refunded to Buyer Seller must notify Buyer immediately if Lienholders Consent', formatDate(fv.short_sale_deadline));
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// GULF INTRACOASTAL WATERWAY ADDENDUM (TREC 34-4)
// 5 fields. Auto-fills property address. Disclosure form only.
// ---------------------------------------------------------------------------
async function fillGulfWaterway(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Address of Property', addr);
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// PROPANE GAS ADDENDUM (TREC 47-0)
// 9 fields. Auto-fills property address and today's date for four date slots.
// ---------------------------------------------------------------------------
async function fillPropaneGas(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  const today = formatDate(new Date().toISOString().slice(0, 10));
  safeSetText(form, 'Date', today);
  safeSetText(form, 'Date_2', today);
  safeSetText(form, 'Date_3', today);
  safeSetText(form, 'Date_4', today);
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM REGARDING RESIDENTIAL LEASES (TREC 51-1)
// 16 fields. Default: Buyer has received copies of all leases.
// ---------------------------------------------------------------------------
async function fillResidentialLeases(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  const received = fv.buyer_received_leases !== false;
  if (received) {
    safeCheck(form, '1 a Buyer has received a copy of all Residential Leases');
  } else {
    safeCheck(form, 'b Buyer has not received a copy of all Residential Leases Seller shall provide a copy of the');
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM REGARDING FIXTURE LEASES (TREC 52-1)
// 29 fields. Default: Seller will NOT remove leased fixtures (buyer assumes).
// ---------------------------------------------------------------------------
async function fillFixtureLeases(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) safeSetText(form, 'Street Address and City', addr);
  if (fv.fixture_lease_description) {
    safeSetText(form, 'collectively the Leased Fixtures All rights to the Leased Fixtures are governed by Fixture Leases', fv.fixture_lease_description);
  }
  if (fv.seller_removes_fixtures) {
    safeCheck(form, 'will');
  } else {
    safeCheck(form, 'will not remove the Leased Fixtures covered by the Fixture');
  }
  if (fv.fixture_solar_panels) safeCheck(form, 'solar panels');
  if (fv.fixture_propane_tanks) safeCheck(form, 'propane tanks');
  if (fv.fixture_water_softener) safeCheck(form, 'water softener');
  if (fv.fixture_security_system) safeCheck(form, 'security system');
  const received = fv.buyer_received_fixture_leases !== false;
  if (received) {
    safeCheck(form, '1 Buyer has received a copy of all Fixture Leases Buyer has agreed to assume');
  } else {
    safeCheck(form, '2 Buyer has not received a copy of all Fixture Leases Buyer has agreed to assume Seller shall');
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// ADDENDUM FOR LOAN ASSUMPTION (TREC 41-3)
// 35 fields. Default: first lien, cash adjustment at closing.
// ---------------------------------------------------------------------------
async function fillLoanAssumption(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) {
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Address of Property_2', addr);
  }
  safeCheck(form, '1 The unpaid principal balance of a first lien promissory note payable to');
  if (fv.assumption_lender_name) safeSetText(form, 'undefined', fv.assumption_lender_name);
  if (fv.assumption_balance != null && fv.assumption_balance !== '') {
    safeSetText(form, 'undefined_2', formatMoney(fv.assumption_balance));
    safeSetText(form, 'which unpaid balance at closing will be', formatMoney(fv.assumption_balance));
  }
  if (fv.assumption_monthly_payment != null && fv.assumption_monthly_payment !== '') {
    safeSetText(form, 'The total current monthly payment including principal interest and any reserve deposits is', formatMoney(fv.assumption_monthly_payment));
  }
  if (fv.assumption_interest_rate != null && fv.assumption_interest_rate !== '') {
    safeSetText(form, '2 an increase in the interest rate to more than', String(fv.assumption_interest_rate));
  }
  safeCheck(form, 'cash payable at closing');
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// IMPROVEMENT DISTRICT ASSESSMENT NOTICE (stub)
// Auto-fills property address. Agent completes assessment details manually.
// ---------------------------------------------------------------------------
async function fillImprovementDistrict(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const addr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  if (addr) {
    safeSetText(form, 'Address of Property', addr);
    safeSetText(form, 'Street Address and City', addr);
  }
  return pdfDoc;
}

// ---------------------------------------------------------------------------
// Load base64 PDF and return filled bytes
// ---------------------------------------------------------------------------
async function fillForm(formType, fieldValues) {
  const config = FORM_CONFIGS[formType];
  if (!config) throw new ValidationError('Unknown form_type: ' + formType);

  const raw = config.getBase64();
  // Assets may export a raw base64 string OR { base64Pdf: '...' }
  const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
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
    case 'seller-financing':      await fillSellerFinancing(pdfDoc, fv); break;
    case 'buyers-temp-lease':     await fillBuyersTempLease(pdfDoc, fv); break;
    case 'sellers-temp-lease':    await fillSellersTempLease(pdfDoc, fv); break;
    case 'sale-other-property':   await fillSaleOtherProperty(pdfDoc, fv); break;
    case 'oil-gas-minerals':      await fillOilGasMinerals(pdfDoc, fv); break;
    case 'backup-contract':       await fillBackupContract(pdfDoc, fv); break;
    case 'coastal-area':          await fillCoastalArea(pdfDoc, fv); break;
    case 'hydrostatic-testing':   await fillHydrostaticTesting(pdfDoc, fv); break;
    case 'environmental':         await fillEnvironmental(pdfDoc, fv); break;
    case 'short-sale':            await fillShortSale(pdfDoc, fv); break;
    case 'gulf-waterway':         await fillGulfWaterway(pdfDoc, fv); break;
    case 'propane-gas':           await fillPropaneGas(pdfDoc, fv); break;
    case 'residential-leases':    await fillResidentialLeases(pdfDoc, fv); break;
    case 'fixture-leases':        await fillFixtureLeases(pdfDoc, fv); break;
    case 'loan-assumption':       await fillLoanAssumption(pdfDoc, fv); break;
    case 'improvement-district':  await fillImprovementDistrict(pdfDoc, fv); break;
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
    const strictMode = body.strict === true;

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
    let tx = null;
    let profile = {};
    if (!strictMode) {
      const txResp = await supabaseRest(
      'transactions?id=eq.' + safeTx + '&user_id=eq.' + safeUid + '&select=id,property_address,city_state_zip,buyer_name,seller_name,seller_email,seller_phone,sale_price,earnest_money,earnest_money_title_company,option_fee,option_days,closing_date,contract_effective_date,county,legal_description,title_company,title_officer_name,loan_amount,financing_type,lender_name,year_built,hoa_name,hoa_phone,hoa_management_company,appraisal_value,appraisal_deadline,transaction_type,land_acreage,land_legal_description,land_parcel_id,builder_name,builder_rep_name,builder_rep_phone,builder_rep_email,builder_warranty_company,co_received_date,co_number,expected_completion_date,service_contract_amount,seller_other_expenses,hoa,as_is,seller_provides_survey,sdn_received,listing_broker_name,listing_broker_license_no,listing_agent_name,listing_agent_license_no,listing_agent_email_addr,listing_agent_phone_no,other_broker_name,other_broker_license_no,other_agent_name,other_agent_license_no,other_agent_email_addr,buyer_agent_commission,down_payment,buyer_email,buyer_notice_name,seller_notice_name,escrow_officer_name&limit=1',
      { method: 'GET' },
    );
    if (!txResp.ok) {
      const text = await txResp.text().catch(function() { return ''; });
      throw new Error('transaction fetch failed (' + txResp.status + '): ' + text.slice(0, 200));
    }
    const txRows = await txResp.json();
    tx = (Array.isArray(txRows) && txRows[0]) || null;
    if (!tx) {
      return res.status(404).json({ ok: false, error: 'Dossier not found.' });
    }
    }

    // Auto-upgrade form type based on transaction_type when the caller sent the generic
    // resale-contract form type but the transaction is actually land or new construction.
    // This fires when the legacy bundle sends trec_number:"20-16" for a non-resale tx.
    let resolvedFormType = formType;
    if (!strictMode && formType === 'resale-contract' && tx && tx.transaction_type) {
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

    if (!strictMode) {
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
    }

    // Normalize transaction data, mirroring normalize_transaction.py
    const ft = strictMode ? null : (tx && tx.financing_type) || (tx && tx.lender_name ? 'conventional' : null);
    // Section 3: down payment — use explicit column if set, else compute from sale_price - loan_amount.
    const rawSalePrice = !strictMode && tx && tx.sale_price != null ? Number(tx.sale_price) : 0;
    const rawLoanAmount = !strictMode && tx && tx.loan_amount != null ? Number(tx.loan_amount) : 0;
    const computedDownPayment = !strictMode && tx && tx.down_payment != null
      ? String(tx.down_payment)
      : (rawSalePrice > 0 && rawSalePrice > rawLoanAmount ? String(rawSalePrice - rawLoanAmount) : '');

    // Broker fields: transaction columns take precedence over agent profile.
    // This lets test contracts specify different brokers than the logged-in agent.
    const listingAgentName    = !strictMode && tx && tx.listing_agent_name    || profile.full_name     || '';
    const listingBrokerFirm   = !strictMode && tx && tx.listing_broker_name   || profile.brokerage     || '';
    const listingAgentPhone   = !strictMode && tx && tx.listing_agent_phone_no|| profile.phone         || '';
    const listingAgentEmail   = !strictMode && tx && tx.listing_agent_email_addr || profile.email      || '';
    const listingAgentLicense = !strictMode && tx && tx.listing_agent_license_no || profile.trec_license_number || '';
    const listingBrokerLicense = !strictMode && tx && tx.listing_broker_license_no || '';

    const txDefaults = {
      buyer_name:              !strictMode && tx && tx.buyer_name ? tx.buyer_name : '',
      seller_name:             !strictMode && tx && tx.seller_name ? tx.seller_name : '',
      // Section 21 Notices — buyer/seller names for notice address block
      buyer_email:             !strictMode && tx && tx.buyer_email ? tx.buyer_email : '',
      seller_email:            !strictMode && tx && tx.seller_email ? tx.seller_email : '',
      seller_phone:            !strictMode && tx && tx.seller_phone ? tx.seller_phone : '',
      notice_address:          tx && (tx.buyer_notice_name || tx.buyer_name) || '',
      notice_address_2:        tx && (tx.seller_notice_name || tx.seller_name) || '',
      property_address:        tx && tx.property_address || '',
      city_state_zip:          tx && tx.city_state_zip || '',
      property_full:           tx && [tx.property_address, tx.city_state_zip].filter(Boolean).join(', ') || '',
      county:                  tx && tx.county || '',
      legal_description:       tx && tx.legal_description || '',
      sale_price:              rawSalePrice > 0 ? String(rawSalePrice) : '',
      // Section 3A: down payment (cash buyer brings to closing)
      down_payment_amt:        computedDownPayment,
      earnest_money:           tx && tx.earnest_money != null ? String(tx.earnest_money) : '',
      earnest_money_to:        tx && (tx.earnest_money_title_company || tx.title_company) || '',
      option_fee:              tx && tx.option_fee != null ? String(tx.option_fee) : '',
      // Section 5: option period days from option_days column
      option_period_days:      tx && tx.option_days != null ? tx.option_days : null,
      closing_date:            tx && tx.closing_date || '',
      contract_effective_date: tx && tx.contract_effective_date || '',
      title_company:           tx && tx.title_company || '',
      // Escrow officer name pre-fills the "Received by" / escrow receipt section
      earnest_received_by:     tx && (tx.escrow_officer_name || tx.title_officer_name) || '',
      loan_amount:             rawLoanAmount > 0 ? String(rawLoanAmount) : '',
      financing_type:          ft || '',
      financing_addendum:      Boolean(ft && ft !== 'cash'),
      financing_conventional:  ft === 'conventional',
      financing_fha:           ft === 'fha',
      financing_va:            ft === 'va',
      // Broker/agent section (listing = agent representing seller in TREC 20)
      listing_agent_name:      listingAgentName,
      listing_broker_firm:     listingBrokerFirm,
      listing_agent_phone:     listingAgentPhone,
      listing_agent_email:     listingAgentEmail,
      listing_agent_license:   listingAgentLicense,
      listing_broker_license:  listingBrokerLicense,
      // Other/selling broker (agent representing buyer)
      other_broker_firm:       tx && tx.other_broker_name      || '',
      other_broker_license:    tx && tx.other_broker_license_no || '',
      other_broker_assoc_name: tx && tx.other_agent_name       || '',
      other_broker_assoc_license: tx && tx.other_agent_license_no || '',
      other_broker_assoc_email: tx && tx.other_agent_email_addr || '',
      selling_agent_name:      tx && tx.other_agent_name       || '',
      selling_agent_license:   tx && tx.other_agent_license_no || '',
      selling_agent_email:     tx && tx.other_agent_email_addr || '',
      // Buyer's agent commission (BAC field in Section 10)
      buyer_agent_commission:  tx && tx.buyer_agent_commission  || '',
      // HOA fields (Block 9B)
      hoa_exists:              tx && tx.hoa === true,
      hoa_name:                tx && tx.hoa_name || '',
      hoa_phone:               tx && tx.hoa_phone || '',
      hoa_management_company:  tx && tx.hoa_management_company || '',
      // Section 22 — HOA addendum checkbox (auto-set when hoa===true)
      hoa_addendum:            tx && tx.hoa === true,
      // Section 22 — Propane Gas addendum: only check when explicitly true (Bug 4 fix)
      propane_addendum:        tx && tx.propane_gas_addendum === true,
      // Section 7 — Property condition (as-is vs. as-is with repairs)
      // Default: as-is unless explicitly false
      as_is_with_repairs:      tx && tx.as_is === false,
      // Section 6A — Title area/boundaries amendment: default checked per Hadley
      title_area_amendment:    true,
      // Section 6C — Survey option: C.1 (seller provides existing) is default
      survey_option:           tx && tx.seller_provides_survey === true ? 'c1' : 'c1',
      // Section 6.C sub-checkbox: seller pays when seller_provides_survey===true
      survey_sellers_expense:  tx && tx.seller_provides_survey === true,
      // When seller pays survey, uncheck the default "Buyer pays" checkbox behavior
      survey_buyer_expense:    !tx || tx.seller_provides_survey !== true,
      // Section 22 — Sellers Disclosure Notice (OP-H) received checkbox
      sdn_received:            tx && tx.sdn_received === true,
      sellers_disclosure_addendum: tx && tx.sdn_received === true,
      // Section 22 — Lead paint addendum (OP-L): auto-check for pre-1978 homes
      lead_paint_addendum:     tx && tx.year_built != null && Number(tx.year_built) < 1978,
      // Section 22 — TREC 49-1 appraisal addendum: auto for conventional/usda/tx-vet financed
      // (not FHA or VA which have their own appraisal protections)
      appraisal_addendum:      Boolean(rawLoanAmount > 0 && ft && ft !== 'fha' && ft !== 'va'),
      // Section 5A — Earnest delivery days (3 calendar days is TX standard)
      earnest_delivery_days:   null,
      // Section 11 — Optional residential service contract amount
      service_contract_amount: tx && tx.service_contract_amount != null ? String(tx.service_contract_amount) : '',
      // Section 12.B — Other expenses seller pays at closing
      buyer_closing_cost_credit: tx && tx.seller_other_expenses != null ? String(tx.seller_other_expenses) : '',
      // Appraisal fields (Block 10)
      appraised_value:         tx && tx.appraisal_value != null ? String(tx.appraisal_value) : '',
      appraisal_deadline:      tx && tx.appraisal_deadline || '',
      sales_price:             rawSalePrice > 0 ? String(rawSalePrice) : '',
      // Seller name split for T-47 and other multi-seller forms
      seller_name_1:           tx && tx.seller_name || '',
      // Year built for lead paint trigger
      year_built:              tx && tx.year_built || null,
      // Transaction type (used by chat.js routing for form selection)
      transaction_type:        tx && tx.transaction_type || '',
      // Land fields (TREC 9 + TREC 25)
      land_acreage:            tx && tx.land_acreage != null ? String(tx.land_acreage) : '',
      land_legal_description:  tx && tx.land_legal_description || '',
      land_parcel_id:          tx && tx.land_parcel_id || '',
      // Builder/new construction fields (TREC 23 + TREC 24)
      builder_name:            tx && tx.builder_name || '',
      builder_rep_name:        tx && tx.builder_rep_name || '',
      builder_rep_phone:       tx && tx.builder_rep_phone || '',
      builder_rep_email:       tx && tx.builder_rep_email || '',
      builder_warranty_company: tx && tx.builder_warranty_company || '',
      co_received_date:        tx && tx.co_received_date || '',
      co_number:               tx && tx.co_number || '',
      expected_completion_date: tx && tx.expected_completion_date || '',
    };

    // Agent-supplied field_values override transaction defaults

    // In strict mode, skip txDefaults entirely—use ONLY caller's field_values
    const mergedFields = strictMode ? fieldValues : Object.assign({}, txDefaults, fieldValues);

    // STRICT MODE NORMALIZATION (2026-06-14): Combine city + zip into property address if needed
    // TREC 20-18 does NOT have a dedicated "City of ___" field in Section 2A.
    // The city must be part of the full property address (e.g., "123 Main St, Boerne, TX 78006").
    // When caller passes city/zip separately, merge them into property_address.
    if ((mergedFields.city || mergedFields.zip) && !mergedFields.city_state_zip) {
      const addrPart = mergedFields.property_address || '';
      const cityPart = mergedFields.city || '';
      const zipPart = mergedFields.zip || '';
      // Build combined city_state_zip for other forms that need it
      mergedFields.city_state_zip = [cityPart, zipPart].filter(Boolean).join(', ');
      // Also update property_address to include city/zip if not already present
      if (addrPart && !addrPart.includes(cityPart)) {
        mergedFields.property_address = [addrPart, cityPart, zipPart].filter(Boolean).join(', ');
      }
    }

    // VALIDATION: Buyer/seller role integrity check
    // If the transaction has a role, validate that buyer_name and seller_name are on the correct sides.
    if (tx && tx.role && resolvedFormType === 'resale-contract') {
      const hasBuyerName = mergedFields.buyer_name && String(mergedFields.buyer_name).trim();
      const hasSellerName = mergedFields.seller_name && String(mergedFields.seller_name).trim();

      if (tx.role === 'buyer' && hasSellerName && !hasBuyerName) {
        return res.status(400).json({
          ok: false,
          error: 'Buyer name is required for buyer-side contract. The party you named appears to be the seller — please re-state which client is the buyer.',
        });
      }
      if (tx.role === 'listing' && hasBuyerName && !hasSellerName) {
        return res.status(400).json({
          ok: false,
          error: 'Seller name is required for listing-side contract. The party you named appears to be the buyer — please re-state which client is the seller.',
        });
      }
    }

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