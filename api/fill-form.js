// Vercel Serverless Function: /api/fill-form
// Fills a TREC form PDF with field values and uploads to Supabase Storage.
//
// PIVOT (2026-06-17): Uses DocuSeal Prefill API for forms Heath pre-mapped in DocuSeal.
// - resale-contract (TREC 20-17) → DocuSeal 4018208
// - financing-addendum (TREC 40-11) → DocuSeal 4023463
// - hoa-addendum (TREC 36-11) → DocuSeal 4111321
// - lead-paint-addendum (OP-L) → DocuSeal 4023469
// Other forms still use pdf-lib AcroForm (legacy).
//
// POST { transaction_id, form_type, field_values }
// form_type: resale-contract | financing-addendum | hoa-addendum | lead-paint-addendum | ...
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

const { prefillDocuSealTemplate, DOCUSEAL_TEMPLATES } = require('./_assets/docuseal-prefill');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

// Module-scope requires — loaded at cold-start, not per-request.
// Prevents 500 errors on first request to a cold Vercel instance.
const TREC_RESALE_B64 = require('./_assets/trec-resale-base64.js');
const TREC_FINANCING_B64 = require('./_assets/trec-financing-base64.js');
const TREC_TERMINATION_B64 = require('./_assets/trec-termination-base64.js');
const TAR_WIRE_FRAUD_B64 = require('./_assets/tar-wire-fraud-base64.js');
const TREC_HOA_ADDENDUM_B64 = require('./_assets/trec-hoa-addendum-base64.js');
const TREC_LEAD_PAINT_B64 = require('./_assets/trec-lead-paint-base64.js');
const TREC_SELLERS_DISCLOSURE_B64 = require('./_assets/trec-sellers-disclosure-base64.js');
const TREC_39_10_B64 = require('./_assets/trec-39-10-base64.js');
const TAR_BUYER_REP_B64 = require('./_assets/tar-buyer-rep-base64.js');
const TREC_49_1_B64 = require('./_assets/trec-49-1-base64.js');
const T47_AFFIDAVIT_B64 = require('./_assets/t47-affidavit-base64.js');
const TREC_UNIMPROVED_PROPERTY_B64 = require('./_assets/trec-unimproved-property-base64.js');
const TREC_NEW_HOME_INCOMPLETE_B64 = require('./_assets/trec-new-home-incomplete-base64.js');
const TREC_NEW_HOME_COMPLETE_B64 = require('./_assets/trec-new-home-complete-base64.js');
const TREC_FARM_RANCH_B64 = require('./_assets/trec-farm-ranch-base64.js');
const TREC_SELLER_FINANCING_B64 = require('./_assets/trec-seller-financing-base64.js');
const TREC_BUYERS_TEMP_LEASE_B64 = require('./_assets/trec-buyers-temp-lease-base64.js');
const TREC_SELLERS_TEMP_LEASE_B64 = require('./_assets/trec-sellers-temp-lease-base64.js');
const TREC_SALE_OTHER_PROPERTY_B64 = require('./_assets/trec-sale-other-property-base64.js');
const TREC_OIL_GAS_MINERALS_B64 = require('./_assets/trec-oil-gas-minerals-base64.js');
const TREC_BACKUP_CONTRACT_B64 = require('./_assets/trec-backup-contract-base64.js');
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

function safeUncheck(form, name) {
  try {
    const box = form.getCheckBox(name);
    if (box) box.uncheck();
  } catch (e) {
    console.warn('[fill-form] could not uncheck box', JSON.stringify(name), ':', e && e.message);
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
// RESALE CONTRACT (TREC 20-16/20-17) — 256 AcroForm fields
// Field map verified via scripts/inspect_all_fields.js against embedded PDF.
// Every field is wired. Agent can override any field via field_values.
//
// SECTION 1 — PARTIES
//   [TextField] "1 PARTIES The parties to this contract are" -> buyer_name
//   [TextField] "Seller and" -> seller_name
// SECTION 2 — PROPERTY
//   [TextField] "Texas known as" -> property_address (street address line)
//   [TextField] "Address of Property" -> property_address (repeat)
//   [TextField] "Address of Property_2" -> property_address (repeat)
//   [TextField] "Addr of Prop" -> property_address (repeat, page 2)
//   [TextField] "A LAND Lot" -> legal_description (lot portion)
//   [TextField] "Block" -> legal_block
//   [TextField] "undefined" -> legal_lot (lot number standalone, some versions)
//   [TextField] "Addition City of" -> city_state_zip
//   [TextField] "County of" -> county
// SECTION 3 — SALES PRICE
//   [CheckBox] "B Sum of all financing described in the attached" -> financing_addendum (auto if loan_amount > 0)
//   [TextField] "undefined_2" -> down_payment_amt
//   [TextField] "undefined_3" -> loan_amount
//   [TextField] "undefined_4" -> sale_price
//   [TextField] "undefined_5" -> additional_cash_closing (additional cash at closing)
//   [CheckBox] "will" -> sale_price_credited (sale price credited checkbox)
//   [CheckBox] "will not be credited to the Sales Price at closing Time is of the" -> default checked
// SECTION 5 — EARNEST MONEY / OPTION FEE
//   [TextField] "earnest money of" -> earnest_money
//   [TextField] "Option Fee in the form of" -> option_fee
//   [TextField] "Seller or Listing Broker" -> listing_agent_name (option fee recipient)
//   [TextField] "is acknowledged" -> option_fee_acknowledged (date)
//   [TextField] "Earnest Money in the form of" -> earnest_money_form
//   [TextField] "as earnest money to" -> earnest_money_to (escrow agent name)
//   [TextField] "is acknowledged_2" -> earnest_receipt_date
//   [TextField] "is acknowledged_3" -> additional_earnest_receipt_date
//   [TextField] "additional Earnest Money in the form of" -> additional_earnest_form
// SECTION 6 — TITLE POLICY / SURVEY
//   [TextField] "insurance Title Policy issued by" -> title_company
//   [TextField] "Escrow Agent" -> title_company (repeat for escrow receipts)
//   [TextField] "Escrow Agent_2" -> title_company
//   [TextField] "Escrow Agent_3" -> title_company
//   [TextField] "receipt or the date specified in this paragraph whichever is earlier" -> title_objection_days
//   [TextField] "Commitment other than items 6A1 through 9 above or which prohibit the following use" -> permitted_use
//   [TextField] "the Commitment Exception Documents and the survey Buyers failure to object within the" -> exception_objection_days
//   [CheckBox] "A TITLE POLICY Seller shall furnish to Buyer at" -> title_seller_expense (Seller pays title)
//   [CheckBox] "Sellers" -> survey_sellers_expense
//   [CheckBox] "Buyer" -> survey_buyer_expense (default)
//   [CheckBox] "1Within" -> survey_option_1within
//   [CheckBox] "2 Within" -> survey_option_2within
//   [CheckBox] "2Within" -> title_2within
//   [CheckBox] "3Within" -> title_3within
//   [CheckBox] "Sellers_2" -> sellers2_checkbox
//   [CheckBox] "Buyers expense no later" -> buyers_expense_checkbox
//   [CheckBox] "i will not be amended or deleted from the title policy or" -> title_exception_not_amended
//   [CheckBox] "ii will be amended to read shortages in area at the expense of" -> title_exception_amended
// SECTION 7 — PROPERTY CONDITION
//   [CheckBox] "1 Buyer accepts the Property As Is" -> as_is (default true)
//   [CheckBox] "2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the" -> as_is_with_repairs
//   [TextField] "following specific repairs and treatments" -> required_repairs
//   [TextField] "undefined_13" -> repairs_additional
//   [TextField] "service contract in an amount not exceeding" -> service_contract_amount
// SECTION 9 — CLOSING
//   [TextField] "A The closing of the sale will be on or before" -> closing_date (month + day)
//   [TextField] "20" -> closing_date (2-digit year)
// SECTION 11 — CASUALTY LOSS
//   (no text fields; handled by general doc)
// SECTION 15 — CLOSING COSTS / NOTICES
//   [TextField] "to escrow agent within" -> funding_notice_days
//   [TextField] "to escrow agent within 1" -> funding_notice_days_2
//   [TextField] "than 3 days prior to Closing Date" -> closing_statement_days
// SECTION 18 — MEDIATION / ATTORNEYS
//   [TextField] "Attorney is" -> buyer_attorney
//   [TextField] "Attorney is_2" -> seller_attorney
// SECTION 22 — AGREEMENT OF PARTIES (addendum checkboxes)
//   [CheckBox] "Third Party Financing Addendum" -> financing_addendum
//   [CheckBox] "Seller Financing Addendum" -> seller_financing_addendum
//   [CheckBox] "Environmental Assessment Threatened or" -> environmental_addendum
//   [CheckBox] "Addendum for Property Subject to" -> hoa_addendum (auto if hoa_exists)
//   [CheckBox] "Sellers Temporary Residential Lease" -> seller_leaseback_addendum
//   [CheckBox] "Short Sale Addendum" -> short_sale_addendum
//   [CheckBox] "Buyers Temporary Residential Lease" -> buyer_leaseback_addendum
//   [CheckBox] "Loan Assumption Addendum" -> loan_assumption_addendum
//   [CheckBox] "Loan Assumption Addendum_2" -> loan_assumption_addendum_2
//   [CheckBox] "Addendum for Property Located Seaward" -> coastal_addendum
//   [CheckBox] "Addendum for Sale of Other Property by" -> other_property_addendum
//   [CheckBox] "Addendum for Reservation of Oil Gas" -> oil_gas_addendum
//   [CheckBox] "Addendum for BackUp Contract" -> backup_contract_addendum
//   [CheckBox] "Addendum for Property in a Propane Gas" -> propane_addendum
//   [CheckBox] "Check Box8" -> check_box_8
//   [CheckBox] "Check Box9" -> check_box_9
//   [CheckBox] "Check Box2" -> check_box_2
//   [CheckBox] "Sellers Disclos" -> sellers_disclosure_addendum
//   [CheckBox] "Addend. for Sellers Disclos" -> sellers_disclosure_addendum_2
//   [CheckBox] "Check box 10" -> check_box_10
//   [CheckBox] "Check box 11" -> check_box_11
//   [CheckBox] "As Is" -> as_is_check
//   [CheckBox] "As Is except" -> as_is_except_check
//   [CheckBox] "PID" -> pid_addendum
//   [TextField] "System Service Area" -> propane_system_area
//   [TextField] "The private transfer fee" -> private_transfer_fee
//   [TextField] "2 MEMBERSHIP IN PROPERTY OWNERS ASSOCIATIONS The Property" -> hoa_description
// HOA
//   [CheckBox] "is" -> hoa_exists (property IS subject to HOA)
//   [CheckBox] "is not" -> hoa_not_exists (property is NOT subject — default)
// EXECUTION
//   [TextField] "EXECUTED the" -> execution_day
//   [TextField] "day of" -> execution_month
//   [TextField] "20_2" -> execution_year_2digit
//   [TextField] "Date" -> contract_effective_date
//   [TextField] "Email" -> buyer_email
//   [TextField] "Email_2" -> seller_email
// BROKER SECTION
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
//   [TextField] "Zip_3" -> other_broker_zip_3
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
//   [TextField] "License No_7" -> selling_agent_license
//   [TextField] "Selling Associates Email Address" -> selling_agent_email
//   [TextField] "Phone_5" -> selling_agent_phone
//   [TextField] "Licensed Supervisor of Selling Associate" -> selling_supervisor
//   [TextField] "License No_8" -> selling_supervisor_license
//   [TextField] "Selling Associates Office Address" -> selling_broker_address
//   [TextField] "City_3" -> selling_broker_city
//   [TextField] "State_3" -> selling_broker_state
//   [TextField] "Associates Name" -> other_broker_assoc_name
//   [TextField] "Listing Associates Name" -> listing_agent_name
//   [CheckBox] "Seller only as Sellers agent" -> listing_only_seller_agent
//   [CheckBox] "Seller and Buyer as an intermediary" -> listing_intermediary
//   [TextField] "Selling Associates Name" -> selling_agent_name
//   [CheckBox] "Buyer only" -> buyer_only_agent
//   [CheckBox] "Seller as List Brok Sub agent" -> seller_subagent
//   [TextField] "List Assoc Name" -> listing_agent_name (page 2 repeat)
//   [TextField] "when mailed to handdelivered at or transmitted by fax or electronic transmission as follows" -> notice_address
//   [TextField] "when mailed to" -> notice_address_2
//   [TextField] "at" -> escrow_at
//   [TextField] "at_2" -> escrow_at_2
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
//   [TextField] "Address_2" -> escrow_address_2
//   [TextField] "City_5" -> escrow_city_2
//   [TextField] "State_5" -> escrow_state_2
//   [TextField] "Zip_5" -> escrow_zip_2
//   [TextField] "Email Address_2" -> escrow_email_2
//   [TextField] "Date_2" -> earnest_date_2
//   [TextField] "Phone_7" -> escrow_phone_2
//   [TextField] "Fax_2" -> escrow_fax_2
//   [TextField] "Received by_3" -> add_earnest_received_by
//   [TextField] "Address_3" -> add_escrow_address
//   [TextField] "City_6" -> add_escrow_city
//   [TextField] "State_6" -> add_escrow_state
//   [TextField] "Zip_6" -> add_escrow_zip
//   [TextField] "Email Address_3" -> add_escrow_email
//   [TextField] "DateTime_2" -> add_earnest_datetime
//   [TextField] "Phone_8" -> add_escrow_phone
//   [TextField] "Fax_3" -> add_escrow_fax
//   [CheckBox] "Within one" -> within_one_day
//   [CheckBox] "Within two" -> within_two_days
//   [CheckBox] "Within three" -> within_three_days
//   [CheckBox] "Within four" -> within_four_days
// INITIALS / PAGE HEADERS (auto-filled from buyer/seller names abbreviated)
//   [TextField] "Initialed for identification by Buyer" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer_2" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer_3" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer_4" -> buyer_initials
//   [TextField] "Initialed for identification by Buyer_5" -> buyer_initials
//   [TextField] "and Seller" -> seller_initials
//   [TextField] "and Seller_2" -> seller_initials
//   [TextField] "and Seller_3" -> seller_initials
//   [TextField] "and Seller_4" -> seller_initials
//   [TextField] "and Seller_5" -> seller_initials
//   [TextField] "and Seller_6" -> seller_initials
//   [TextField] "and Seller_7" -> seller_initials
//   [TextField] "Page 2 of 10" -> "Page 2 of 10" (static)
//   [TextField] "Page 3 of 10" -> "Page 3 of 10" (static)
//   [TextField] "Page 7 of 10" -> "Page 7 of 10" (static)
//   [TextField] "Contract Concerning" -> property_address (contract header repeat)
//   [TextField] "Contract Concerning_2" -> property_address
//   [TextField] "Contract Concerning_3" -> property_address
//   [TextField] "Contract Concerning_4" -> property_address
//   [TextField] "the Title Company and Buyers lenders Check one box only" -> title_company
// AC FIELDS (commission/other broker fields with maxLen=3)
//   [TextField] "AC1","AC4","AC numb 1".."AC numb 4" -> commission percentages (left blank by default)
//   [TextField] "Text6","Text7","Text1","Text2" -> buyer/seller signature date segments
// ---------------------------------------------------------------------------
async function fillResaleContract(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // 2026-07-04 atlas_29 fix (Bug 4): during the FILL phase, we do NOT pre-populate
  // initials or signatures. Those field slots must render EMPTY on the PDF so the
  // signer places them during the send-for-signature phase. buyerInit/sellerInit
  // retained as empty strings to keep the downstream forEach() safeSetText() calls
  // no-ops (they will write '' into the initials fields, leaving them blank).
  const buyerInit = '';
  const sellerInit = '';

  // PARTIES — TREC 20-18 page 1 reads "____ (Seller) and ____ (Buyer)".
  // Widget '1 PARTIES The parties to this contract are' is the SELLER slot (positioned after "are", before "(Seller)" label).
  // Widget 'Seller and' is the BUYER slot (positioned after "(Seller) and", before "(Buyer)" label).
  // Field-name strings are misleading; positions are ground truth (verified 2026-06-27 by Hadley via pdf-lib widget rectangles + pdftoppm render).
  safeSetText(form, '1 PARTIES The parties to this contract are', fv.seller_name || '');
  safeSetText(form, 'Seller and', fv.buyer_name || '');

  // PROPERTY — address repeats across all pages
  const addr = fv.property_address || '';
  const fullAddr = [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  // §2 PROPERTY description "Texas known as" — uses STREET ONLY because the
  // adjacent "Addition City of" widget holds the city/state/zip portion.
  safeSetText(form, 'Texas known as', addr);
  // Per-page address headers ("Contract Concerning ___ (Address of Property)") on pages
  // 9, 10, 11 use field names "Address of Property", "Addr of Prop", "Address of Property_2"
  // — these MUST receive the full address (street + city/state/zip). Heath caught
  // 2026-06-27 that prior iter6 wrote street-only here, which rendered as truncated
  // headers on the EXECUTED block (p9), Broker Information (p10), and Receipts (p11).
  safeSetText(form, 'Address of Property', fullAddr);
  safeSetText(form, 'Address of Property_2', fullAddr);
  safeSetText(form, 'Addr of Prop', fullAddr);
  // "Contract Concerning" header lines repeat full property address (with city/state/zip) on each page
  safeSetText(form, 'Contract Concerning', fullAddr);
  safeSetText(form, 'Contract Concerning_2', fullAddr);
  safeSetText(form, 'Contract Concerning_3', fullAddr);
  safeSetText(form, 'Contract Concerning_4', fullAddr);
  // §5.B Termination Option days — widget is mis-labeled in the AcroForm as
  // 'the Title Company and Buyers lenders Check one box only' (TREC PDF authoring artifact).
  // Verified position p2/y=501 sits exactly at the §5.B blank "by giving notice... within ___ days
  // after the Effective Date of this contract (Option Period)". Hadley 2026-06-27.
  safeSetText(form, 'the Title Company and Buyers lenders Check one box only',
    (fv.option_period_days != null && fv.option_period_days !== '') ? String(fv.option_period_days)
      : (fv.option_days != null && fv.option_days !== '') ? String(fv.option_days) : '');

  // Legal description: "A LAND Lot" = full legal or lot portion, "Block" = block, "undefined" = lot number
  safeSetText(form, 'A LAND Lot', fv.legal_description || '');
  safeSetText(form, 'Block', fv.legal_block || '');
  safeSetText(form, 'undefined', fv.legal_lot || '');
  // 'Addition City of' widget holds subdivision + city. If addition_name is provided
  // (e.g. "Cibolo Canyons"), prefer it; otherwise fall back to city name only.
  // 2026-07-05 atlas ROUND3 fix (Bug 11): widget is city-only; do NOT dump full
  // city_state_zip (which produces "Boerne, TX 78006" overflow). Extract the city
  // portion from city_state_zip when addition_name is absent.
  const cityOnly = fv.city || (fv.city_state_zip
    ? String(fv.city_state_zip).split(',')[0].trim()
    : '');
  safeSetText(form, 'Addition City of', fv.addition_name
    ? (fv.addition_city ? (fv.addition_name + ', ' + fv.addition_city) : fv.addition_name)
    : cityOnly);
  safeSetText(form, 'County of', fv.county || '');

  // SALES PRICE (Section 3 — TREC 20-18)
  // Widget positions on p1 (Hadley 2026-06-27 verification):
  //   undefined_2 (y=369, w=480)  -> §2.D Exclusions continuation line (BLANK by default; only fill if exclusions exist)
  //   undefined_3 (y=317, w=101)  -> §3.A Cash portion of Sales Price
  //   undefined_4 (y=267, w=101)  -> §3.B Sum of all financing
  //   undefined_5 (y=255, w=101)  -> §3.C Sales Price total (sum of A and B)
  // §3.B sub-checkbox selection (Page 1) — financing_type-aware
  const financingType = String(fv.financing_type || '').toLowerCase();
  const isTPF = ['conventional','fha','va','usda'].includes(financingType) && Number(fv.loan_amount) > 0;
  const isAssumption = financingType === 'assumption' && Number(fv.loan_amount) > 0;
  const isSellerFinancing = financingType === 'seller' && Number(fv.loan_amount) > 0;

  if (isTPF) safeCheck(form, 'B Sum of all financing described in the attached');
  if (isAssumption) safeCheck(form, 'Loan Assumption Addendum');   // page 1 sub-box
  if (isSellerFinancing) safeCheck(form, 'Seller');                 // page 1 sub-box
  // §3.A Cash portion — prefer explicit down_payment_amt; fall back to sale_price - loan_amount
  let cashPortion = (fv.down_payment_amt != null && fv.down_payment_amt !== '') ? Number(fv.down_payment_amt) : null;
  if (cashPortion == null && fv.sale_price != null && fv.loan_amount != null) {
    cashPortion = Number(fv.sale_price) - Number(fv.loan_amount);
  }
  // §2.D Exclusions — BLANK by default (only set if explicit exclusions field present)
  safeSetText(form, 'undefined_2', fv.exclusions || '');
  safeSetText(form, 'undefined_3', cashPortion != null ? formatMoney(cashPortion) : '');
  safeSetText(form, 'undefined_4', Number(fv.loan_amount) > 0 ? formatMoney(fv.loan_amount) : '');
  safeSetText(form, 'undefined_5', fv.sale_price != null && fv.sale_price !== '' ? formatMoney(fv.sale_price) : '');
  // 2026-07-05 atlas ROUND3 fix (Bugs 1, 2): The widgets NAMED "will" (p5 y=657 x=351)
  // and "will not be credited..." (p5 y=657 x=499) are POSITIONALLY the §10.A POSSESSION
  // checkboxes ("upon closing and funding" vs. "according to a temporary residential lease"),
  // NOT §3 sale-price-credited boxes as the widget names suggest. Wiring them to
  // sale_price_credited caused the "temporary lease" box to be checked by default on
  // v3-FHA — a legally material wrong-box selection. Fixed by driving them from
  // fv.possession instead.
  // Similarly, the widget "acknowledged by Seller and Buyers agreement to pay Seller"
  // (p5 y=293 x=250 w=79) is POSITIONALLY §12.A(1)(c) "amount not to exceed $___ to be
  // applied to other Buyer's Expenses" — NOT a sales-price acknowledgement field.
  // Wiring it to sale_price caused the $500K sale price to appear as a Seller
  // concession-cap, a ~100x overpromise. Fixed to write seller_concessions (or blank).

  // §10.A POSSESSION — default to "upon closing and funding" (widget "will")
  const possession = String(fv.possession || 'closing').toLowerCase();
  if (possession === 'lease_after' || possession === 'lease' || possession === 'temporary_lease') {
    safeCheck(form, 'will not be credited to the Sales Price at closing Time is of the');
  } else {
    // Default: possession="closing" or unspecified → "upon closing and funding"
    safeCheck(form, 'will');
  }

  // §12.A(1)(c) "not to exceed $___" cap — write seller_concessions if provided; never sale_price.
  // Master prompt v3-FHA: seller_concessions=$5,000 → this field shows "$5,000"; leave blank
  // when no concession is provided (Hadley: blank is legally fine; $500,000 is a lawsuit).
  safeSetText(form, 'acknowledged by Seller and Buyers agreement to pay Seller',
    (fv.seller_concessions != null && fv.seller_concessions !== '' && Number(fv.seller_concessions) > 0)
      ? formatMoney(fv.seller_concessions) : '');

  // §12.A(1)(b) buyer's-agent commission ($ or %). Widget "acknowledged by Seller and Buyers
  // agreement to pay Seller 1" (p5 y=303 x=129 w=92) = $ blank; "...Seller2" (p5 y=304 x=250 w=31)
  // = % blank. Companion checkboxes "will 1.1" ($ marker) and "will not be credited...1" (% marker).
  // Master prompt v3-FHA: buyer_agent_commission_pct=3 → check %-marker, write "3" in %-blank.
  if (fv.buyer_agent_commission_amt != null && fv.buyer_agent_commission_amt !== ''
      && Number(fv.buyer_agent_commission_amt) > 0) {
    safeCheck(form, 'will 1.1');
    safeSetText(form, 'acknowledged by Seller and Buyers agreement to pay Seller 1',
      formatMoney(fv.buyer_agent_commission_amt));
  } else if (fv.buyer_agent_commission_pct != null && fv.buyer_agent_commission_pct !== ''
      && Number(fv.buyer_agent_commission_pct) > 0) {
    safeCheck(form, 'will not be credited to the Sales Price at closing Time is of the 1');
    safeSetText(form, 'acknowledged by Seller and Buyers agreement to pay Seller2',
      String(fv.buyer_agent_commission_pct));
  }

  // EARNEST MONEY / OPTION FEE (Section 5 — TREC 20-18 page 2)
  // Widget positions (Hadley 2026-06-27 verification):
  //   undefined_6 (p2/y=699, w=153)              -> §5.A Escrow Agent name slot ("Buyer must deliver to ___")
  //   'other party in writing...' (p2/y=699, w=158) -> §5.A Escrow Agent address slot
  //   undefined_7 (p2/y=689, w=151)              -> §5.A Escrow Agent address continuation
  //   'as earnest money to' (p2/y=689, w=72)     -> §5.A earnest money $ blank
  //   'as earnest money to 2' (p2/y=689, w=75)   -> §5.A Option Fee $ blank
  //   'earnest money of' (p2/y=657, w=106)       -> §5.A(1) ADDITIONAL earnest money $ blank
  //   'to escrow agent within' (p2/y=646, w=36)  -> §5.A(1) days for additional earnest money delivery
  //
  // Heath master prompt didn't specify Escrow Agent address — title_company_address may be set by extractor.
  safeSetText(form, 'undefined_6', fv.title_company || '');
  safeSetText(form, 'other party in writing before entering into a contract of sale  Disclose if applicable',
    fv.title_company_address || '');
  safeSetText(form, 'undefined_7', fv.title_company_address_line2 || '');
  safeSetText(form, 'as earnest money to', fv.earnest_money != null && fv.earnest_money !== '' ? formatMoney(fv.earnest_money) : '');
  safeSetText(form, 'as earnest money to 2', fv.option_fee != null && fv.option_fee !== '' ? formatMoney(fv.option_fee) : '');
  safeSetText(form, 'earnest money of', fv.additional_earnest_money != null && fv.additional_earnest_money !== '' ? formatMoney(fv.additional_earnest_money) : '');
  safeSetText(form, 'to escrow agent within', fv.additional_earnest_money_days || '');
  // 2026-07-05 ROUND4 fix (Bug 1 — title company domain rule): ALL Page-11 receipt sections
  // are title-company-only fields, filled at closing when funds actually arrive.
  // NEVER pre-populate at contract origination — legally incorrect and misleading.
  // Blanking: Option Fee "form of", Option Fee recipient, Earnest Money "form of".
  safeSetText(form, 'Option Fee in the form of', '');
  safeSetText(form, 'Seller or Listing Broker', '');
  safeSetText(form, 'Earnest Money in the form of', '');

  // TITLE COMPANY / ESCROW (Section 6)
  safeSetText(form, 'insurance Title Policy issued by', fv.title_company || '');
  safeSetText(form, 'Escrow Agent', fv.title_company || '');
  safeSetText(form, 'Escrow Agent_2', fv.title_company || '');
  safeSetText(form, 'Escrow Agent_3', fv.title_company || '');
  // NOTE: 'Received by' / 'Received by_2' / 'Received by_3' on the page-11 escrow
  // receipts = ESCROW OFFICER name (Ashley Phiffer). Wired below in the ESCROW
  // RECEIPT FIELDS block (search for 'receivedBy =') with fv.escrow_agent_name
  // as the fallback. Heath 2026-06-27 confirmed receipt of master prompt
  // "title escrow officer is Ashley phiffer".
  safeSetText(form, 'receipt or the date specified in this paragraph whichever is earlier', fv.title_objection_days || '');
  safeSetText(form, 'Commitment other than items 6A1 through 9 above or which prohibit the following use', fv.permitted_use || '');
  safeSetText(form, 'the Commitment Exception Documents and the survey Buyers failure to object within the', fv.exception_objection_days || '');

  // §6.C SURVEY (Check one box only — three sub-paragraphs)
  // Master prompt v3-FHA: "seller will provide T47 or survey. If no survey is available
  // seller will pay for a new one" → maps to §6.C(1): "Within X days after the Effective Date,
  // Seller shall furnish to Buyer and Title Company Seller's existing survey along with no-
  // changes affidavit acceptable to Title Company". The fallback inside (1) ("If Seller fails
  // to furnish... Buyer shall obtain new at Seller's expense") covers the "if not available"
  // scenario without needing to also check (3).
  //
  // Widget map (positions verified p2 = page 3):
  //   'Within one' (y=640, x=144) = §6.C(1) primary checkbox (Seller furnishes T-47 existing)
  //   'Within two' (y=640, x=198) = §6.C(1) alt (Seller-furnishes "with affidavit") — leave unchecked
  //   'Within three' (y=630, x=59) = §6.C(2) primary (Buyer obtains new at Buyer's expense)
  //   'Within four' (y=579, x=60) = §6.C(3) primary (Seller furnishes new at Seller's expense)
  //   'Buyer' (y=706, x=58) = §6.C(1) inner-fallback expense direction (check if Buyer pays for fallback new survey; UNcheck if Seller pays)
  //   'than 3 days prior to Closing Date' = days field for the fallback delivery deadline
  //   '3 days prior' (y=627) = §6.C(2) days field
  //   'receipt or the date specified in this paragraph whichever is earlier' (y=577) = §6.C(3) days field
  // §6.C(1) has NO primary AcroForm checkbox widget in TREC 20-18 — the (1) box is
  // a printed-only square. We draw an "X" overlay at the visual (1) checkbox
  // location when the default §6.C(1) is selected. §6.C(2) and §6.C(3) DO have
  // widgets ("Within three" and "Within four" respectively). The "Buyer" widget
  // at y=706 is the §6.C(1) inner-fallback "Buyer's expense" toggle.
  //
  // Accept legacy (survey_seller_new, survey_buyer_new) and new extractor field
  // names (survey_buyer_obtains, survey_existing_or_seller_pays).
  // 2026-07-05 atlas ROUND3 fix (Bug 8): §6C(1) is the correct selection when the master
  // prompt says "seller will provide existing T-47/survey OR pay for new if not available".
  // §6C(3) is ONLY for a hard commitment to Seller paying for a brand new survey (no existing
  // option mentioned). Round-2 mapped the v3-FHA "T-47 or seller pays if unavailable" language
  // to §6C(3), which committed Seller to always pay for a new survey. That was wrong.
  if (fv.survey_seller_new === true) {
    // §6.C(3) Seller pays for new survey (hard commitment, no existing option)
    safeCheck(form, 'Within four');
  } else if (fv.survey_buyer_new === true || fv.survey_buyer_obtains === true) {
    // §6.C(2) Buyer obtains new at Buyer's expense
    safeCheck(form, 'Within three');
    if (fv.survey_buyer_pays === true) safeCheck(form, 'Buyer');
  } else {
    // DEFAULT (v3-FHA / survey_existing_or_seller_pays):
    //   §6.C(1) Seller furnishes existing T-47 survey with optional Seller-pays-fallback.
    //   No primary widget exists; overlay an "X" at the (1) checkbox visual position.
    try {
      const pages = pdfDoc.getPages();
      const page3 = pages[2]; // 0-indexed: displayed page 3
      // §6.C(1) primary checkbox sits at left edge below the "(1)" label.
      page3.drawText('X', { x: 60, y: 709, size: 11 });
      const c1Days = (fv.survey_furnish_days != null && fv.survey_furnish_days !== '')
        ? String(fv.survey_furnish_days) : '7';
      page3.drawText(c1Days, { x: 128, y: 709, size: 10 });
    } catch (e) { console.warn('[fill-form] §6.C(1) overlay failed:', e && e.message); }
    // §6.C(1) inner-fallback "Buyer's expense" checkbox — the widget "Buyer" (p2 y=706)
    // when CHECKED means Buyer pays for the fallback new survey. When UNCHECKED (default
    // for v3-FHA "seller will pay for new if unavailable"), Seller pays.
    if (fv.survey_seller_pays_fallback === false || fv.survey_buyer_pays_fallback === true) {
      safeCheck(form, 'Buyer');
    }
  }
  // §6.C days fields — default to 7 days for (1) Seller-furnishes-existing window,
  // 3 days for the "no later than 3 days prior to Closing" Buyer-obtains-fallback window.
  const surveyDays = fv.survey_furnish_days != null && fv.survey_furnish_days !== ''
    ? String(fv.survey_furnish_days) : '7';
  // The "Within one"/"Within two" share the same days blank in the form's printed layout.
  // The widget 'than 3 days prior to Closing Date' at p2/y=705 is the §6.C(1) fallback days field.
  safeSetText(form, 'than 3 days prior to Closing Date', surveyDays);

  // PROPERTY CONDITION (Section 7)
  //
  // The §7.D "ACCEPTANCE OF PROPERTY CONDITION" paragraph appears in TWO places
  // on TREC 20-18 due to a multi-page wrap:
  //   - Page 4 widget labeled '1 Buyer accepts the Property As Is' (y=149) and
  //     '2 Buyer accepts the Property As Is provided Seller...' are MIS-LABELED in
  //     the AcroForm — these are actually §7.B(1) and §7.B(2) "Buyer has received
  //     Seller's Disclosure Notice" checkboxes. They concern the Seller's Disclosure
  //     Notice receipt status, NOT property condition acceptance.
  //   - Page 5 widgets 'As Is' (y=681) and 'As Is except' (y=669) are the ACTUAL
  //     §7.D "Acceptance of Property Condition" checkboxes.
  //
  // Hadley 2026-06-27 fix: check the page-5 'As Is' / 'As Is except' widgets
  // (the real §7.D), and ALSO continue to check the page-4 mis-labeled widget
  // to preserve the §7.B "Buyer has received Notice" default (since with the
  // Disclosure already delivered before contract execution, Buyer always
  // "has received" by the time the contract is signed).
  if (fv.as_is_with_repairs === true) {
    safeCheck(form, '2 Buyer accepts the Property As Is provided Seller at Sellers expense shall complete the');
    safeCheck(form, 'As Is except');
    safeSetText(form, 'following specific repairs and treatments', fv.required_repairs || '');
    safeSetText(form, 'undefined_13', fv.repairs_additional || '');
  } else {
    // Default: Buyer accepts As-Is (most common in Texas resale)
    safeCheck(form, '1 Buyer accepts the Property As Is');
    safeCheck(form, 'As Is');
  }
  safeSetText(form, 'service contract in an amount not exceeding', fv.service_contract_amount != null && fv.service_contract_amount !== '' ? formatMoney(fv.service_contract_amount) : '');

  // CLOSING DATE (Section 9)
  if (fv.closing_date) {
    const cd = String(fv.closing_date);
    if (cd.includes('-')) {
      safeSetText(form, 'A The closing of the sale will be on or before', formatLongDateNoYear(cd));
      safeSetText(form, '20', formatTwoDigitYear(cd));
    } else {
      safeSetText(form, 'A The closing of the sale will be on or before', cd);
    }
  }

  // POSSESSION / CLOSING NOTICES
  // NOTE: 'to escrow agent within' is now wired above to additional_earnest_money_days (§5.A(1)),
  //       NOT funding_notice_days. The widget 'to escrow agent within 1' at p0/y=60 sits in
  //       §4.C(2) NATURAL RESOURCE LEASES area (Heath verified PDF text 2026-06-27).
  // NOTE: 'than 3 days prior to Closing Date' is the §6.C(1) survey-fallback days field
  //       and is wired above in the §6.C SURVEY block (NOT a closing-statement days field).
  safeSetText(form, 'to escrow agent within 1', fv.natural_resource_lease_termination_days || '');
  safeSetText(form, 'be removed prior to delivery of possession', fv.items_removed || '');

  // ATTORNEYS (Section 23)
  safeSetText(form, 'Attorney is', fv.buyer_attorney || '');
  safeSetText(form, 'Attorney is_2', fv.seller_attorney || '');

  // §6.A TITLE POLICY — who pays for owner's title policy
  // Widget positions p2/y=352: 'Sellers_2' (x=314) = Seller pays; 'Buyers expense no later' (x=368) = Buyer pays
  // Default for Texas resale: Seller pays owner's title policy (per Heath master prompt "seller will provide").
  if (fv.title_seller_pays === true || fv.title_seller_pays === undefined || fv.title_seller_pays === null) {
    safeCheck(form, 'Sellers_2');
  } else {
    safeCheck(form, 'Buyers expense no later');
  }

  // HOA (Section 6.E membership)
  if (fv.hoa_exists === true) {
    safeCheck(form, 'is');
    safeCheck(form, 'Addendum for Property Subject to');
  } else {
    safeCheck(form, 'is not');
  }
  // NOTE: Widget '2 MEMBERSHIP IN PROPERTY OWNERS ASSOCIATIONS The Property' is
  // POSITIONALLY a page-2 buyer-initials slot (y=21 x=211 w=35), NOT a §6.E description text field.
  // Wiring hoa_description here was a long-standing bug. The buyer initials are written below.

  // ADDENDUM CHECKBOXES (Section 22 — VERIFIED visually p8 via fitz render 2026-06-27)
  //
  // CRITICAL: The TREC 20-18 source PDF's right-column widget NAMES are shifted by ONE
  // VISUAL ROW UP relative to where the widget actually renders. The fitz/MuPDF render
  // proves the actual visual mapping (widget rect Y vs text row Y), which is:
  //
  // LEFT COLUMN (widget name = visual row; AcroForm names are accurate):
  //   'Third Party Financing Addendum'          -> Third Party Financing (visual ✓)
  //   'Seller Financing Addendum'               -> Seller Financing
  //   'Addendum for Property Subject to'        -> Mandatory HOA membership
  //   'Buyers Temporary Residential Lease'      -> Buyer's Temp Lease
  //   'Loan Assumption Addendum_2'              -> Loan Assumption
  //   'Addendum for Sale of Other Property by'  -> Sale of Other Property by Buyer
  //   'Addendum for Reservation of Oil Gas'     -> Reservation of Oil/Gas/Minerals
  //   'Addendum for BackUp Contract'            -> Back-Up Contract
  //   'Check Box8'                              -> Coastal Area Property
  //   'Check Box9'                              -> Authorizing Hydrostatic Testing
  //   'Check box 10'                            -> Right to Terminate Due to Lender's Appraisal (TREC 49-1)
  //   'Check box 11'                            -> Environmental Assessment / Threatened Species / Wetlands
  //
  // RIGHT COLUMN (widget name SHIFTED UP one row from visual; corrected mapping):
  //   'Environmental Assessment Threatened or'  -> Sellers Temporary Residential Lease
  //   'Sellers Temporary Residential Lease'     -> Short Sale Addendum
  //   'Short Sale Addendum'                     -> Property Located Seaward of Gulf Intracoastal
  //   'Addendum for Property Located Seaward'   -> Seller's Disclosure of Lead-Based Paint (OP-L)
  //   'Sellers Disclos'                         -> Property in a Propane Gas System Service Area
  //   'Addend. for Sellers Disclos'             -> Addendum Regarding Residential Leases
  //   'Addendum for Property in a Propane Gas'  -> Addendum Regarding Fixture Leases
  //   'PID'                                     -> Notice of Obligation to Pay PID Assessment
  //   'Addendum for Section 1031'               -> Section 1031 Exchange (visual ✓)
  //   'Other'                                   -> Other (list)
  if (isTPF || fv.addendum_financing === true) safeCheck(form, 'Third Party Financing Addendum');
  if (fv.seller_financing_addendum === true) safeCheck(form, 'Seller Financing Addendum');
  // RIGHT column — shifted mapping (widget name does NOT match visual row)
  if (fv.seller_leaseback_addendum === true) safeCheck(form, 'Environmental Assessment Threatened or'); // → Sellers Temp Lease
  if (fv.short_sale_addendum === true) safeCheck(form, 'Sellers Temporary Residential Lease'); // → Short Sale
  if (fv.coastal_addendum === true) safeCheck(form, 'Short Sale Addendum'); // → Property Located Seaward
  // Lead-Based Paint Addendum (OP-L) — for pre-1978 homes — VISUAL ROW = "Seller's Disclosure of Lead-Based Paint"
  // CORRECTED 2026-06-27 by Hadley after visual verification: widget 'Addendum for Property Located Seaward'
  // renders at the Lead-Paint visual row (not the Seaward row, despite its name).
  if (fv.addendum_lead_paint === true || fv.lead_paint_addendum === true) safeCheck(form, 'Addendum for Property Located Seaward');
  if (fv.propane_addendum === true) safeCheck(form, 'Sellers Disclos'); // → Propane Gas
  if (fv.residential_leases_addendum === true) safeCheck(form, 'Addend. for Sellers Disclos'); // → Residential Leases
  if (fv.fixture_leases_addendum === true) safeCheck(form, 'Addendum for Property in a Propane Gas'); // → Fixture Leases
  if (fv.pid_addendum === true) safeCheck(form, 'PID'); // → PID Notice
  if (fv.section_1031_addendum === true) safeCheck(form, 'Addendum for Section 1031');
  if (fv.other_addendum === true) safeCheck(form, 'Other');
  // LEFT column — names match visual rows
  if (fv.buyer_leaseback_addendum === true) safeCheck(form, 'Buyers Temporary Residential Lease');
  if (fv.loan_assumption_addendum === true) safeCheck(form, 'Loan Assumption Addendum_2');
  if (fv.other_property_addendum === true) safeCheck(form, 'Addendum for Sale of Other Property by');
  if (fv.oil_gas_addendum === true) safeCheck(form, 'Addendum for Reservation of Oil Gas');
  if (fv.backup_contract_addendum === true) safeCheck(form, 'Addendum for BackUp Contract');
  if (fv.coastal_area_addendum === true) safeCheck(form, 'Check Box8');
  if (fv.hydrostatic_addendum === true) safeCheck(form, 'Check Box9');
  if (fv.lender_appraisal_addendum === true || fv.addendum_49_1 === true) safeCheck(form, 'Check box 10');
  if (fv.environmental_addendum === true) safeCheck(form, 'Check box 11');
  // HOA Addendum (TREC 36-11) — for properties subject to mandatory HOA membership
  if (fv.addendum_hoa === true || fv.hoa_addendum === true || fv.hoa_exists === true) safeCheck(form, 'Addendum for Property Subject to');
  // Seller's Disclosure Notice Addendum (OP-H) — note: there is no visual row for OP-H in §22 since
  // the §22 addendum list does not include OP-H (it's delivered separately under §7.B). The old
  // wiring to 'Addend. for Sellers Disclos' was incorrect.
  safeSetText(form, 'System Service Area', fv.propane_system_area || '');
  // NOTE: Widget 'The private transfer fee' is POSITIONALLY a page-3 seller-initials slot (y=21 x=396 w=36),
  // NOT a private-transfer-fee dollar field. Wiring private_transfer_fee here was a long-standing bug.
  // Seller initials are written below.

  // §11 SPECIAL PROVISIONS — Brokers' factual statements (no UPL).
  // Build automatic provisions for common deal terms (seller concessions, home warranty if not in §12).
  // Widget positions on PDF p5 (Contract page 6, where §11 sits per layout verification 2026-06-27):
  //   'Text3'   (y=431, w=205) — first line, right-side, narrower
  //   'Text3 2' (y=420, w=495) — second full-width line
  //   'Text3 3' (y=409, w=495) — third full-width line
  // 'Brokers and Sales' / 'Brokers and Sales 2' on PDF p4 are §8 BROKERS AND SALES AGENTS widgets, NOT §11.
  const specialProvisions = [];
  if (fv.special_provisions) specialProvisions.push(String(fv.special_provisions));
  if (fv.seller_concessions != null && fv.seller_concessions !== '' && Number(fv.seller_concessions) > 0) {
    specialProvisions.push('Seller to credit Buyer $' + formatMoney(fv.seller_concessions) + ' toward Buyer\'s closing costs at closing.');
  }
  if (specialProvisions.length > 0) {
    const provText = specialProvisions.join(' ');
    // Write to the widest line. If text fits in the first line (~80 chars at w=205), use it;
    // otherwise spill into the wider line. For simplicity, always write into the widest line (Text3 2 or Text3 3).
    safeSetText(form, 'Text3 2', provText);
  }

  // EXECUTION DATE
  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-') ? formatDate(fv.contract_effective_date) : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }
  // EXECUTED block: if execution_date provided, use it; otherwise fall back to contract_effective_date.
  const execISO = fv.execution_date || fv.contract_effective_date;
  if (execISO) {
    const ed = String(execISO);
    const edParsed = ed.includes('-') ? new Date(ed) : null;
    if (edParsed) {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      safeSetText(form, 'EXECUTED the', String(edParsed.getUTCDate()));
      safeSetText(form, 'day of', months[edParsed.getUTCMonth()]);
      safeSetText(form, '20_2', String(edParsed.getUTCFullYear()).slice(2));
    }
  }

  // CONTACT EMAILS
  safeSetText(form, 'Email', fv.buyer_email || '');
  safeSetText(form, 'Email_2', fv.seller_email || '');

  // BROKER / AGENT SECTION
  // Listing broker (agent representing seller)
  // 2026-07-05 atlas ROUND3 fix (Bug 6): License No_4 is the FIRM license slot; use
  // listing_broker_firm_license (a distinct 6-digit TREC firm license, e.g. 9004523 for
  // Phyllis Browning Company). License No_5 is the ASSOCIATE license slot; use
  // listing_agent_license (e.g. 123964 for Bizzy Darling). Prior fill used
  // listing_broker_license (an ambiguous alias) for the firm slot which conflated
  // firm-vs-agent licensure. In the v3-FHA scenario firm license is unknown, so this
  // slot stays blank — correct.
  safeSetText(form, 'Listing Broker Firm', fv.listing_broker_firm || '');
  safeSetText(form, 'License No_4', fv.listing_broker_firm_license || fv.listing_broker_license || '');
  safeSetText(form, 'Listing Associates Name', fv.listing_agent_name || '');
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
  // Listing broker representation checkbox
  if (fv.listing_intermediary === true) {
    safeCheck(form, 'Seller and Buyer as an intermediary');
  } else {
    safeCheck(form, 'Seller only as Sellers agent');
  }

  // Other/selling broker (agent representing buyer)
  safeSetText(form, 'Other Broker Firm', fv.other_broker_firm || '');
  safeSetText(form, 'License No', fv.other_broker_license || '');
  safeSetText(form, 'Associates Name', fv.other_broker_assoc_name || '');
  safeSetText(form, 'Selling Associates Name', fv.selling_agent_name || '');
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
  safeSetText(form, 'Zip_3', fv.other_broker_zip_3 || '');
  safeSetText(form, 'License No_7', fv.selling_agent_license || '');
  safeSetText(form, 'Selling Associates Email Address', fv.selling_agent_email || '');
  safeSetText(form, 'Phone_5', fv.selling_agent_phone || '');
  safeSetText(form, 'Licensed Supervisor of Selling Associate', fv.selling_supervisor || '');
  safeSetText(form, 'License No_8', fv.selling_supervisor_license || '');
  safeSetText(form, 'Selling Associates Office Address', fv.selling_broker_address || '');
  safeSetText(form, 'City_3', fv.selling_broker_city || '');
  safeSetText(form, 'State_3', fv.selling_broker_state || '');
  if (fv.buyer_only_agent === true) safeCheck(form, 'Buyer only');

  // 2026-07-05 ROUND4 fix (Bug 1 — title company domain rule): ALL Page-11 receipt sections
  // are title-company-only. These are filled by the escrow officer AFTER funds/documents
  // are received at closing — NEVER by the buyer's agent at contract origination.
  // Explicitly blanking every widget in all 4 receipt sections:
  //   OPTION FEE RECEIPT: Received by, Address, City_4, State_4, Zip_4, Email Address, DateTime, Phone_6, Fax, is acknowledged
  //   EARNEST MONEY RECEIPT: Received by_2, Address_2, City_5, State_5, Zip_5, Email Address_2, Date_2, Phone_7, Fax_2, is acknowledged_2
  //   CONTRACT RECEIPT: (Date_2 was the round-3 "contract receipt date" — now blank)
  //   ADDITIONAL EARNEST MONEY RECEIPT: Received by_3, Address_3, City_6, State_6, Zip_6, Email Address_3, DateTime_2, Phone_8, Fax_3, is acknowledged_3, additional Earnest Money in the form of
  // Page 2 §5.A contract body ($100 option fee, $5,000 earnest money) is NOT touched — see lines 795-797.
  safeSetText(form, 'Received by', '');
  safeSetText(form, 'Address', '');
  safeSetText(form, 'City_4', '');
  safeSetText(form, 'State_4', '');
  safeSetText(form, 'Zip_4', '');
  safeSetText(form, 'Email Address', '');
  safeSetText(form, 'DateTime', '');
  safeSetText(form, 'Phone_6', '');
  safeSetText(form, 'Fax', '');
  safeSetText(form, 'Received by_2', '');
  safeSetText(form, 'Address_2', '');
  safeSetText(form, 'City_5', '');
  safeSetText(form, 'State_5', '');
  safeSetText(form, 'Zip_5', '');
  safeSetText(form, 'Email Address_2', '');
  safeSetText(form, 'Date_2', '');
  safeSetText(form, 'Phone_7', '');
  safeSetText(form, 'Fax_2', '');
  safeSetText(form, 'Received by_3', '');
  safeSetText(form, 'is acknowledged', '');
  safeSetText(form, 'is acknowledged_2', '');
  safeSetText(form, 'is acknowledged_3', '');
  safeSetText(form, 'State_6', '');
  safeSetText(form, 'Zip_6', '');
  safeSetText(form, 'Email Address_3', '');
  safeSetText(form, 'DateTime_2', '');
  safeSetText(form, 'Phone_8', '');
  safeSetText(form, 'additional Earnest Money in the form of', '');
  safeSetText(form, 'Address_3', '');
  safeSetText(form, 'City_6', '');
  safeSetText(form, 'Fax_3', '');

  // §21 NOTICE ADDRESSES (2026-07-05 atlas ROUND3 fix — Bug 7)
  // Left column ("To Buyer at:") + right column ("To Seller at:") on displayed page 8.
  // Positional map (p7 = 0-indexed page 8):
  //   y=697 x=133 w=161 "when mailed to handdelivered..."      → Buyer at: address line
  //   y=696 x=386 w=162 "undefined_19"                          → Seller at: address line
  //   y=672 x=62  w=233 "at"                                    → Buyer address continuation
  //   y=672 x=317 w=232 "at_2"                                  → Seller address continuation
  //   y=648 x=139 w=25  "AC1" (maxLen=3)                        → Buyer phone area code
  //   y=648 x=166 w=129 "Phone 51"                              → Buyer phone
  //   y=647 x=394 w=24  "AC4" (maxLen=3)                        → Seller phone area code
  //   y=647 x=421 w=128 "Fax 52"                                → Seller phone
  //   y=622 x=135 w=160 "Phone 52"                              → Buyer email/fax
  //   y=622 x=388 w=162 "undefined numb 21"                     → Seller email/fax
  // Falls back to legacy fv.notice_address for backward compatibility.
  // 2026-07-05 ROUND4 fix (Bug 2 — §21 buyer notice blank): when both direct fields are empty,
  // fall back to the buyer's agent address ("c/o [buyer_agent_name], KW City View, San Antonio, TX").
  // Master prompt "I will represent myself" means buyer_agent = buyer; the KW office address is
  // the standard notice fallback per REALTOR practice.
  const buyerAgentName = fv.buyer_agent_name || fv.other_broker_assoc_name || fv.selling_agent_name || '';
  const buyerNoticeAddr = fv.buyer_notice_address || fv.notice_address ||
    (buyerAgentName ? `c/o ${buyerAgentName}, KW City View, San Antonio, TX` : '');
  safeSetText(form, 'when mailed to handdelivered at or transmitted by fax or electronic transmission as follows',
    buyerNoticeAddr);
  safeSetText(form, 'undefined_19', fv.seller_notice_address || '');
  // Continuation lines — only fill if a 2-part address was provided
  if (fv.buyer_notice_address_line2) safeSetText(form, 'at', fv.buyer_notice_address_line2);
  if (fv.seller_notice_address_line2) safeSetText(form, 'at_2', fv.seller_notice_address_line2);
  // Phone / email
  if (fv.buyer_notice_phone) safeSetText(form, 'Phone 51', String(fv.buyer_notice_phone));
  if (fv.seller_notice_phone) safeSetText(form, 'Fax 52', String(fv.seller_notice_phone));
  if (fv.buyer_notice_email) safeSetText(form, 'Phone 52', String(fv.buyer_notice_email));
  if (fv.seller_notice_email) safeSetText(form, 'undefined numb 21', String(fv.seller_notice_email));
  // Legacy secondary notice slot — kept for backward compatibility
  safeSetText(form, 'when mailed to', fv.notice_address_2 || '');

  // INITIALS — every page has a footer "Initialed for identification by Buyer ___ ___ and Seller ___ ___".
  // The AcroForm field NAMES are misleading: many of them are inherited from arbitrary text
  // snippets near the widget at PDF-authoring time. The widget POSITIONS are ground truth.
  // Mapping verified 2026-06-27 by Hadley via pdf-lib widget rectangles (y=21 footer, x∈{211,252-253} for buyer,
  // x∈{347,396} for seller).
  //
  // Per-page initials widgets (positions confirmed):
  //   PDF page 0 (Contract page 1): Buyer = "Initialed for identification by Buyer" + "undefined_8",  Seller = "and Seller" + "undefined_9"
  //   PDF page 1 (Contract page 2): Buyer = "2 MEMBERSHIP IN PROPERTY OWNERS ASSOCIATIONS The Property" + "and Seller_2", Seller = "undefined_10" + "undefined_11"
  //   PDF page 2 (Contract page 3): Buyer = "Property Code requires Seller to notify Buyer as follows" + "and Seller_3", Seller = "undefined_12" + "The private transfer fee"
  //   PDF page 3 (Contract page 4): Buyer = "Initialed for identification by Buyer_2" + "undefined_14",  Seller = "and Seller_4" + "undefined_15"
  //   PDF page 4 (Contract page 5): Buyer = "Initialed for identification by Buyer_3" + "Buyers Expenses as allowed by the lender", Seller = "and Seller_5" + "undefined_16"
  //   PDF page 5 (Contract page 6): Buyer = "Initialed for identification by Buyer_4" + "undefined_17", Seller = "and Seller_6" + "undefined_18"
  //   PDF page 6 (Contract page 7): NOT INITIALS — these widgets are "AC numb 1..4" maxLen=3 = §21 phone area codes
  //   PDF page 7 (Contract page 8): Buyer = "Initialed for identification by Buyer_5" + "and Seller_7", Seller = "undefined_22" + "undefined_23"
  //
  // Note: "and Seller_7" appears positionally at x=254 (BUYER side), not seller side, despite the name.
  var buyerInitFields = [
    // p0
    'Initialed for identification by Buyer',
    'undefined_8',
    // p1
    '2 MEMBERSHIP IN PROPERTY OWNERS ASSOCIATIONS The Property',
    'and Seller_2',
    // p2
    'Property Code requires Seller to notify Buyer as follows',
    'and Seller_3',
    // p3
    'Initialed for identification by Buyer_2',
    'undefined_14',
    // p4
    'Initialed for identification by Buyer_3',
    'Buyers Expenses as allowed by the lender',
    // p5
    'Initialed for identification by Buyer_4',
    'undefined_17',
    // p6 — widgets renamed 'AC numb 1..4' (maxLen=3) but positionally these are initials slots, NOT area codes
    'AC numb 1',
    'AC numb 2',
    // p7
    'Initialed for identification by Buyer_5',
    'and Seller_7',
  ];
  var sellerInitFields = [
    // p0
    'and Seller',
    'undefined_9',
    // p1
    'undefined_10',
    'undefined_11',
    // p2
    'undefined_12',
    'The private transfer fee',
    // p3
    'and Seller_4',
    'undefined_15',
    // p4
    'and Seller_5',
    'undefined_16',
    // p5
    'and Seller_6',
    'undefined_18',
    // p6
    'AC numb 3',
    'AC numb 4',
    // p7
    'undefined_22',
    'undefined_23',
  ];
  // 2026-07-04 atlas_29 fix (Bug 4 — Heath): during the FILL phase, initials
  // are NOT pre-populated. Field slots remain empty. Signature/initial slots
  // are placed empty on the PDF and filled during the send-for-signature phase.
  // The buyerInitFields / sellerInitFields arrays above are retained as
  // documentation of which AcroForm widget names are initials slots.
  // buyerInitFields.forEach(function(f) { safeSetText(form, f, buyerInit); });
  // sellerInitFields.forEach(function(f) { safeSetText(form, f, sellerInit); });
  void buyerInitFields; void sellerInitFields; void buyerInit; void sellerInit;

  // UNDEFINED PLACEHOLDER FIELDS (page number + sequence fields auto-populated by TREC)
  // Leave blank — PDF reader fills these from field calculation scripts
  // "undefined_6","undefined_7","undefined_8","undefined_9" etc.

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

  // 2026-07-04 atlas_29 fix (Bug 4 — Heath): initials NOT pre-populated in fill phase.
  const buyerInit = '';
  const sellerInit = '';

  // PROPERTY
  const propertyFull = fv.property_full || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  safeSetText(form, 'Street Address and City', propertyFull);
  // 2026-07-05 atlas ROUND3 fix (Bug 9): page 2 header widget "Address of Property"
  // takes the FULL address (street + city/state/zip), not just the street. Round-2
  // truncated to "123 Main St" only.
  safeSetText(form, 'Address of Property', propertyFull || fv.property_address || '');

  const ft = String(fv.financing_type || '').toLowerCase();
  const loanAmt = fv.loan_amount != null && fv.loan_amount !== '' ? formatMoney(fv.loan_amount) : '';

  // D1 fix: Only check first mortgage checkbox if CONVENTIONAL
  if (ft === 'conventional') {
    safeCheck(form, 'a A first mortgage loan in the principal amount of');
  }
  // D5 fix: For ANY financed deal, subject to buyer approval; ensure §2.B property-approval
  // box stays unchecked (Check Box2 = §2.A buyer-approval Yes box). Also wire the §2.A
  // "days after Effective Date" blank — leaving it blank makes the buyer's termination
  // right unenforceable (Hadley 40-11 KB).
  if (ft && ft !== 'cash') {
    safeCheck(form, 'Check Box2');
    safeUncheck(form, 'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer');
    // 2026-07-05 atlas ROUND3 fix (Bug 4): §2.A days-to-terminate default 21.
    // Widget "Conversion Mortgage loan in the original principal amount of" is positionally
    // (p1 y=681 x=361 w=31) the §2.A days blank on page 2 — a MISLABELED widget name.
    const buyerApprovalDays = fv.buyer_approval_days != null && fv.buyer_approval_days !== ''
      ? String(fv.buyer_approval_days) : '21';
    safeSetText(form, 'Conversion Mortgage loan in the original principal amount of', buyerApprovalDays);
  }
  if (fv.second_mortgage === true) {
    safeCheck(form, 'b A second mortgage loan in the principal amount of');
  }

  // LOAN TYPE — wire each type's fields
  if (ft === 'conventional' || fv.financing_conventional === true) {
    safeCheck(form, '1 Conventional Financing');
    safeSetText(form, 'any financed PMI premium due in full in 1', loanAmt);
    safeSetText(form, 'any financed PMI premium due in full in 2', fv.loan_amount_2 != null ? formatMoney(fv.loan_amount_2) : '');
    safeSetText(form, 'per annum for the first', fv.interest_rate_cap || '');
    safeSetText(form, 'shown on Buyers Loan Estimate for the loan not to exceed', fv.origination_charges_cap || '');
    safeSetText(form, 'excluding', fv.pmi_exclusion || '');
    safeSetText(form, 'any financed PMI premium due in full in 1_2', fv.second_loan_amount != null && fv.second_loan_amount !== '' ? formatMoney(fv.second_loan_amount) : '');
    safeSetText(form, 'any financed PMI premium due in full in 2_2', fv.second_loan_amount_2 != null && fv.second_loan_amount_2 !== '' ? formatMoney(fv.second_loan_amount_2) : '');
    safeSetText(form, 'per annum for the first_2', fv.second_interest_rate_cap || '');
    safeSetText(form, 'shown on Buyers Loan Estimate for the loan not to exceed_2', fv.second_origination_charges_cap || '');
  }

  if (ft === 'tx_veterans' || fv.financing_tx_veterans === true) {
    safeCheck(form, '2 Texas Veterans Loan A loans from the Texas Veterans Land Board of');
    // D8 note: AcroForm field names appear inverted per Hadley audit; this needs visual verify on TxVet render
    safeSetText(form, 'for a period in the total amount of', loanAmt);
    safeSetText(form, 'years at the interest rate established by the', fv.tx_vet_loan_years || '30');
  }

  if (ft === 'fha' || fv.financing_fha === true) {
    safeCheck(form, '3 FHA Insured Financing A Section');
    // D2 fix: Default FHA Section to "203(b)" if not provided
    safeSetText(form, 'undefined', fv.fha_loan_section || '203(b)');
    safeSetText(form, 'excluding any financed MIP amortizable monthly for not less', loanAmt);
    // D3 fix: Use loan_term_years as fallback for fha_amortization_years, default to 30
    safeSetText(form, 'than', fv.fha_amortization_years || fv.loan_term_years || '30');
    // 2026-07-05 atlas ROUND3 fix (Bug 3): §1.C interest rate cap defaults to 8.0% when
    // not specified. Per Hadley 40-11 KB gotcha #1: leaving §1.C rate cap blank VOIDS the
    // FHA financing contingency. Round-2 shipped this field blank.
    safeSetText(form, 'years with interest not to exceed_2', fv.fha_interest_rate_cap || fv.interest_rate_max || fv.interest_rate_cap || '8.0');
    safeSetText(form, 'Charges as shown on Buyers Loan Estimate for the loan not to exceed', fv.fha_origination_cap || '1.00');
    safeSetText(form, 'value of the Property established by the Department of Veterans Affairs', fv.fha_appraised_value != null && fv.fha_appraised_value !== '' ? formatMoney(fv.fha_appraised_value) : (fv.sale_price != null ? formatMoney(fv.sale_price) : ''));
    if (fv.fha_conversion_amount) {
      safeSetText(form, 'Conversion Mortgage loan in the original principal amount of', formatMoney(fv.fha_conversion_amount));
      safeSetText(form, 'not to exceed', fv.fha_conversion_not_exceed || '');
    }
  }

  if (ft === 'va' || fv.financing_va === true) {
    safeCheck(form, '4 VA Guaranteed Financing A VA guaranteed loan of not less than');
    safeSetText(form, 'excluding any financed Funding Fee amortizable monthly for not less than', loanAmt);
    // D9 fix: Use loan_term_years as fallback, default to 30
    safeSetText(form, 'years', fv.va_amortization_years || fv.loan_term_years || '30');
    // D9 fix: Use interest_rate_cap as fallback
    safeSetText(form, 'with interest not to exceed', fv.va_interest_rate_cap || fv.interest_rate_cap || '');
    // D9 fix: Default rate cap period to 30 years
    safeSetText(form, 'per annum for the first_4', fv.va_per_annum_first || '30');
    // D9 fix: Default origination cap to 1.00
    safeSetText(form, 'Origination Charges as shown on Buyers Loan Estimate for the loan not to exceed', fv.va_origination_cap || '1.00');
    // D7 fix: Populate FHA/VA appraised value floor with sale_price fallback
    safeSetText(form, 'value of the Property established by the Department of Veterans Affairs', fv.va_appraised_value != null && fv.va_appraised_value !== '' ? formatMoney(fv.va_appraised_value) : (fv.sale_price != null ? formatMoney(fv.sale_price) : ''));
  }

  if (ft === 'usda' || fv.financing_usda === true) {
    safeCheck(form, '5 USDA Guaranteed Financing A USDAguaranteed loan of not less than');
    safeSetText(form, 'any financed PMI premium or other costs with interest not to exceed', loanAmt);
    // D10 NOTE: USDA term, rate cap %, rate cap period years, and origination cap % fields
    // are NOT YET ENUMERATED in trec-40-raw.pdf AcroForm. These fields need to be added to
    // the PDF template before they can be wired. Once added, wire:
    // - USDA term-years → fv.financing_usda_term_years || fv.loan_term_years || '30'
    // - USDA rate cap % → fv.financing_usda_rate_cap || fv.interest_rate_cap || ''
    // - USDA rate cap period → fv.financing_usda_rate_cap_period || '30'
    // - USDA origination cap % → fv.financing_usda_origination_cap || '1.00'
  }

  if (ft === 'reverse' || fv.financing_reverse === true) {
    safeCheck(form, '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity');
    safeSetText(form, 'excluding_2', fv.reverse_exclusion || '');
    safeSetText(form, 'not to exceed_2', fv.reverse_not_exceed || '');
    safeSetText(form, 'any financed Funding Fee amortizable monthly for not less than', loanAmt);
    safeSetText(form, 'per annum for the first_3', fv.reverse_per_annum || '');
    // D11 fix: Wire Reverse Mortgage "will/will not FHA insured" paired checkboxes
    if (fv.financing_reverse_fha_insured === true) {
      safeCheck(form, 'will');
      safeUncheck(form, 'will-1');
      safeUncheck(form, 'will-2');
      safeUncheck(form, 'will not be an FHA insured loan');
    } else if (fv.financing_reverse_fha_insured === false) {
      safeUncheck(form, 'will');
      safeUncheck(form, 'will-1');
      safeUncheck(form, 'will-2');
      safeCheck(form, 'will not be an FHA insured loan');
    }
  }

  if (ft === 'other' || fv.financing_other === true) {
    safeCheck(form, '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity-1');
    // F7 fix: Wire Other Financing block using -1-suffixed widget names
    safeSetText(form, 'excluding_2-1', fv.financing_other_principal || (fv.loan_amount != null ? formatMoney(fv.loan_amount) : ''));
    safeSetText(form, 'not to exceed-1', fv.financing_other_rate_cap || '');
    safeSetText(form, 'any financed Funding Fee amortizable monthly for not less than-1', fv.financing_other_term_years || '30');
    safeSetText(form, 'not to exceed_2-1', fv.financing_other_rate_cap_period || '30');
    safeSetText(form, 'per annum for the first_3-1', fv.financing_other_origination_cap || '1.00');
    // Other Financing waive 2B paired checkboxes
    if (fv.financing_other_waive_2b === true) {
      safeCheck(form, 'will-1');
      safeUncheck(form, 'will-2');
    } else if (fv.financing_other_waive_2b === false) {
      safeUncheck(form, 'will-1');
      safeCheck(form, 'will-2');
    }
  }

  // 2026-07-04 atlas_29 fix (Bug 4 — Heath): initials NOT pre-populated during fill phase.
  // safeSetText(form, 'Initialed for identification by Buyer', buyerInit);
  // safeSetText(form, 'undefined_2', buyerInit);
  // safeSetText(form, 'and Seller', sellerInit);
  // safeSetText(form, 'undefined_3', sellerInit);
  void buyerInit; void sellerInit;

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
async function fillTerminationNotice(pdfDoc, fv) {
  const form = pdfDoc.getForm();

  // PROPERTY + PARTIES
  const propertyFull = fv.property_full || [fv.property_address, fv.city_state_zip].filter(Boolean).join(', ');
  safeSetText(form, 'Street Address and City', propertyFull);
  safeSetText(form, 'BETWEEN THE UNDERSIGNED SELLER AND', fv.seller_name || '');
  safeSetText(form, 'BUYER', fv.buyer_name || '');

  // TERMINATION REASON (radio group)
  // termination_reason: 'earnest_money' selects option 1 (Paragraph 5 earnest money failure)
  // termination_reason: 'other' selects option 2 (other paragraph)
  if (fv.termination_reason === 'earnest_money') {
    try {
      const rg = form.getRadioGroup('1 Buyer failed to deliver the earnest money within the time required under Paragraph 5 of');
      if (rg) rg.select('undefined');
    } catch (e) {
      console.warn('[fill-form] termination radio group:', e && e.message);
    }
  } else if (fv.termination_reason === 'other') {
    try {
      const rg = form.getRadioGroup('1 Buyer failed to deliver the earnest money within the time required under Paragraph 5 of');
      if (rg) rg.select('undefined_2');
    } catch (e) {
      console.warn('[fill-form] termination radio group other:', e && e.message);
    }
  }

  // OTHER TERMINATION REASON PARAGRAPH REFERENCES (up to 6 lines)
  var otherReasons = fv.termination_other_reasons || [];
  if (typeof otherReasons === 'string') otherReasons = [otherReasons];
  for (var i = 1; i <= 6; i++) {
    safeSetText(form, '2 Other identify the paragraph number of contract or the addendum ' + i,
      (otherReasons[i - 1] != null ? String(otherReasons[i - 1]) : ''));
  }

  // DATES
  if (fv.contract_effective_date) {
    const ds = String(fv.contract_effective_date).includes('-') ? formatDate(fv.contract_effective_date) : fv.contract_effective_date;
    safeSetText(form, 'Date', ds);
  }
  const today = new Date().toISOString().slice(0, 10);
  safeSetText(form, 'Date_2', fv.termination_notice_date ? formatDate(fv.termination_notice_date) : formatDate(today));

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

  // UPDATED RESALE CERTIFICATE (Para B/A.3)
  // Gate: only populate if subdivision_method === 'already_received' (A.3 selected).
  // If buyer chose A.1/A.2/A.4, leave resale cert checkboxes blank (no parent selection = no child widgets).
  if (subMethod === 'already_received') {
    if (fv.requires_updated_resale_cert === true) {
      safeCheck(form, 'does');
    } else {
      safeCheck(form, 'does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at');
    }
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

  // 2026-07-04 atlas_29 fix (Bug 4 — Heath): signature-page date slots are NOT
  // pre-populated during the fill phase. Signer fills date next to their signature.
  // const signDate = fv.lead_paint_date
  //   ? formatDate(fv.lead_paint_date)
  //   : formatDate(new Date().toISOString().slice(0, 10));
  // ['Date', 'Date_2', 'Date_3', 'Date_4', 'Date_5', 'Date_6'].forEach(function(f) {
  //   safeSetText(form, f, signDate);
  // });

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

  // 2026-07-04 atlas_29 fix (Bug 4 — Heath): initials NOT pre-populated in fill phase.
  const buyerInit = '';
  const sellerInit = '';

  // Load base64 — asset exports { base64Pdf }
  // (Already loaded by fillForm; pdfDoc is passed in)

  // PARTIES
  safeSetText(form, '1 PARTIES The parties to this contract are', fv.buyer_name || '');
  safeSetText(form, 'and', fv.seller_name || '');

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
  const optionFeeRecipient = fv.option_fee_escrow_recipient || fv.title_company || fv.listing_agent_name || '';
  safeSetText(form, 'Seller or Listing Broker', optionFeeRecipient);
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

  // INITIALS
  var buyerInitFields9 = [
    'Initialed for identification by Buyer',
    'Initialed for identification by Buyer_2',
    'Initialed for identification by Buyer_3',
    'Initialed for identification by Buyer_4',
    'Initialed for identification by Buyer_5',
  ];
  var sellerInitFields9 = [
    'and Seller',
    'and Seller_2',
    'and Seller_3',
    'and Seller_4',
    'and Seller_5',
    'and Seller_6',
  ];
  // 2026-07-04 atlas_29 fix (Bug 4 — Heath): initials + signature-page name
  // slots NOT pre-populated in fill phase. Fields remain empty for the signer.
  // buyerInitFields9.forEach(function(f) { safeSetText(form, f, buyerInit); });
  // sellerInitFields9.forEach(function(f) { safeSetText(form, f, sellerInit); });
  // safeSetText(form, 'Buyer 4', fv.buyer_name || '');
  // safeSetText(form, 'Buyer 5', fv.buyer_name_2 || '');
  // safeSetText(form, 'Seller 4', fv.seller_name || '');
  // safeSetText(form, 'Seller 5', fv.seller_name_2 || '');
  void buyerInitFields9; void sellerInitFields9; void buyerInit; void sellerInit;

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

  const fv = fieldValues || {};

  // DocuSeal Prefill API forms (2026-06-17 pivot)
  // 2026-06-28 ATLAS ROLLBACK: DocuSeal template 4018208 (TREC 20-18) silently
  // returns 500 on every prefill attempt — verified via direct API probes with
  // every documented payload format (submitters[].values, submitters[].fields[],
  // top-level fields[], PATCH submitter). EVERY submission for 4018208 in the
  // last 24h has values: [0,0] meaning blank PDF. Heath's v3-FHA master prompt
  // produced 4 blank PDFs because the DocuSeal path drops all values silently.
  // The pdf-lib path is fully wired below for these forms (fillResaleContract,
  // fillFinancingAddendum, fillHoaAddendum, fillLeadPaintAddendum). Reverting
  // these 4 form_types to pdf-lib until DocuSeal template is rebuilt.
  const DOCUSEAL_FORMS = new Set([
    // 'resale-contract',         // DOCUSEAL BROKEN — pdf-lib path used
    // 'financing-addendum',      // DOCUSEAL BROKEN — pdf-lib path used
    // 'hoa-addendum',            // DOCUSEAL BROKEN — pdf-lib path used
    // 'lead-paint-addendum',     // DOCUSEAL BROKEN — pdf-lib path used
  ]);

  if (DOCUSEAL_FORMS.has(formType)) {
    try {
      const result = await prefillDocuSealTemplate(formType, fv);
      console.log('[fill-form] filled via DocuSeal:', formType, 'submission:', result.submissionId);
      // Fetch the PDF from DocuSeal and return as bytes
      const pdfRes = await fetch(result.pdfUrl, { timeout: 30000 });
      if (!pdfRes.ok) {
        throw new Error('DocuSeal PDF download failed: ' + pdfRes.status);
      }
      const buffer = await pdfRes.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (err) {
      throw new Error('DocuSeal prefill failed for ' + formType + ': ' + (err && err.message));
    }
  }

  // Legacy pdf-lib forms
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

  switch (formType) {
    case 'resale-contract':       await fillResaleContract(pdfDoc, fv); break;
    case 'financing-addendum':    await fillFinancingAddendum(pdfDoc, fv); break;
    case 'hoa-addendum':          await fillHoaAddendum(pdfDoc, fv); break;
    case 'lead-paint-addendum':   await fillLeadPaintAddendum(pdfDoc, fv); break;
    case 'termination-notice':    await fillTerminationNotice(pdfDoc, fv); break;
    case 'wire-fraud-warning':    await fillWireFraudWarning(pdfDoc, fv); break;
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

  // ATLAS 2026-06-28 NO-FLATTEN FIX: Hadley diagnosed that pdf-lib's form.flatten()
  // STRIPS checkbox X marks during the flatten render — values are correctly
  // written to /V slots, but flatten kills the visible appearance for checkboxes.
  // This explains every Heath-reported "values stored but invisible" bug:
  //   - §7.D "Accepts As Is" checkbox blank
  //   - §6.A Seller's title-policy box blank
  //   - §1.C FHA INSURED FINANCING box blank
  //   - plus the broader checkbox-rendering class of bugs.
  //
  // Fix: generate appearance streams via updateFieldAppearances() (which produces
  // visible X marks + text in the widget appearance streams), then SKIP flatten.
  // The form widgets remain interactive in viewers that support them, but the
  // appearance streams are baked so the values are visible in any PDF viewer
  // (including pdftoppm, browser PDF render, print, etc.).
  try {
    pdfDoc.getForm().updateFieldAppearances();
  } catch (e) {
    console.warn('[fill-form] updateFieldAppearances failed:', e && e.message);
  }
  // ATLAS 2026-06-28 EOD pivot: set /NeedAppearances=true on the AcroForm so PDF
  // viewers that ignore baked appearance streams (poppler, some Acrobat configs,
  // browser PDF renderers) will recompute appearances at render time. TREC's
  // original PDFs DON'T set this flag, so without this override every checkbox
  // value silently fails to render anywhere except in Acrobat-full.
  try {
    const { PDFName, PDFBool } = require('pdf-lib');
    pdfDoc.getForm().acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  } catch (e) {
    console.warn('[fill-form] NeedAppearances flag set failed:', e && e.message);
  }

  // ATLAS 2026-06-28 BULLETPROOF X-OVERLAY: For every checked checkbox, draw a
  // literal "X" character at the widget's rectangle position. This works in
  // EVERY PDF viewer (Adobe, Chrome, Firefox, pdftoppm, Telegram preview, mobile,
  // PWA) because it's just page-level text drawn at exact widget coordinates —
  // no font tricks, no /AP appearance stream voodoo, no /NeedAppearances flag
  // dependency. The widget's /V is still set so the form value persists when
  // editing in Acrobat; the overlay just guarantees visible rendering everywhere.
  try {
    const { PDFName } = require('pdf-lib');
    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    // Build a map from PDFRef -> pageIndex for fast lookup
    const widgetRefToPage = new Map();
    for (let pi = 0; pi < pages.length; pi++) {
      const annots = pages[pi].node.Annots();
      if (!annots || !annots.asArray) continue;
      const arr = annots.asArray();
      for (const annRef of arr) {
        widgetRefToPage.set(annRef, pi);
      }
    }
    const checkboxes = form.getFields().filter(function(f) { return f.constructor.name === 'PDFCheckBox'; });
    let overlayCount = 0;
    for (const cb of checkboxes) {
      let isChecked = false;
      try { isChecked = cb.isChecked(); } catch (e) { continue; }
      if (!isChecked) continue;
      const widgets = cb.acroField.getWidgets();
      for (const w of widgets) {
        const dict = w.dict;
        const rect = dict.get(PDFName.of('Rect'));
        if (!rect || !rect.asArray) continue;
        const r = rect.asArray().map(function(n) { return n.numberValue || 0; });
        const x0 = r[0], y0 = r[1], x1 = r[2], y1 = r[3];
        const w_ = x1 - x0, h_ = y1 - y0;
        // Find which page contains this widget annotation
        let pageIdx = -1;
        for (const [ref, pi] of widgetRefToPage.entries()) {
          const annDict = pdfDoc.context.lookup(ref);
          if (annDict === dict) { pageIdx = pi; break; }
        }
        if (pageIdx < 0) continue;
        const page = pages[pageIdx];
        // Draw a bold X centered in the widget rect. Font size is min(w,h) scaled
        // so the X visually fills the box. The page-level drawing covers any
        // missing appearance stream rendering — pdftoppm/Chrome/Adobe all show it.
        const fontSize = Math.max(6, Math.min(w_, h_) * 1.0);
        // Center horizontally: x = x0 + (w - charWidth)/2; charWidth ~= fontSize*0.5 for X
        const cx = x0 + (w_ - fontSize * 0.5) / 2;
        const cy = y0 + (h_ - fontSize * 0.72) / 2;
        try {
          page.drawText('X', { x: cx, y: cy, size: fontSize });
          overlayCount++;
        } catch (e) { /* drawText can fail if font missing; ignore */ }
      }
    }
    console.log('[fill-form] drew X overlay on ' + overlayCount + ' checked widgets');
  } catch (e) {
    console.warn('[fill-form] X-overlay pass failed:', e && e.message);
  }
  // FLATTEN REMOVED 2026-06-28 — pdf-lib's flatten() bug strips checkbox X marks.

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
    let mergedFields = Object.assign({}, txDefaults, fieldValues);

    // ----------------------------------------------------------------------
    // TREC 20-18 strict validation pipeline (opt-in via body.strict_validate)
    // Heath's hand-built Layer 3 lives at scripts/trec-20-18-field-rules.json
    // + scripts/trec-validator.js. Pipeline at api/_lib/trec-20-18-pipeline.js
    // wires Layer 2 (mapper) -> validate() -> self-correction loop (Opus 4.7)
    // -> fillable -> legacy fv conversion (for the existing pdf-lib renderer).
    //
    // Only runs for resale-contract (TREC 20-18) when caller asks for it.
    // Returns 422 with a structured `validation` object if pass:false after
    // max retries, so the caller can surface UNMATCHED fields for human review.
    // ----------------------------------------------------------------------
    let validationReport = null;
    const strictValidateRequested = body.strict_validate === true ||
      String(req.query?.strict_validate || '').toLowerCase() === '1' ||
      String(req.query?.strict_validate || '').toLowerCase() === 'true';
    if (strictValidateRequested && resolvedFormType === 'resale-contract') {
      try {
        const { runPipeline } = require('./_lib/trec-20-18-pipeline');
        const pipelineRes = await runPipeline({
          fieldValues: mergedFields,
          intake: body.intake && typeof body.intake === 'object' ? body.intake : null,
          sourceMessage: typeof body.source_message === 'string' ? body.source_message : null,
          transactionContext: tx || {},
          log: (entry) => console.log('[fill-form][strict-validate]', JSON.stringify(entry)),
        });
        validationReport = {
          pass: pipelineRes.pass,
          flags: pipelineRes.flags,
          retries: pipelineRes.retries,
          unmatched: pipelineRes.unmatched,
          fillable_count: Object.keys(pipelineRes.fillable || {}).length,
        };
        if (!pipelineRes.pass) {
          console.warn('[fill-form] strict validation FAILED', JSON.stringify(validationReport));
          return res.status(422).json({
            ok: false,
            error: 'TREC 20-18 validation did not pass — fields need human review.',
            validation: {
              ...validationReport,
              report: pipelineRes.report.filter(
                (r) => r.status === 'FAIL' || r.status === 'UNMATCHED'
              ),
            },
          });
        }
        // Validator passed — feed the canonical fillable back through the
        // legacy fv-shape so the existing fillResaleContract() renderer
        // consumes the validated values (not the raw extractor output).
        mergedFields = pipelineRes.legacyFv;
        console.log('[fill-form] strict validation PASSED', JSON.stringify(validationReport));
      } catch (e) {
        console.error('[fill-form] strict_validate runtime error:', e && e.message);
        return res.status(500).json({
          ok: false,
          error: 'TREC 20-18 validation pipeline runtime error: ' + (e && e.message),
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
      validation: validationReport, // null unless strict_validate was true
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
