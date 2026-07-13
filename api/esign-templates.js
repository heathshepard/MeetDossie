// Vercel Serverless Function: /api/esign-templates
// GET  — returns list of available TREC template types with DocuSeal template IDs
// POST { templateType, transactionId, signers } — creates a DocuSeal submission
//        from a pre-built template, pre-filling known transaction fields
//
// Authorization: Bearer <supabase user JWT>
//
// DocuSeal template IDs are stored in env vars (set in Vercel dashboard):
//   DOCUSEAL_TEMPLATE_AMENDMENT      — TREC 39-10 Amendment
//   DOCUSEAL_TEMPLATE_OPTION_EXT     — Option Period Extension
//   DOCUSEAL_TEMPLATE_PRICE_CHANGE   — Price Change Amendment
//
// Templates must be created in the DocuSeal dashboard first, then their IDs
// copied into the env vars above. Until they're set, this endpoint returns
// the template list but stubs out the submission call.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   DOCUSEAL_API_KEY
//   DOCUSEAL_TEMPLATE_AMENDMENT    (optional — stub if missing)
//   DOCUSEAL_TEMPLATE_OPTION_EXT   (optional — stub if missing)
//   DOCUSEAL_TEMPLATE_PRICE_CHANGE (optional — stub if missing)

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { applyCorsHeaders } = require('./_middleware/cors');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

// Template registry — each entry maps a human-readable type to a DocuSeal
// template ID stored in env vars OR a hard-coded fallback for known TREC
// templates. Adding a new TREC form only requires:
// 1. Creating the template in DocuSeal
// 2. Adding the env var (or adding fallbackId if the DocuSeal template already
//    exists and its ID is stable)
// 3. Adding an entry here
//
// 2026-07-13 CARTER — Bug #3 (Quinn DoD Round 1). Old registry had 3 amendment
// templates. Extended to all 15 canonical TREC/TAR templates from the DoD
// spec. IDs sourced from feedback_docuseal_template_ids memory + DoD prompt.
const BUYER_SELLER_2 = [
  { role: 'Buyer 1',  label: 'Buyer 1' },
  { role: 'Buyer 2',  label: 'Buyer 2' },
  { role: 'Seller 1', label: 'Seller 1' },
  { role: 'Seller 2', label: 'Seller 2' },
];
const BUYER_SELLER_1 = [
  { role: 'Buyer',  label: 'Buyer' },
  { role: 'Seller', label: 'Seller' },
];
const CORE_PREFILL = [
  'property_address',
  'buyer_name',
  'seller_name',
  'purchase_price',
  'closing_date',
];

const TEMPLATE_REGISTRY = [
  // ---- The 15 canonical templates (DoD spec section 4) ----
  {
    type: 'resale_contract',
    label: 'TREC 20-19 Resale Contract',
    description: 'One to Four Family Residential Contract (Resale)',
    envVar: 'DOCUSEAL_TEMPLATE_RESALE_CONTRACT',
    fallbackId: '4952172',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    // 2026-07-13 Round 5 — Template 4023463 uses submitter roles "Buyer" and
    // "Seller" (no 1/2 split). Extra prefill fields: loan_amount, down_payment,
    // financing_type (checkbox), interest_rate, loan_term_years, credit_approval_days.
    type: 'financing_addendum',
    label: 'TREC 40-11 Third Party Financing',
    description: 'Third Party Financing Addendum',
    envVar: 'DOCUSEAL_TEMPLATE_FINANCING_ADDENDUM',
    fallbackId: '4023463',
    defaultSigners: BUYER_SELLER_1,
    prefillFields: [
      'property_address',
      'loan_amount',
      'down_payment',
      'financing_type',
      'interest_rate',
      'loan_term_years',
      'credit_approval_days',
    ],
  },
  {
    type: 'lender_appraisal',
    label: 'TREC 49-1 Lender Appraisal',
    description: 'Notice of Buyer\'s Termination Due to Lender\'s Appraisal',
    envVar: 'DOCUSEAL_TEMPLATE_LENDER_APPRAISAL',
    fallbackId: '4023472',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    // 2026-07-13 Round 6 — Template 4111320 (TREC 39-11) uses 4-role split:
    // Buyer 1, Buyer 2, Seller 1, Seller 2. Prior default of BUYER_SELLER_1
    // silently dropped Buyer 2 / Seller 2 when co-buyers/co-sellers were on
    // the deal. Prefill fields extended to include amendment-specific keys
    // (amendment_description, amendment_new_price, amendment_new_closing_date,
    // amendment_new_earnest_money, amendment_option_fee, amendment_effective_date)
    // which map to §1, §3, §4, §6 and DATE OF FINAL ACCEPTANCE via
    // TEMPLATE_FIELD_MAPPERS['4111320'].
    type: 'amendment',
    label: 'TREC 39-11 Amendment',
    description: 'Amendment to Contract — modify closing date, sales price, or other terms',
    envVar: 'DOCUSEAL_TEMPLATE_AMENDMENT',
    fallbackId: '4111320',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: [
      'property_address',
      'amendment_description',
      'amendment_new_price',
      'amendment_new_closing_date',
      'amendment_new_earnest_money',
      'amendment_option_fee',
      'amendment_effective_date',
    ],
  },
  {
    type: 'hoa_addendum',
    label: 'TREC 36-11 HOA Addendum',
    description: 'Addendum for Property Subject to Mandatory Membership in a POA',
    envVar: 'DOCUSEAL_TEMPLATE_HOA_ADDENDUM',
    fallbackId: '4111321',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'lead_paint_addendum',
    label: 'OP-L Lead-Based Paint',
    description: 'Addendum for Seller\'s Disclosure of Info on Lead-Based Paint',
    envVar: 'DOCUSEAL_TEMPLATE_LEAD_PAINT',
    fallbackId: '4023469',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'sellers_disclosure',
    label: 'OP-H Seller\'s Disclosure',
    description: 'Seller\'s Disclosure Notice',
    envVar: 'DOCUSEAL_TEMPLATE_SELLERS_DISCLOSURE',
    fallbackId: '4023470',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'groundwater_notice',
    label: 'TREC 61-0 Groundwater',
    description: 'Notice on Availability of Public Groundwater Rights',
    envVar: 'DOCUSEAL_TEMPLATE_GROUNDWATER',
    fallbackId: '4111328',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'backup_11_8',
    label: 'TREC 11-8 Backup Contract',
    description: 'Addendum for Back-Up Contract',
    envVar: 'DOCUSEAL_TEMPLATE_BACKUP_11_8',
    fallbackId: '4023578',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'backup_11_9',
    label: 'TREC 11-9 Backup Contract',
    description: 'Addendum for Back-Up Contract (updated variant)',
    envVar: 'DOCUSEAL_TEMPLATE_BACKUP_11_9',
    fallbackId: '4111323',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'seller_financing',
    label: 'TREC 26 Seller Financing',
    description: 'Seller Financing Addendum',
    envVar: 'DOCUSEAL_TEMPLATE_SELLER_FINANCING',
    fallbackId: '4023573',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'farm_ranch',
    label: 'TREC 25-17 Farm & Ranch',
    description: 'Farm and Ranch Contract',
    envVar: 'DOCUSEAL_TEMPLATE_FARM_RANCH',
    fallbackId: '4111325',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'condo_contract',
    label: 'TREC 30-18 Condominium',
    description: 'Residential Condominium Contract (Resale)',
    envVar: 'DOCUSEAL_TEMPLATE_CONDO',
    fallbackId: '4111324',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'new_home_incomplete',
    label: 'TREC 23-20 New Home Incomplete',
    description: 'New Home Contract (Incomplete Construction)',
    envVar: 'DOCUSEAL_TEMPLATE_NEW_HOME_INCOMPLETE',
    fallbackId: '4111326',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  {
    type: 'new_home_complete',
    label: 'TREC 24-20 New Home Complete',
    description: 'New Home Contract (Completed Construction)',
    envVar: 'DOCUSEAL_TEMPLATE_NEW_HOME_COMPLETE',
    fallbackId: '4111327',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
  },
  // ---- Legacy amendment shortcuts kept for existing callers ----
  {
    type: 'option_extension',
    label: 'Option Period Extension',
    description: 'Extend the option period with an additional fee (TREC 39-11)',
    envVar: 'DOCUSEAL_TEMPLATE_OPTION_EXT',
    fallbackId: '4111320',
    defaultSigners: BUYER_SELLER_1,
    prefillFields: [
      'property_address',
      'buyer_name',
      'seller_name',
      'option_expiration_date',
    ],
  },
  {
    type: 'price_change',
    label: 'Sales Price Change',
    description: 'Amend the purchase price (TREC 39-11 Paragraph 1)',
    envVar: 'DOCUSEAL_TEMPLATE_PRICE_CHANGE',
    fallbackId: '4111320',
    defaultSigners: BUYER_SELLER_1,
    prefillFields: [
      'property_address',
      'buyer_name',
      'seller_name',
      'purchase_price',
    ],
  },
];

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, POST, OPTIONS' });
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

function getTemplateId(envVar, fallbackId) {
  // 2026-07-13 CARTER — accept a fallbackId so canonical TREC templates with
  // stable DocuSeal IDs are always "available" even without env vars set.
  // Env var still wins when present so ops can point at a different template
  // without a code deploy.
  //
  // 2026-07-13 Round 6 — Vercel env-var editing can accept literal backslash-n
  // or trailing whitespace at paste time (invisible in the UI list). Strip
  // whitespace, control chars, and literal escape sequences so the returned id
  // is a clean lookup key for TEMPLATE_FIELD_MAPPERS / TEMPLATE_ROLES.
  // Diagnosed 2026-07-13: DOCUSEAL_TEMPLATE_AMENDMENT stored "4111320"
  // with a trailing literal backslash-n suffix, causing prod to fall through to
  // defaultFieldMapper on 39-11 amendment.
  const raw = envVar && process.env[envVar] ? process.env[envVar] : fallbackId;
  if (raw == null) return null;
  const cleaned = String(raw)
    .replace(/\\[nrt]/g, '')
    .replace(/[\s -]+/g, '')
    .trim();
  return cleaned || null;
}

async function fetchTransaction(transactionId, userId) {
  // 2026-07-13 Round 5 — Extended SELECT to include financing columns so
  // TREC 40-11 (Third Party Financing Addendum) gets proper prefill for
  // loan_amount / financing_type / down_payment / financing_days / etc.
  const res = await supa(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,property_address,buyer_name,seller_name,sale_price,closing_date,city_state_zip,option_expiration_date,loan_amount,down_payment,financing_type,financing_days&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// 2026-07-13 CARTER Round 4 — Bug: DocuSeal template 4952172 (TREC 20-19) uses
// submitter roles "Buyer 1", "Buyer 2", "Seller 1", "Seller 2" — not the
// generic "Buyer"/"Seller" that legacy UI passes.
//
// 2026-07-13 Round 5 — Extended for TREC 40-11 (template 4023463):
//   - 40-11 uses submitter roles "Buyer" and "Seller" (NO 1/2 split)
//   - 40-11 field names are completely different (first_loan_amount,
//     fha_loan_amount, credit_approval_days, va_financing checkbox, etc.)
//   - Role normalization is now per-template (via TEMPLATE_ROLES map)
//   - Field mapping is now per-template (via expandPrefillForTemplate)
//   - Values are applied via clone-with-default_value (like esign-create.js)
//     rather than submitter.values, to bypass DocuSeal's 500-error bug on
//     templates 4018208 / 4023463 / 4952172 when values target owner fields.
const TEMPLATE_ROLES = {
  // Template 4952172 (TREC 20-19): 4-role split
  '4952172': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4023463 (TREC 40-11): 2-role
  '4023463': ['Buyer', 'Seller'],
  // Template 4111320 (TREC 39-11 Amendment): 4-role split (Round 6)
  '4111320': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Default: 4-role (matches the resale flavor)
  DEFAULT: ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
};

// Per-template role normalization. Given an incoming role string and the target
// template's role list, pick the closest match. E.g. "Buyer" onto 40-11 stays
// as "Buyer"; "Buyer" onto 20-19 → "Buyer 1".
function normalizeRoleForTemplate(role, templateId) {
  if (!role) return null;
  const trimmed = String(role).trim();
  const rolesForTemplate = TEMPLATE_ROLES[String(templateId)] || TEMPLATE_ROLES.DEFAULT;

  // Exact match on the template's role list.
  const exact = rolesForTemplate.find((r) => r.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;

  // Buyer/Seller prefix match — pick first available role on that side.
  const isBuyer = /^buyer/i.test(trimmed);
  const isSeller = /^seller/i.test(trimmed);
  if (isBuyer) {
    // For 20-19 style with Buyer 1/Buyer 2, respect the digit if present.
    const digit = trimmed.match(/(\d+)/);
    if (digit) {
      const withDigit = `Buyer ${digit[1]}`;
      const found = rolesForTemplate.find((r) => r.toLowerCase() === withDigit.toLowerCase());
      if (found) return found;
    }
    return rolesForTemplate.find((r) => /buyer/i.test(r)) || trimmed;
  }
  if (isSeller) {
    const digit = trimmed.match(/(\d+)/);
    if (digit) {
      const withDigit = `Seller ${digit[1]}`;
      const found = rolesForTemplate.find((r) => r.toLowerCase() === withDigit.toLowerCase());
      if (found) return found;
    }
    return rolesForTemplate.find((r) => /seller/i.test(r)) || trimmed;
  }

  // Pass through anything else.
  return trimmed;
}

// Per-template field mapping. Each function takes the caller's semantic prefill
// keys and returns the DocuSeal-native AcroForm field names to use as
// default_value on the cloned template.
//
// Rationale: the same "loan_amount" from Dossie needs to hit
// "first_loan_amount" on 40-11 or "loan_amount" on 20-19. Central per-template
// tables prevent field-name drift across the 15 canonical TREC forms.
const TEMPLATE_FIELD_MAPPERS = {
  // TREC 20-19 (resale contract)
  '4952172': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address_page4'] = s;
          expanded['property_address_page5'] = s;
          expanded['property_address_page6'] = s;
          expanded['property_address_header_p8'] = s;
          expanded['property_address_page_11'] = s;
          expanded['Address of Property'] = s;
          expanded['Addr of Prop'] = s;
          expanded['property_address'] = s;
          break;
        case 'seller_name':
          expanded['seller_name'] = s;
          break;
        case 'buyer_name':
          expanded['buyer_name'] = s;
          break;
        case 'purchase_price':
        case 'sale_price':
          expanded['sales_price_total'] = s;
          expanded['sales_price_cash_portion'] = s;
          expanded['purchase_price'] = s;
          expanded['sale_price'] = s;
          break;
        case 'closing_date':
          expanded['A The closing of the sale will be on or before'] = s;
          expanded['closing_date'] = s;
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 39-11 Amendment (template 4111320)
  // Field names sourced from .tmp/docuseal-15-verify/tmpl_4111320.json.
  // The 39-11 PDF is a single page with §1-9 numbered amendment options.
  // Most fields on the template have cryptic names ("Text1", "date 5",
  // "Text 10", "as follows", "for an extension of the", "contract", empty
  // strings). Round 6 maps Dossie's semantic keys to the observed names for
  // the most common amendment scenarios (new price, new closing date, new
  // earnest money, option fee, other modifications free-text).
  //
  // Naming reference (verified via tmpl_4111320.json + positional inspection):
  //   Street Address and City  -> §property header (page 0, y=0.11)
  //   Text 8 / Text 9 / Text 10 -> §1 sales price A/B/C rows (right column)
  //   Text1                     -> §2 seller repairs description (line 1)
  //   date 5                    -> §3 new closing date text
  //   6 Buyer has paid Seller an additional Option Fee of (checkbox)
  //   Text6 / Text7 1           -> §8 buyer approval notice date / year
  //   9 Other Modifications ... (checkbox for §9)
  //   DATE OF FINAL ACCEPTANCE  -> effective date (the field name IS the label
  //                                on this template — same trap as 20-19).
  //
  // Because many text-input slots have empty-string names, DocuSeal can't
  // reliably route by name for them. We prefer the named fields we know
  // exist. The free-text §10 "Other Modifications" is split across three
  // blank-named lines (fields 41, 42, 43) — we write to the checkbox marker
  // via the labeled trigger + push the description into Text1 as a fallback.
  '4111320': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address': {
          // The single property field on 39-11 is literally named
          // "Street Address and City". Also write to a few plausible fallbacks
          // (DocuSeal drops unmatched keys silently, so extra keys are safe).
          expanded['Street Address and City'] = s;
          expanded['property_address'] = s;
          break;
        }
        case 'amendment_description':
        case 'other_modifications': {
          // §10 "Other Modifications" — free-text section.  Push into Text1
          // (primary description line under §2) AND Text6 (§8 area label
          // that also renders on the PDF). DocuSeal drops unmatched keys, so
          // hitting both is safe. Priority is a real user-visible field.
          expanded['Text1'] = s;
          expanded['Text6'] = s;
          expanded['amendment_description'] = s;
          expanded['other_modifications'] = s;
          break;
        }
        case 'amendment_new_price':
        case 'new_price':
        case 'new_sales_price': {
          // §1 new sales price. On the amendment, this is broken into 3 rows
          // (A cash portion / B financing / C total). We write the total into
          // Text 10 (row C) and pass through the alternate keys DocuSeal may
          // match. Currency formatting: strip any commas/$ so user-entered
          // "$425,000" reduces to "425000" first.
          const clean = String(s).replace(/[^\d.-]/g, '');
          expanded['Text 10'] = clean;      // Row C — Sales Price (total)
          expanded['Text 8']  = clean;      // Row A — Cash portion (fallback)
          expanded['Text 9']  = '0';        // Row B — financing sum (zero if all cash)
          expanded['new_sales_price'] = clean;
          expanded['amendment_new_price'] = clean;
          break;
        }
        case 'amendment_new_closing_date':
        case 'new_closing_date': {
          // §3 new closing date -> "date 5" text field.
          expanded['date 5'] = s;
          expanded['new_closing_date'] = s;
          expanded['amendment_new_closing_date'] = s;
          break;
        }
        case 'amendment_new_earnest_money':
        case 'new_earnest_money': {
          // §4 new earnest money amount -> unnamed field (index 14, y=0.338).
          // DocuSeal exposes it with empty name so we can't target it reliably.
          // Pass through as a labeled hint; the empty-name field will render
          // blank until the agent uploads the Interactive Editor variant.
          expanded['new_earnest_money'] = s;
          expanded['amendment_new_earnest_money'] = s;
          break;
        }
        case 'amendment_option_fee':
        case 'new_option_fee': {
          // §6 option fee dollar amount + extension days
          expanded['as follows'] = s;
          expanded['new_option_fee'] = s;
          expanded['amendment_option_fee'] = s;
          break;
        }
        case 'amendment_effective_date':
        case 'effective_date': {
          // The bottom "EXECUTED the day of __, 20 __" area. The field name
          // "DATE OF FINAL ACCEPTANCE" is the FIELD (same trap as 20-19),
          // NOT the label. Write the effective date there.
          expanded['DATE OF FINAL ACCEPTANCE'] = s;
          expanded['effective_date'] = s;
          expanded['amendment_effective_date'] = s;
          break;
        }
        // Canonical keys that may not have direct fields but pass through in
        // case DocuSeal's future field rename catches them.
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
          expanded[key] = s;
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 40-11 (Third Party Financing Addendum)
  // Field names sourced from .tmp/docuseal-15-verify/tmpl_4023463.json
  '4023463': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          // 40-11 has property_address on page 1 (as "property_address") + page 2
          // (as "property_address_p2"). Both get the same value.
          expanded['property_address'] = s;
          expanded['property_address_p2'] = s;
          break;
        case 'loan_amount':
          // Route to the correct loan_amount field based on financing_type
          // if provided; otherwise write to all four common variants.
          // (DocuSeal drops unmatched keys — safe to include all.)
          expanded['first_loan_amount'] = s;
          expanded['fha_loan_amount'] = s;
          expanded['va_loan_amount'] = s;
          expanded['usda_loan_amount'] = s;
          expanded['loan_amount'] = s;
          break;
        case 'interest_rate':
          expanded['first_interest_rate'] = s;
          expanded['fha_interest_rate'] = s;
          expanded['va_interest_rate'] = s;
          expanded['usda_interest_rate'] = s;
          expanded['interest_rate'] = s;
          break;
        case 'loan_term_years':
        case 'loan_term':
          expanded['first_loan_term_years'] = s;
          expanded['fha_amortization_years'] = s;
          expanded['va_amortization_years'] = s;
          expanded['usda_term_years'] = s;
          expanded['loan_term_years'] = s;
          break;
        case 'credit_approval_days':
        case 'financing_days':
          expanded['credit_approval_days'] = s;
          break;
        case 'financing_type': {
          // Toggle the corresponding checkbox. DocuSeal checkbox default_value
          // accepts "true"/"false" strings. Written per-key; unmatched keys are
          // safely ignored.
          const type = String(s).toLowerCase();
          if (type.includes('conventional')) expanded['conventional_financing'] = 'true';
          if (type.includes('fha')) expanded['fha_financing'] = 'true';
          if (type.includes('va') && !type.includes('vet')) expanded['va_financing'] = 'true';
          if (type.includes('usda')) expanded['usda_financing'] = 'true';
          if (type.includes('tx') && type.includes('vet')) expanded['tx_veterans_loan'] = 'true';
          if (type.includes('reverse')) expanded['reverse_mortgage'] = 'true';
          expanded['financing_type'] = s;
          break;
        }
        case 'down_payment':
          // Not directly present on 40-11; pass through.
          expanded['down_payment'] = s;
          break;
        // Pass through canonical keys DocuSeal may match directly.
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
          expanded[key] = s;
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },
};

// Default mapper: pass through all keys as-is. Used for templates without a
// custom mapper defined yet (harmless — DocuSeal drops unmatched keys silently).
function defaultFieldMapper(prefillData) {
  const expanded = {};
  for (const [key, value] of Object.entries(prefillData)) {
    if (value === null || value === undefined || value === '') continue;
    expanded[key] = typeof value === 'string' ? value : String(value);
  }
  return expanded;
}

function expandPrefillForTemplate(prefillData, templateId) {
  if (!prefillData || typeof prefillData !== 'object') return {};
  const mapper = TEMPLATE_FIELD_MAPPERS[String(templateId)] || defaultFieldMapper;
  return mapper(prefillData);
}

// Back-compat shim for any external caller of the old name.
function expandPrefillToDocusealFields(prefillData, templateId) {
  return expandPrefillForTemplate(prefillData, templateId || '4952172');
}

// Clone the template + set default_value on each field named in `defaults` so
// DocuSeal renders the values at sign-time WITHOUT the 500-error bug that
// affects submitter.values on templates 4018208 / 4023463 / 4952172.
async function docusealCloneTemplateWithDefaults(templateId, defaults) {
  const cloneRes = await fetch(`${DOCUSEAL_BASE}/templates/${templateId}/clone`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: `Dossie envelope ${Date.now()}` }),
  });
  if (!cloneRes.ok) {
    const text = await cloneRes.text().catch(() => '');
    throw new Error(`DocuSeal template clone failed (${cloneRes.status}): ${text.slice(0, 200)}`);
  }
  const cloneData = await cloneRes.json();
  const cloneId = cloneData.id;
  if (!cloneId) throw new Error('DocuSeal clone returned no id.');

  const existingFields = Array.isArray(cloneData.fields) ? cloneData.fields : [];
  const patchedFields = existingFields.map((f) => {
    if (defaults[f.name] != null && defaults[f.name] !== '') {
      return { ...f, default_value: String(defaults[f.name]) };
    }
    return f;
  });
  const setCount = patchedFields.filter((f) => f.default_value != null && f.default_value !== '').length;

  const putRes = await fetch(`${DOCUSEAL_BASE}/templates/${cloneId}`, {
    method: 'PUT',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: patchedFields }),
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '');
    // Best-effort delete clone before throwing.
    fetch(`${DOCUSEAL_BASE}/templates/${cloneId}`, {
      method: 'DELETE',
      headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
    }).catch(() => {});
    throw new Error(`DocuSeal template defaults PUT failed (${putRes.status}): ${text.slice(0, 200)}`);
  }

  console.log(`[esign-templates] Cloned template ${templateId} -> ${cloneId}, applied ${setCount} default_value(s).`);
  return cloneId;
}

async function createTemplateSubmission({ templateId, signers, prefillData, message }) {
  if (!DOCUSEAL_API_KEY) {
    console.warn('[esign-templates] DOCUSEAL_API_KEY not set — returning stub submission.');
    return {
      id: `stub-tmpl-${Date.now()}`,
      submitters: signers.map((s, i) => ({
        uuid: `stub-uuid-${i}`,
        slug: `stub-slug-${i}`,
        name: s.name,
        email: s.email,
        role: normalizeRoleForTemplate(s.role, templateId) || s.role,
        status: 'sent',
        embed_src: null,
      })),
    };
  }

  // 2026-07-13 Round 5 — Prefill via clone-with-default_value (NOT
  // submitter.values). Templates 4018208, 4023463, 4952172 all return HTTP 500
  // when values target fields owned by the submitter — this is the reliable
  // workaround shipped in esign-create.js for the resale template.
  const expandedValues = expandPrefillForTemplate(prefillData, templateId);
  const hasValues = Object.keys(expandedValues).length > 0;

  // 2026-07-13 Round 6 diagnostic — log the shape reaching the clone step so
  // we can confirm the mapper is producing keys in production, not just on
  // preview.  Keys only (not values) to avoid leaking PII to Vercel logs.
  console.log(`[esign-templates] templateId=${templateId} prefillKeys=[${Object.keys(prefillData || {}).join(',')}] expandedKeys=[${Object.keys(expandedValues).join(',')}] hasValues=${hasValues}`);

  let submissionTemplateId = templateId;
  if (hasValues) {
    submissionTemplateId = await docusealCloneTemplateWithDefaults(templateId, expandedValues);
  }

  // Normalize each signer's role per-template. 40-11 → "Buyer"/"Seller".
  // 20-19 → "Buyer 1"/"Buyer 2"/"Seller 1"/"Seller 2".
  const normalizedSubmitters = signers.map((s) => ({
    name: s.name,
    email: s.email,
    role: normalizeRoleForTemplate(s.role, templateId) || 'Signer',
  }));

  const body = {
    template_id: submissionTemplateId,
    send_email: true,
    submitters: normalizedSubmitters,
    ...(message ? { email_body: message } : {}),
  };

  const res = await fetch(`${DOCUSEAL_BASE}/submissions`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DocuSeal template submission failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const raw = await res.json();
  // DocuSeal /submissions returns EITHER an array of submitter objects
  // (each with submission_id, embed_src, email, role, etc.) OR — depending on
  // API version — an object like { id, submitters: [...] }. Normalize to the
  // {id, submitters} shape the downstream mapper expects.
  if (Array.isArray(raw)) {
    const submissionId = raw[0]?.submission_id ?? raw[0]?.id ?? null;
    return {
      id: submissionId,
      submitters: raw.map((s) => ({
        uuid: s.uuid,
        slug: s.slug,
        name: s.name,
        email: s.email,
        role: s.role,
        status: s.status || 'sent',
        embed_src: s.embed_src || null,
      })),
    };
  }
  return raw;
}

async function insertSignatureRequest(row) {
  const res = await supa('signature_requests', {
    method: 'POST',
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`signature_requests insert failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : rows;
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  const ip = clientIpFromReq(req);

  // ---- GET: return template list ----
  if (req.method === 'GET') {
    try {
      await checkRateLimit(ip, 'esign-templates-get', 60, 60 * 1000);
      await verifySupabaseToken(req);

      const templates = TEMPLATE_REGISTRY.map((t) => ({
        type: t.type,
        label: t.label,
        description: t.description,
        defaultSigners: t.defaultSigners,
        prefillFields: t.prefillFields,
        available: !!getTemplateId(t.envVar, t.fallbackId),
        // Don't expose the env var name or template ID to the client.
      }));

      return res.status(200).json({ ok: true, templates });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.status || 401).json({ ok: false, error: error.message });
      }
      if (error instanceof RateLimitError) {
        if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
        return res.status(429).json({ ok: false, error: 'Too many requests.' });
      }
      console.error('[esign-templates GET] error:', error && error.message);
      return res.status(500).json({ ok: false, error: 'Could not fetch templates.' });
    }
  }

  // ---- POST: create template submission ----
  if (req.method === 'POST') {
    try {
      await checkRateLimit(ip, 'esign-templates-post', 20, 60 * 60 * 1000);
      const { userId } = await verifySupabaseToken(req);

      const body = req.body || {};
      const templateType = sanitizeString(body.templateType, { maxLength: 100 });
      const transactionId = sanitizeString(body.transactionId, { maxLength: 200 });
      const message = sanitizeString(body.message, { maxLength: 1000 }) || null;
      const signers = Array.isArray(body.signers) ? body.signers : [];
      // documentId is optional — if provided, we link the signature request to a document row.
      const documentId = sanitizeString(body.documentId, { maxLength: 200 }) || null;
      // Additional prefill values from the form (e.g. new_closing_date, new_price).
      const extraPrefill = (body.prefillData && typeof body.prefillData === 'object') ? body.prefillData : {};

      if (!templateType) throw new ValidationError('templateType is required.');
      if (!transactionId) throw new ValidationError('transactionId is required.');
      if (signers.length === 0) throw new ValidationError('At least one signer is required.');

      for (const s of signers) {
        if (!s.name?.trim()) throw new ValidationError('Each signer must have a name.');
        if (!s.email?.includes('@')) throw new ValidationError(`Signer "${s.name}" must have a valid email.`);
      }

      // Find the template in the registry.
      const template = TEMPLATE_REGISTRY.find((t) => t.type === templateType);
      if (!template) {
        throw new ValidationError(`Unknown template type: "${templateType}". Valid types: ${TEMPLATE_REGISTRY.map((t) => t.type).join(', ')}.`, 400);
      }

      const templateId = getTemplateId(template.envVar, template.fallbackId);
      if (!templateId) {
        // Template ID not configured yet — return a clear message.
        return res.status(422).json({
          ok: false,
          error: `Template "${template.label}" is not yet configured. Heath must create this template in DocuSeal and set ${template.envVar} in Vercel env vars.`,
          setupRequired: true,
        });
      }

      // Fetch transaction to pre-fill known fields.
      const tx = await fetchTransaction(transactionId, userId);
      if (!tx) {
        throw new ValidationError('Transaction not found or does not belong to you.', 404);
      }

      const prefillData = {
        property_address: tx.property_address || '',
        buyer_name: tx.buyer_name || '',
        seller_name: tx.seller_name || '',
        purchase_price: tx.sale_price ? String(tx.sale_price) : '',
        closing_date: tx.closing_date || '',
        option_expiration_date: tx.option_expiration_date || '',
        // 2026-07-13 Round 5 — financing columns for TREC 40-11.
        loan_amount: tx.loan_amount != null ? String(tx.loan_amount) : '',
        down_payment: tx.down_payment != null ? String(tx.down_payment) : '',
        financing_type: tx.financing_type || '',
        financing_days: tx.financing_days != null ? String(tx.financing_days) : '',
        // Extra fields from the form override defaults.
        ...extraPrefill,
      };

      // Create the DocuSeal submission.
      const submissionResult = await createTemplateSubmission({
        templateId,
        signers,
        prefillData,
        message,
      });

      const submissionId = String(submissionResult.id || '');
      const signerRows = (Array.isArray(submissionResult.submitters) ? submissionResult.submitters : []).map((sub, i) => ({
        name: sub.name || signers[i]?.name || '',
        email: sub.email || signers[i]?.email || '',
        role: sub.role || signers[i]?.role || 'Signer',
        status: sub.status || 'sent',
        signingUrl: sub.embed_src || null,
        uuid: sub.uuid || null,
      }));

      // Persist the signature request.
      const inserted = await insertSignatureRequest({
        user_id: userId,
        transaction_id: transactionId,
        document_id: documentId,   // may be null for template-generated docs
        docuseal_submission_id: submissionId,
        status: 'sent',
        signers: signerRows,
        message: message || null,
      });

      return res.status(200).json({
        ok: true,
        submissionId,
        signatureRequestId: inserted?.id || null,
        templateType,
        signers: signerRows,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.status || 401).json({ ok: false, error: error.message });
      }
      if (error instanceof ValidationError) {
        return res.status(error.status || 400).json({ ok: false, error: error.message });
      }
      if (error instanceof RateLimitError) {
        if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
        return res.status(429).json({ ok: false, error: 'Too many requests.' });
      }
      console.error('[esign-templates POST] error:', error && error.message);
      return res.status(500).json({ ok: false, error: 'Could not create template submission. Try again.' });
    }
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  res.status(405).json({ ok: false, error: 'Method not allowed.' });
};
