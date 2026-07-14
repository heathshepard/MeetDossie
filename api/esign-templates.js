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
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

// 2026-07-13 Round 11 — Dossie-branded signing email sender (Resend).
// DocuSeal's account-level "Send document copies to signers" toggle is OFF
// in the dashboard (per esign-create.js commentary lines 496-506), so setting
// send_email=true on the DocuSeal submission does NOT deliver an email.
// esign-create.js already sends its own Resend email; esign-templates.js now
// does the same so template-mode sends actually reach the signer.
async function sendSigningEmail({ signerName, signerEmail, documentName, propertyAddress, signingUrl }) {
  if (!RESEND_API_KEY) {
    console.warn('[esign-templates] RESEND_API_KEY not set — skipping signing email.');
    return;
  }
  if (!signingUrl) {
    console.warn(`[esign-templates] No signing URL for ${signerEmail} — skipping email.`);
    return;
  }
  const addressLine = propertyAddress ? ` for ${propertyAddress}` : '';
  const subject = `Action Required: Please sign ${documentName}${addressLine}`;
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="background:#F5E6E0;padding:24px 32px;text-align:center;">
          <span style="font-family:'Georgia',serif;font-size:22px;font-weight:bold;color:#1A1A2E;letter-spacing:0.5px;">Dossie</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Hi ${signerName},</p>
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Your agent has sent you a document to review and sign.</p>
          <p style="margin:0 0 8px;font-size:15px;color:#555;"><strong>Document:</strong> ${documentName}</p>
          ${propertyAddress ? `<p style="margin:0 0 24px;font-size:15px;color:#555;"><strong>Property:</strong> ${propertyAddress}</p>` : '<div style="margin-bottom:24px;"></div>'}
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
            <tr><td style="background:#E8836B;border-radius:6px;">
              <a href="${signingUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">Review &amp; Sign Document</a>
            </td></tr>
          </table>
          <p style="margin:0 0 24px;font-size:13px;color:#888;">If the button above doesn't work, copy and paste this link into your browser:<br><a href="${signingUrl}" style="color:#E8836B;word-break:break-all;">${signingUrl}</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:0 0 20px;">
          <p style="margin:0;font-size:13px;color:#aaa;">This document was prepared by Dossie, your agent's transaction management assistant.<br>Questions about this document? Contact your agent directly.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dossie <sign@meetdossie.com>',
      to: [signerEmail],
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(`[esign-templates] Resend error for ${signerEmail} (${r.status}): ${text.slice(0, 200)}`);
  } else {
    console.log(`[esign-templates] Signing email sent via Resend to ${signerEmail}`);
  }
}

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
    // 2026-07-13 Round 10 — TREC 49-1 Lender Appraisal. Template 4023472 uses
    // 4-role split (Buyer 1, Buyer 2, Seller 1, Seller 2). Fields are already
    // clean semantic names (property_address, waiver_checkbox,
    // partial_waiver_checkbox, opinion_of_value_amount, additional_right_checkbox,
    // additional_days, less_than_amount). Prefill fields extend CORE_PREFILL
    // with 49-1-specific keys the UI captures in the "49-1 details" block:
    // appraiser opinion of value, buyer's additional cure days, less-than
    // amount, and the three waiver checkboxes.
    //
    // NOTE — TEMPLATE DATA BUG in DocuSeal 4023472 submitter list: two
    // submitters both named "Seller 2" (should be "Seller 1" + "Seller 2").
    // Heath must fix in the DocuSeal dashboard for signature routing to
    // work for the second seller. Prefill and role mapping here work either
    // way because normalizeRoleForTemplate matches on "Seller 1"/"Seller 2".
    type: 'lender_appraisal',
    label: 'TREC 49-1 Lender Appraisal',
    description: 'Notice of Buyer\'s Termination Due to Lender\'s Appraisal',
    envVar: 'DOCUSEAL_TEMPLATE_LENDER_APPRAISAL',
    fallbackId: '4023472',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: [
      'property_address',
      'opinion_of_value_amount',
      'additional_days',
      'less_than_amount',
      'waiver_selection',
    ],
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
    // 2026-07-13 Round 7 — TREC 36-11 HOA Addendum. Template 4111321 uses
    // "Buyer 1 / Buyer 2 / Seller 1 / Seller 2" split (BUYER_SELLER_2).
    // Prefill extends CORE_PREFILL with HOA-specific semantic keys the mapper
    // in TEMPLATE_FIELD_MAPPERS['4111321'] translates to the template's
    // verbose AcroForm field names ("Street Address and City", "Name of
    // Property Owners Association Association and Phone Number", §D reserves
    // row, §E "Buyer" / "Seller shall pay ..." checkboxes).
    type: 'hoa_addendum',
    label: 'TREC 36-11 HOA Addendum',
    description: 'Addendum for Property Subject to Mandatory Membership in a POA',
    envVar: 'DOCUSEAL_TEMPLATE_HOA_ADDENDUM',
    fallbackId: '4111321',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: [
      'property_address',
      'buyer_name',
      'seller_name',
      'hoa_name',
      'hoa_transfer_fee',
      'hoa_annual_dues',
      'resale_certificate_delivery_deadline',
      'hoa_fee_payer',
      'resale_certificate_required',
    ],
  },
  {
    // 2026-07-13 Round 8 — OP-L Lead-Based Paint. Template 4023469 has SIX
    // submitters (Buyer 1, Buyer 2, Seller 1, Seller 2, Buyer Broker, Seller
    // Broker) — first canonical template with broker submitters. Semantic
    // keys map cleanly to the DocuSeal template's field names (property_address,
    // known_lead_paint, records_available, buyer_waives_inspection, etc.) via
    // TEMPLATE_FIELD_MAPPERS['4023469'].
    type: 'lead_paint_addendum',
    label: 'OP-L Lead-Based Paint',
    description: 'Addendum for Seller\'s Disclosure of Info on Lead-Based Paint',
    envVar: 'DOCUSEAL_TEMPLATE_LEAD_PAINT',
    fallbackId: '4023469',
    defaultSigners: [
      { role: 'Buyer 1',       label: 'Buyer 1' },
      { role: 'Buyer 2',       label: 'Buyer 2' },
      { role: 'Seller 1',      label: 'Seller 1' },
      { role: 'Seller 2',      label: 'Seller 2' },
      { role: 'Buyer Broker',  label: 'Buyer Broker' },
      { role: 'Seller Broker', label: 'Seller Broker' },
    ],
    prefillFields: [
      'property_address',
      'buyer_name',
      'seller_name',
      'lead_paint_disclosure_selected',
      'lead_paint_description',
      'records_available_selected',
      'records_description',
      'inspection_option_selected',
    ],
  },
  {
    // 2026-07-13 Round 9 — OP-H Seller's Disclosure. Template 4023470 uses
    // ONLY 2 submitter roles: "Seller" (fills the entire 175-field disclosure)
    // and "Buyer" (acknowledges receipt via signature + date only).
    // Per Heath's domain rules (dossie_domain_essentials memory): OP-H is
    // seller-owned in its entirety; buyer signs to acknowledge receipt.
    // Field names on the template are already clean semantic keys
    // (property_address, section2_yes/no/unknown checkboxes, etc.) so the
    // mapper in TEMPLATE_FIELD_MAPPERS['4023470'] focuses on address
    // multi-page duplication + safe passthrough of the many disclosure keys.
    type: 'sellers_disclosure',
    label: 'OP-H Seller\'s Disclosure',
    description: 'Seller\'s Disclosure Notice',
    envVar: 'DOCUSEAL_TEMPLATE_SELLERS_DISCLOSURE',
    fallbackId: '4023470',
    defaultSigners: BUYER_SELLER_1,
    prefillFields: [
      'property_address',
      'years_since_occupied',
      'seller_is_occupying',
      'seller_not_occupying',
    ],
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
  {
    // 2026-07-14 Atlas — IABS Buyer/Tenant (template 4985883). Roles are
    // "Buyer Broker" (16 broker/agent fields) + "Buyer 1" (client_initials +
    // acknowledgment_date). Prefill of the 11 broker/agent fields is sourced
    // from profiles.iabs_defaults_completed via buildIabsPrefill() in the
    // POST handler below — progressive profiling means first-time senders
    // fill from the send modal, subsequent sends auto-prefill.
    type: 'iabs_buyer_tenant',
    label: 'IABS (Buyer/Tenant)',
    description: 'Information About Brokerage Services — Buyer/Tenant',
    envVar: 'DOCUSEAL_TEMPLATE_IABS_BUYER',
    fallbackId: '4985883',
    defaultSigners: [
      { role: 'Buyer Broker', label: 'Buyer Broker' },
      { role: 'Buyer 1',      label: 'Buyer 1' },
    ],
    prefillFields: [
      'sponsoring_broker_name',
      'sponsoring_broker_license_no',
      'sponsoring_broker_email',
      'sponsoring_broker_phone',
      'supervisor_name',
      'supervisor_license_no',
      'supervisor_phone',
      'sales_agent_name',
      'sales_agent_license_no',
      'sales_agent_email',
      'sales_agent_phone',
    ],
  },
  {
    // 2026-07-14 Atlas — IABS Seller/Landlord (template 4984666). Same 16
    // broker-side fields; consumer roles are "Seller Broker" + "Seller 1".
    type: 'iabs_seller_landlord',
    label: 'IABS (Seller/Landlord)',
    description: 'Information About Brokerage Services — Seller/Landlord',
    envVar: 'DOCUSEAL_TEMPLATE_IABS_SELLER',
    fallbackId: '4984666',
    defaultSigners: [
      { role: 'Seller Broker', label: 'Seller Broker' },
      { role: 'Seller 1',      label: 'Seller 1' },
    ],
    prefillFields: [
      'sponsoring_broker_name',
      'sponsoring_broker_license_no',
      'sponsoring_broker_email',
      'sponsoring_broker_phone',
      'supervisor_name',
      'supervisor_license_no',
      'supervisor_phone',
      'sales_agent_name',
      'sales_agent_license_no',
      'sales_agent_email',
      'sales_agent_phone',
    ],
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

// 2026-07-14 Atlas — IABS progressive-profiling helpers. Column names match
// api/_migrations/0025-iabs-defaults.sql exactly (supervising_broker_license,
// no _number suffix — a Carter-draft mismatch would silently drop supervisor
// fields, so the SELECT list is the enforcement point).
async function fetchIabsDefaults(userId) {
  if (!userId) return null;
  const res = await supa(
    `profiles?id=eq.${encodeURIComponent(userId)}&select=broker_name,broker_license_number,broker_phone,broker_email,supervising_broker_name,supervising_broker_license,supervising_broker_phone,full_name,agent_license_number,agent_phone,email,iabs_defaults_completed&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function buildIabsPrefill(iabsDefaults) {
  if (!iabsDefaults || !iabsDefaults.iabs_defaults_completed) return {};
  const prefill = {};
  // Sponsoring broker (the agent's broker firm)
  if (iabsDefaults.broker_name)           prefill.sponsoring_broker_name       = iabsDefaults.broker_name;
  if (iabsDefaults.broker_license_number) prefill.sponsoring_broker_license_no = iabsDefaults.broker_license_number;
  if (iabsDefaults.broker_email)          prefill.sponsoring_broker_email      = iabsDefaults.broker_email;
  if (iabsDefaults.broker_phone)          prefill.sponsoring_broker_phone      = iabsDefaults.broker_phone;
  // Supervisor (supervising broker, optional per TREC)
  if (iabsDefaults.supervising_broker_name)    prefill.supervisor_name       = iabsDefaults.supervising_broker_name;
  if (iabsDefaults.supervising_broker_license) prefill.supervisor_license_no = iabsDefaults.supervising_broker_license;
  if (iabsDefaults.supervising_broker_phone)   prefill.supervisor_phone      = iabsDefaults.supervising_broker_phone;
  // Sales agent (the agent themselves)
  if (iabsDefaults.full_name)            prefill.sales_agent_name       = iabsDefaults.full_name;
  if (iabsDefaults.agent_license_number) prefill.sales_agent_license_no = iabsDefaults.agent_license_number;
  if (iabsDefaults.email)                prefill.sales_agent_email      = iabsDefaults.email;
  if (iabsDefaults.agent_phone)          prefill.sales_agent_phone      = iabsDefaults.agent_phone;
  return prefill;
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
  // Template 4952172 (TREC 20-19): DocuSeal template only has a SINGLE
  // submitter role called "First Party" (verified via GET /templates/4952172
  // 2026-07-13). Prior config listed 4 roles which caused every incoming
  // signer (Buyer 1 / Buyer 2 / Seller 1 / Seller 2) to fall through
  // normalizeRoleForTemplate's "not found in list" path — DocuSeal accepted
  // the strings but ignored them and rendered a single "First Party" submitter
  // regardless. Real fix requires the template to be split into 4 roles in
  // DocuSeal Studio; in the meantime we normalize everything to "First Party"
  // so the customer at least receives a signable envelope.
  '4952172': ['First Party'],
  // Template 4023463 (TREC 40-11): 2-role
  '4023463': ['Buyer', 'Seller'],
  // Template 4111320 (TREC 39-11 Amendment): 4-role split (Round 6)
  '4111320': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4111321 (TREC 36-11 HOA Addendum): 4-role split (Round 7)
  '4111321': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4023469 (OP-L Lead-Based Paint): 6-role split — brokers included (Round 8)
  '4023469': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2', 'Buyer Broker', 'Seller Broker'],
  // Template 4023470 (OP-H Sellers Disclosure): 2-role split (Round 9)
  // Seller fills the entire 175-field disclosure; Buyer only acknowledges
  // receipt via signature + date. Domain rule: OP-H is seller-owned.
  '4023470': ['Seller', 'Buyer'],
  // Template 4023472 (TREC 49-1 Lender Appraisal): 4-role split (Round 10)
  // NOTE: current DocuSeal template has a data bug — two "Seller 2" submitters.
  // The mapping below is what SHOULD be there so field routing is correct.
  // Signature routing for the duplicate needs Heath to fix in DocuSeal UI.
  '4023472': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // 2026-07-14 — Phase A extend to 8 remaining canonical forms.
  // Template 4111328 (TREC 61-0 Groundwater): 4-role, verified via verify JSON.
  '4111328': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4023578 (TREC 11-8 Backup Contract): 4-role.
  '4023578': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4111323 (TREC 11-9 Backup Contract v2): 4-role.
  '4111323': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4023573 (TREC 26 Seller Financing): 4-role.
  '4023573': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4111325 (TREC 25-17 Farm & Ranch): 4-role.
  '4111325': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4111324 (TREC 30-18 Condominium): 4-role.
  '4111324': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4111326 (TREC 23-20 New Home Incomplete): 4-role per verify JSON.
  // Template has data issues (only 9 unnamed checkboxes) but roles are correct.
  '4111326': ['Buyer 1', 'Buyer 2', 'Seller 1', 'Seller 2'],
  // Template 4111327 (TREC 24-20 New Home Complete): only "First Party" per
  // verify JSON. Template data broken — zero fields, single submitter. This
  // matches the 20-19 workaround pattern where all incoming roles collapse
  // to the sole available submitter so the customer at least receives an envelope.
  '4111327': ['First Party'],
  // 2026-07-14 Atlas — IABS templates: 2-role, broker + one consumer signer.
  // Template 4985883 (IABS Buyer/Tenant): "Buyer Broker" owns 16 broker/agent
  // fields, "Buyer 1" owns 2 acknowledgment fields.
  '4985883': ['Buyer Broker', 'Buyer 1'],
  // Template 4984666 (IABS Seller/Landlord): "Seller Broker" + "Seller 1".
  '4984666': ['Seller Broker', 'Seller 1'],
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

  // 2026-07-13 Round 11 — When the template has a SINGLE role, always route
  // there (e.g. template 4952172 only has "First Party"). Avoids passing a
  // role DocuSeal will reject or silently accept while rendering as fallback.
  if (rolesForTemplate.length === 1) return rolesForTemplate[0];

  // Exact match on the template's role list.
  const exact = rolesForTemplate.find((r) => r.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact;

  // Broker role handling (Round 8 — OP-L Lead-Based Paint has Buyer Broker +
  // Seller Broker). Match "Buyer Broker" / "Seller Broker" / "Buyer Agent" /
  // "Seller Agent" / "Buyer's Agent" etc. BEFORE the plain Buyer/Seller
  // check, so "Buyer Broker" doesn't collapse to "Buyer 1".
  const isBrokerish = /(broker|agent)/i.test(trimmed);
  if (isBrokerish) {
    const isBuyerSide = /buyer/i.test(trimmed);
    const isSellerSide = /seller/i.test(trimmed);
    if (isBuyerSide) {
      const found = rolesForTemplate.find((r) => /buyer.*broker|buyer.*agent/i.test(r));
      if (found) return found;
    }
    if (isSellerSide) {
      const found = rolesForTemplate.find((r) => /seller.*broker|seller.*agent/i.test(r));
      if (found) return found;
    }
    // Generic broker with no side — pass through.
    return trimmed;
  }

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
    // Prefer the numbered signer roles over broker slots when only "Buyer" was given.
    return rolesForTemplate.find((r) => /^buyer(\s*\d+)?$/i.test(r)) || trimmed;
  }
  if (isSeller) {
    const digit = trimmed.match(/(\d+)/);
    if (digit) {
      const withDigit = `Seller ${digit[1]}`;
      const found = rolesForTemplate.find((r) => r.toLowerCase() === withDigit.toLowerCase());
      if (found) return found;
    }
    return rolesForTemplate.find((r) => /^seller(\s*\d+)?$/i.test(r)) || trimmed;
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
  // TREC 20-19 (resale contract) — template 4952172.
  //
  // 2026-07-13 CRITICAL FIX (Round 11) — actually populate the real DocuSeal
  // field names on this template. Prior versions produced semantic keys
  // (buyer_name, seller_name, property_address_page4) that DocuSeal DROPPED
  // because the template's field names are the PDF-label-derived strings
  // (verified via GET /templates/4952172).
  //
  // Actual template field-name inventory (via docuseal-15-verify):
  //   Page 0:
  //     [0]  text "1 PARTIES The parties to this contract are" → Buyer name
  //     [1]  text "Seller and"                                 → Seller name
  //     [7]  text "Texas known as"                             → property street
  //   Page 8 (Broker/Address block):
  //     [144] text "Address of Property"                       → property_address
  //   Page 9 (initialed-by block):
  //     [191] text "Addr of Prop"                              → property_address
  //     [199] text (blank, desc "Address of Property")         → property_address
  //     [241] text (blank, desc "Address of Property")         → property_address
  //   Page 5:
  //     [92] text "A The closing of the sale will be on or before" → closing_date
  //   Sales price + earnest money slots: mostly blank-named fields we route via
  //   description or via the clone-time index escape hatch.
  //
  // The clone-with-defaults helper (docusealCloneTemplateWithDefaults) matches
  // by name OR description OR normalized-name-key OR `__field_<idx>` — so we
  // emit whichever key form the template exposes.
  '4952172': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address': {
          // Multi-slot: property description at top of page 0 + property header
          // repeats on pages 8, 9, 10, 11.
          expanded['1 PARTIES The parties to this contract are'] = s; // (fallback if inherit)
          expanded['Texas known as'] = s; // property description line (page 0)
          expanded['Address of Property'] = s; // page 8 top
          expanded['Addr of Prop'] = s; // page 9 top
          // Semantic key still exposed for compat.
          expanded['property_address'] = s;
          break;
        }
        case 'seller_name': {
          expanded['Seller and'] = s;
          expanded['seller_name'] = s;
          break;
        }
        case 'buyer_name': {
          // The Buyer 1 name lives in field 0 whose NAME is "1 PARTIES The
          // parties to this contract are" and description is "1. PARTIES: ...".
          // But that same name-string is used for two logical things by the
          // template — the underline before "(Buyer) and" catches the buyer
          // name; the seller name goes to the "Seller and" field. Keep them
          // separate.
          expanded['1 PARTIES The parties to this contract are'] = s;
          expanded['buyer_name'] = s;
          break;
        }
        case 'purchase_price':
        case 'sale_price': {
          // The template has ~35 blank-named "Sales Price" slots. Without
          // hitting each by index/uuid we can't populate them all here.
          // At minimum, populate:
          //   - "Sales Price" description (blank name, desc containing "Sales Price")
          //   - The first blank field on page 0 y~0.646 (§3B Sum of Financing) via index escape hatch
          //   - Any field with "Sales Price" in its name (there's one checkbox
          //     label "will not be credited to the Sales Price at closing...")
          expanded['sale_price'] = s;
          expanded['purchase_price'] = s;
          // Index-based escape hatch for §3A cash portion (page 0 y~0.584 = field 10).
          expanded['__field_10'] = s;
          break;
        }
        case 'closing_date': {
          expanded['A The closing of the sale will be on or before'] = s;
          expanded['closing_date'] = s;
          break;
        }
        default: {
          expanded[key] = s;
          break;
        }
      }
    }
    return expanded;
  },

  // TREC 39-11 Amendment (template 4111320)
  // Field names sourced from .tmp/docuseal-15-verify/tmpl_4111320.json.
  //
  // 2026-07-14 party-routing rebalance (Atlas):
  //   Template PATCHed via PUT /templates/4111320 { fields:[...] } to move §2
  //   (repairs/treatments) + §5 (lender-required repairs cost) from Buyer 1 to
  //   Seller 1. Distribution: Buyer 1 48→39, Seller 1 1→10, Buyer 2/Seller 2
  //   unchanged (1 signature each). Mapper output is unchanged — it still
  //   emits values keyed by field NAME; DocuSeal handles submitter routing
  //   from the template config. Backup of pre-patch template lives at
  //   .tmp/party-routing-fix/tmpl_4111320.json (do not delete).
  //
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

  // TREC 36-11 HOA Addendum (template 4111321)
  // Field names sourced from .tmp/docuseal-15-verify/tmpl_4111321.json.
  //
  // 2026-07-14 party-routing rebalance (Atlas):
  //   Template PATCHed via PUT /templates/4111321 { fields:[...] } so HOA info
  //   is Seller-provided (per dossie_domain_essentials memory: seller supplies
  //   HOA name/phone, §A1 delivery timeframe, §D reserves deposit). Buyer 1
  //   keeps property header + §A2/A3/A4/E buyer-side checkboxes. Distribution:
  //   Buyer 1 14→10, Seller 1 1→5, Buyer 2/Seller 2 unchanged. Mapper output
  //   unchanged — values still keyed by field NAME; DocuSeal routes to the
  //   correct submitter based on template config. Backup at
  //   .tmp/party-routing-fix/tmpl_4111321.json (do not delete).
  //
  // The 36-11 is a single-page addendum. Fields have hostile, label-like
  // names ("Street Address and City", "Name of Property Owners Association
  // Association and Phone Number", "does", "does not require an updated
  // resale certificate...") — so semantic prefill keys MUST be translated
  // explicitly. Round 7 wires the mapping so property_address, buyer_name,
  // seller_name AND HOA-specific keys reach the correct AcroForm slots.
  //
  // Field inventory (from tmpl_4111321.json):
  //   0  "Street Address and City" — text (§property header)
  //   1  "Name of Property Owners Association Association and Phone Number" — text
  //   2  "1 Within" — checkbox (§A1 timeframe checkbox)
  //   3  "the Subdivision Information to the Buyer If Seller delivers the Subdivision Information Buyer may terminate" — text (§A1 days)
  //   4  "undefined" — checkbox (§A2 checkbox)
  //   5  "copy of the Subdivision Information to the Seller" — text (§A2 days)
  //   6  "3Buyer has received and approved the Subdivision Information before signing the contract Buyer" — checkbox (§A3)
  //   7  "does" — checkbox
  //   8  "does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at" — checkbox
  //   9  "4Buyer does not require delivery of the Subdivision Information" — checkbox (§A4)
  //   10 "D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required at closing by the Association" — text (§D reserves)
  //   11 "Buyer" — checkbox (§E — Buyer pays HOA fee)
  //   12 "Seller shall pay the Title Company the cost of obtaining the" — checkbox (§E — Seller pays HOA fee)
  //   13-16 signature fields (buyer_1_name, buyer_2_name, Seller_1_name, Seller_2_name)
  //
  // Semantic keys we accept: property_address, hoa_name, resale_certificate_delivery_deadline,
  // subdivision_info_delivery_days, hoa_transfer_fee, hoa_annual_dues, hoa_fee_payer
  // ('buyer' | 'seller'), resale_certificate_required ('true' | 'false').
  '4111321': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address': {
          // The 36-11 property field is literally "Street Address and City".
          expanded['Street Address and City'] = s;
          expanded['property_address'] = s;
          break;
        }
        case 'hoa_name':
        case 'hoa_name_and_phone':
        case 'association_name': {
          // Text field name is verbose (dedup "Association Association") but
          // matches tmpl JSON exactly.
          expanded['Name of Property Owners Association Association and Phone Number'] = s;
          expanded['hoa_name'] = s;
          break;
        }
        case 'resale_certificate_delivery_deadline':
        case 'subdivision_info_delivery_days': {
          // §A1 "Within ___ days after the effective date, Seller shall deliver..."
          // The days text slot has the awkward name reflecting the sentence
          // label. Numeric string ("10", "30", etc.).
          const clean = String(s).replace(/[^\d.]/g, '');
          expanded['the Subdivision Information to the Buyer If Seller delivers the Subdivision Information Buyer may terminate'] = clean;
          expanded['1 Within'] = 'true';       // toggle the §A1 checkbox
          expanded['resale_certificate_delivery_deadline'] = clean;
          break;
        }
        case 'hoa_transfer_fee':
        case 'hoa_reserves': {
          // §D "Buyer shall pay any deposits for reserves ..." — the field
          // name IS the label of the row (a familiar TREC trap).
          expanded['D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required at closing by the Association'] = s;
          expanded['hoa_transfer_fee'] = s;
          break;
        }
        case 'hoa_annual_dues': {
          // No dedicated annual-dues field on 36-11 (dues live in the resale
          // cert itself). Pass through for future extension.
          expanded['hoa_annual_dues'] = s;
          break;
        }
        case 'hoa_fee_payer': {
          // §E — who pays the resale-certificate cost. Toggle exactly one
          // checkbox based on the input string ('buyer' | 'seller').
          const payer = String(s).toLowerCase();
          if (payer.includes('buyer')) expanded['Buyer'] = 'true';
          if (payer.includes('seller')) expanded['Seller shall pay the Title Company the cost of obtaining the'] = 'true';
          expanded['hoa_fee_payer'] = s;
          break;
        }
        case 'resale_certificate_required': {
          // §A3 — "does require" / "does not require". Toggle by boolean.
          const truthy = /^(true|yes|1|require)/i.test(String(s));
          if (truthy) expanded['does'] = 'true';
          else expanded['does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at'] = 'true';
          expanded['resale_certificate_required'] = s;
          break;
        }
        // Canonical keys that don't have obvious 36-11 targets pass through so
        // any future field rename in DocuSeal automatically picks them up.
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

  // OP-L Lead-Based Paint Addendum (template 4023469)
  // Field names sourced from .tmp/docuseal-15-verify/tmpl_4023469.json.
  // This template has EXACTLY the semantic key names Dossie already uses
  // ("property_address"), so the field mapper is mostly a pass-through — its
  // primary job is (a) documenting the semantic keys the UI can pass and
  // (b) handling the checkbox trio (seller knowledge, records available,
  // buyer inspection option).
  //
  // Field inventory (from tmpl_4023469.json):
  //   0  property_address — text (page 1 header)
  //   1  known_lead_paint — checkbox (§A(a) seller has knowledge)
  //   2  known_lead_paint_description — text (§A(a) description)
  //   3  no_knowledge_lead_paint — checkbox (§A(b) no knowledge)
  //   4  records_available — checkbox (§B(a) records provided)
  //   5  records_description — text (§B(a) records list)
  //   6  no_records — checkbox (§B(b) no records)
  //   7  buyer_waives_inspection — checkbox (§C(a))
  //   8  buyer_reserves_inspection — checkbox (§C(b))
  //   9  buyer_received_copies — checkbox (§D)
  //   10 buyer_received_pamphlet — checkbox (§E)
  //   11-22 signatures + dates for 6 submitters
  //
  // Semantic keys Dossie can pass: property_address, lead_paint_disclosure_selected
  // ('known' | 'no_knowledge'), lead_paint_description, records_available_selected
  // ('yes' | 'no'), records_description, inspection_option_selected
  // ('waives' | 'reserves'), inspection_option_days.
  '4023469': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          // Direct name match on this template.
          expanded['property_address'] = s;
          break;
        case 'lead_paint_description':
        case 'known_lead_paint_description':
          expanded['known_lead_paint_description'] = s;
          expanded['known_lead_paint'] = 'true';  // implies the "knowledge" checkbox
          break;
        case 'records_description':
          expanded['records_description'] = s;
          expanded['records_available'] = 'true'; // implies §B(a) checkbox
          break;
        case 'lead_paint_disclosure_selected': {
          // 'known' → toggle §A(a); 'no_knowledge' → toggle §A(b).
          const v = String(s).toLowerCase();
          if (v.includes('known') && !v.includes('no')) expanded['known_lead_paint'] = 'true';
          if (v.includes('no') || v.includes('none')) expanded['no_knowledge_lead_paint'] = 'true';
          expanded['lead_paint_disclosure_selected'] = s;
          break;
        }
        case 'records_available_selected': {
          const truthy = /^(yes|true|available|1)/i.test(String(s));
          if (truthy) expanded['records_available'] = 'true';
          else expanded['no_records'] = 'true';
          expanded['records_available_selected'] = s;
          break;
        }
        case 'inspection_option_selected': {
          const v = String(s).toLowerCase();
          if (v.includes('waive') || v.includes('waves')) expanded['buyer_waives_inspection'] = 'true';
          if (v.includes('reserve')) expanded['buyer_reserves_inspection'] = 'true';
          expanded['inspection_option_selected'] = s;
          break;
        }
        case 'buyer_received_copies_selected': {
          if (/true|yes|1/i.test(String(s))) expanded['buyer_received_copies'] = 'true';
          expanded['buyer_received_copies_selected'] = s;
          break;
        }
        case 'buyer_received_pamphlet_selected': {
          if (/true|yes|1/i.test(String(s))) expanded['buyer_received_pamphlet'] = 'true';
          expanded['buyer_received_pamphlet_selected'] = s;
          break;
        }
        // Direct-match checkboxes / passthrough for future extension.
        case 'known_lead_paint':
        case 'no_knowledge_lead_paint':
        case 'records_available':
        case 'no_records':
        case 'buyer_waives_inspection':
        case 'buyer_reserves_inspection':
        case 'buyer_received_copies':
        case 'buyer_received_pamphlet':
          expanded[key] = String(s);
          break;
        // Canonical keys pass through — DocuSeal drops unmatched keys safely.
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

  // OP-H Sellers Disclosure Notice (template 4023470)
  // Field names sourced from .tmp/docuseal-15-verify/tmpl_4023470.json.
  // The 4023470 template has 179 fields, 175 owned by "Seller" submitter
  // + 4 owned by "Buyer" (signature + date acknowledgment only). Field names
  // are already clean semantic keys — the mapper's main job is:
  //   (a) duplicate property_address to property_address_p2 (page 2 header)
  //   (b) safely pass through all disclosure keys the seller may fill via UI
  //   (c) route the mutually-exclusive checkbox trios (yes/no/unknown)
  //       when Dossie captures a single semantic selector value.
  //
  // Semantic keys Dossie can pass:
  //   property_address, years_since_occupied
  //   occupancy_status ('is_occupying' | 'not_occupying')
  //   aware_of_defects ('yes' | 'no' | 'unknown')
  //   section2_status ('yes' | 'no' | 'unknown')
  //   item{7..11}_answer ('yes' | 'no')
  //   condition_answer ('yes' | 'no')
  //   insurance_answer ('yes' | 'no')
  //   plus any of the 143 direct field names (range, oven, microwave, etc.).
  '4023470': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address': {
          // OP-H has property_address on page 1 header + property_address_p2
          // on page 2 header. Both get the same value.
          expanded['property_address'] = s;
          expanded['property_address_p2'] = s;
          break;
        }
        case 'occupancy_status': {
          const v = String(s).toLowerCase();
          if (v.includes('is_occupying') || v === 'occupied' || v === 'yes') {
            expanded['seller_is_occupying'] = 'true';
          } else if (v.includes('not_occupying') || v === 'vacant' || v === 'no') {
            expanded['seller_not_occupying'] = 'true';
          }
          expanded['occupancy_status'] = s;
          break;
        }
        case 'aware_of_defects': {
          const v = String(s).toLowerCase();
          if (v.includes('unknown')) expanded['aware_defects_unknown'] = 'true';
          else if (v.includes('yes') || v === 'true') expanded['aware_defects_yes'] = 'true';
          else if (v.includes('no') || v === 'false') expanded['aware_defects_no'] = 'true';
          expanded['aware_of_defects'] = s;
          break;
        }
        case 'section2_status': {
          const v = String(s).toLowerCase();
          if (v.includes('unknown')) expanded['section2_unknown'] = 'true';
          else if (v.includes('yes') || v === 'true') expanded['section2_yes'] = 'true';
          else if (v.includes('no') || v === 'false') expanded['section2_no'] = 'true';
          expanded['section2_status'] = s;
          break;
        }
        case 'item7_answer':
        case 'item8_answer':
        case 'item9_answer':
        case 'item10_answer':
        case 'item11_answer': {
          const n = key.match(/item(\d+)/)[1];
          const v = String(s).toLowerCase();
          if (v.includes('yes') || v === 'true') expanded[`item${n}_yes`] = 'true';
          else if (v.includes('no') || v === 'false') expanded[`item${n}_no`] = 'true';
          expanded[key] = s;
          break;
        }
        case 'condition_answer': {
          const v = String(s).toLowerCase();
          if (v.includes('yes') || v === 'true') expanded['condition_yes'] = 'true';
          else if (v.includes('no') || v === 'false') expanded['condition_no'] = 'true';
          expanded['condition_answer'] = s;
          break;
        }
        case 'insurance_answer': {
          const v = String(s).toLowerCase();
          if (v.includes('yes') || v === 'true') expanded['insurance_yes'] = 'true';
          else if (v.includes('no') || v === 'false') expanded['insurance_no'] = 'true';
          expanded['insurance_answer'] = s;
          break;
        }
        // Canonical CORE_PREFILL keys that DO NOT have fields on OP-H (buyer/
        // seller names + purchase price + closing date are not on the seller's
        // disclosure). Drop them silently to avoid polluting the clone.
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
          break;
        default:
          // Pass through all other keys (range, oven, dishwasher, defect_desc_1,
          // section2_desc_1, etc.). DocuSeal drops unmatched keys safely.
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 49-1 Lender Appraisal Notice (template 4023472)
  // Field names sourced from .tmp/docuseal-15-verify/tmpl_4023472.json.
  // The 4023472 template has 15 fields — clean semantic names
  // (property_address, waiver_checkbox, partial_waiver_checkbox,
  // opinion_of_value_amount, additional_right_checkbox, additional_days,
  // less_than_amount + signature/date fields for 4 submitters).
  //
  // Semantic keys Dossie can pass:
  //   property_address
  //   opinion_of_value_amount (appraiser's opinion of value dollar amount)
  //   waiver_selection ('waives_all' | 'waives_partial' | 'reserves_all')
  //     — mutually-exclusive checkbox trio; sets waiver_checkbox OR
  //       partial_waiver_checkbox (reserves_all leaves both blank).
  //   additional_days (buyer's cure period in days after opinion of value)
  //   less_than_amount (dollar amount below which buyer may terminate)
  //   additional_right_checkbox (boolean — buyer reserves the additional right)
  '4023472': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address'] = s;
          break;
        case 'opinion_of_value_amount': {
          const clean = String(s).replace(/[^\d.-]/g, '');
          expanded['opinion_of_value_amount'] = clean;
          break;
        }
        case 'less_than_amount': {
          const clean = String(s).replace(/[^\d.-]/g, '');
          expanded['less_than_amount'] = clean;
          break;
        }
        case 'additional_days': {
          const clean = String(s).replace(/[^\d.]/g, '');
          expanded['additional_days'] = clean;
          break;
        }
        case 'waiver_selection': {
          const v = String(s).toLowerCase();
          if (v.includes('waives_all') || v === 'all' || v === 'waive_all') {
            expanded['waiver_checkbox'] = 'true';
          } else if (v.includes('partial') || v.includes('waives_partial')) {
            expanded['partial_waiver_checkbox'] = 'true';
          }
          // 'reserves_all' leaves both checkboxes blank (buyer keeps all rights).
          expanded['waiver_selection'] = s;
          break;
        }
        case 'additional_right_checkbox':
        case 'reserves_additional_right': {
          if (/true|yes|1|reserves/i.test(String(s))) {
            expanded['additional_right_checkbox'] = 'true';
          }
          expanded['additional_right_checkbox'] = String(s).match(/^(true|false)$/) ? s : (expanded['additional_right_checkbox'] || s);
          break;
        }
        // Direct-match checkboxes / passthrough.
        case 'waiver_checkbox':
        case 'partial_waiver_checkbox':
          expanded[key] = String(s);
          break;
        // Canonical CORE_PREFILL keys with no field on 49-1 — drop silently.
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
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

  // TREC 61-0 Groundwater Notice (template 4111328)
  // 2026-07-14 — Field inventory from .tmp/docuseal-15-verify/tmpl_4111328.json:
  //   0 signature "Buyer Signature" | 1 date "Buyer Date"
  //   2 signature "Seller Signature" | 3 date "Seller Date"
  //   ... 8 text "property_address"
  //   ... 29 text "property_address_p2"
  //   Plus radios (in_groundwater_district), checkboxes (wells), text (well_description).
  // Semantic keys pass through, address duplicates to page-2 header.
  '4111328': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address'] = s;
          expanded['property_address_p2'] = s;
          break;
        // Drop CORE_PREFILL keys with no fields (buyer_name/seller_name/etc).
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 11-8 Backup Contract (template 4023578)
  // 2026-07-14 — Field inventory from .tmp/docuseal-15-verify/tmpl_4023578.json:
  //   4 text "property_address"
  //   16 text "property_address_page2"
  //   Plus additional_earnest_money_amount, additional_option_fee_amount, dates.
  '4023578': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address'] = s;
          expanded['property_address_page2'] = s;
          break;
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 11-9 Backup Contract v2 (template 4111323)
  // 2026-07-14 — Field inventory from .tmp/docuseal-15-verify/tmpl_4111323.json:
  //   4 text "property_address"
  //   16 text "property_address_page_2"  (note underscore-page-2)
  //   Plus additional_earnest_money, additional_option_fee, dates.
  '4111323': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address'] = s;
          expanded['property_address_page_2'] = s;
          break;
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 26 Seller Financing Addendum (template 4023573)
  // 2026-07-14 — Field inventory from .tmp/docuseal-15-verify/tmpl_4023573.json:
  //   4 text "property_address" (single instance — page 1 only)
  //   Plus 43 note-terms fields (credit_documentation_days, note_amount, note_interest_rate, etc.).
  '4023573': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address'] = s;
          break;
        case 'buyer_name':
        case 'seller_name':
        case 'purchase_price':
        case 'sale_price':
        case 'closing_date':
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 25-17 Farm & Ranch Contract (template 4111325)
  // 2026-07-14 — Field inventory from .tmp/docuseal-15-verify/tmpl_4111325.json (326 fields):
  //   4 text "seller_name"
  //   5 text "buyer_name"
  //   6 text "county"
  //   7 text "legal_description"
  //   8 text "property_address"
  //   Plus 300+ farm-and-ranch domain fields (accessories, financing, oil/gas rights, etc.).
  '4111325': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address'] = s;
          break;
        case 'buyer_name':
          expanded['buyer_name'] = s;
          break;
        case 'seller_name':
          expanded['seller_name'] = s;
          break;
        case 'purchase_price':
        case 'sale_price':
          expanded['sales_price_total'] = String(s).replace(/[^\d.-]/g, '');
          expanded['sale_price'] = s;
          break;
        case 'closing_date':
          expanded['closing_date'] = s;
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 30-18 Condominium Contract (template 4111324)
  // 2026-07-14 — Field inventory from .tmp/docuseal-15-verify/tmpl_4111324.json (228 fields):
  //   4 text "seller_name"
  //   5 text "buyer_name"
  //   9 text "property_address"
  //   26 text "header_property_address_p2"
  //   Plus condo domain fields (unit_number, condo_project_name, parking_areas, etc.).
  '4111324': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      const s = typeof value === 'string' ? value : String(value);
      switch (key) {
        case 'property_address':
          expanded['property_address'] = s;
          expanded['header_property_address_p2'] = s;
          break;
        case 'buyer_name':
          expanded['buyer_name'] = s;
          break;
        case 'seller_name':
          expanded['seller_name'] = s;
          break;
        case 'purchase_price':
        case 'sale_price':
          expanded['sale_price'] = s;
          break;
        case 'closing_date':
          expanded['closing_date'] = s;
          break;
        default:
          expanded[key] = s;
          break;
      }
    }
    return expanded;
  },

  // TREC 23-20 New Home Incomplete (template 4111326)
  // 2026-07-14 — Template has ONLY 9 unnamed checkbox fields — no text fields
  // for property_address/buyer_name/etc. This is a DocuSeal template data
  // problem — the source PDF's AcroForm text widgets were not preserved when
  // the template was created. Fallback: pass through everything so if Heath
  // later fixes the template, prefill starts flowing without a code change.
  // Test expectation: PASS the send + email + signer link, but expect BLANK
  // filled PDF at signer view (documented gap).
  '4111326': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      expanded[key] = typeof value === 'string' ? value : String(value);
    }
    return expanded;
  },

  // TREC 24-20 New Home Complete (template 4111327)
  // 2026-07-14 — Template has ZERO fields AND only 1 "First Party" submitter.
  // Same template data problem as 23-20 but worse: no signature widgets means
  // the signer view will have nothing to sign either. Fallback: pass through.
  // Test expectation: send + email + link may succeed (First Party submitter
  // exists), but signer view will be a blank PDF with no fields.
  '4111327': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      expanded[key] = typeof value === 'string' ? value : String(value);
    }
    return expanded;
  },
  // 2026-07-14 Atlas — IABS Buyer/Tenant (4985883). Fable5 named the fields
  // with clean semantic keys (sponsoring_broker_name, sales_agent_email, etc.)
  // matching what buildIabsPrefill() emits — so a passthrough mapper is
  // sufficient. designated_broker_* fields are left blank (rare + broker-
  // dependent). client_initials / acknowledgment_date are signer-filled.
  '4985883': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      expanded[key] = typeof value === 'string' ? value : String(value);
    }
    return expanded;
  },
  // IABS Seller/Landlord (4984666). Same field-name shape as Buyer/Tenant.
  '4984666': (prefillData) => {
    const expanded = {};
    for (const [key, value] of Object.entries(prefillData)) {
      if (value === null || value === undefined || value === '') continue;
      expanded[key] = typeof value === 'string' ? value : String(value);
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
//
// 2026-07-13 — MATCH-BY-DESCRIPTION extension. Many DocuSeal templates
// (notably 4952172) have fields with EMPTY names but populated descriptions
// ("Address of Property", etc.). The prior lookup only matched f.name and
// silently dropped defaults for blank-named fields. This iteration also
// matches on f.description and on a lowercased/whitespace-stripped variant
// of both — the mapper can now route to descriptive labels regardless of
// which slot DocuSeal happens to populate.
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

  // Build a lowercase/normalized index of the defaults keys so we can match
  // fields by name-or-description-or-normalized-form.
  const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normDefaults = {};
  for (const [k, v] of Object.entries(defaults || {})) {
    normDefaults[normKey(k)] = v;
    normDefaults[k] = v; // also keep original for direct match
  }

  const existingFields = Array.isArray(cloneData.fields) ? cloneData.fields : [];
  const patchedFields = existingFields.map((f, idx) => {
    // Try direct name match first (exact case-sensitive, prior behavior).
    let val = (defaults[f.name] != null && defaults[f.name] !== '') ? defaults[f.name] : null;

    // Fall back to description exact match.
    if (val == null && f.description != null && defaults[f.description] != null && defaults[f.description] !== '') {
      val = defaults[f.description];
    }

    // Fall back to normalized name match.
    if (val == null) {
      const nn = normKey(f.name);
      if (nn && normDefaults[nn] != null && normDefaults[nn] !== '') val = normDefaults[nn];
    }
    // Fall back to normalized description match.
    if (val == null) {
      const nd = normKey(f.description);
      if (nd && normDefaults[nd] != null && normDefaults[nd] !== '') val = normDefaults[nd];
    }
    // Index-based override (e.g. defaults["__field_10"] = "525000"). Rare
    // escape hatch for templates with blank names/descriptions.
    if (val == null) {
      const idxKey = `__field_${idx}`;
      if (defaults[idxKey] != null && defaults[idxKey] !== '') val = defaults[idxKey];
    }

    if (val != null && val !== '') {
      return { ...f, default_value: String(val) };
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
  // 20-19 → "First Party" (single submitter template).
  const normalizedSubmitters = signers.map((s) => ({
    name: s.name,
    email: s.email,
    role: normalizeRoleForTemplate(s.role, templateId) || 'Signer',
    // 2026-07-13 Round 11 — Suppress DocuSeal's native email; Dossie sends its
    // own via Resend from sendSigningEmail() in the POST handler. Matches the
    // pattern in esign-create.js and avoids duplicate emails.
    send_email: false,
  }));

  const body = {
    template_id: submissionTemplateId,
    send_email: false,
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

      // 2026-07-14 Atlas — IABS templates use profile-level agent defaults
      // (progressive profiling). Fetch saved broker/agent info + inject as
      // prefill. Called only for the two IABS templates; skipped otherwise
      // so we don't add unrelated columns to every prefill payload.
      const IABS_TEMPLATE_IDS = new Set(['4985883', '4984666']);
      let iabsPrefill = {};
      if (IABS_TEMPLATE_IDS.has(String(templateId))) {
        const iabsDefaults = await fetchIabsDefaults(userId).catch(() => null);
        iabsPrefill = buildIabsPrefill(iabsDefaults);
        console.log(`[esign-templates] IABS template ${templateId}: applied ${Object.keys(iabsPrefill).length} agent defaults`);
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
        // IABS agent defaults (populated only for IABS templates).
        ...iabsPrefill,
        // Extra fields from the form override defaults (agent may edit before send).
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
      const signerRows = (Array.isArray(submissionResult.submitters) ? submissionResult.submitters : []).map((sub, i) => {
        // Prefer slug-based public link (https://docuseal.com/s/{slug}) over embed_src.
        // Matches esign-create.js pattern for consistent Resend email links.
        const slug = sub.slug || null;
        const signingUrl = slug
          ? `https://docuseal.com/s/${slug}`
          : (sub.embed_src || null);
        return {
          name: sub.name || signers[i]?.name || '',
          email: sub.email || signers[i]?.email || '',
          role: sub.role || signers[i]?.role || 'Signer',
          status: sub.status || 'sent',
          signingUrl,
          uuid: sub.uuid || null,
        };
      });

      // 2026-07-13 Round 11 — Send Dossie-branded signing email per signer via
      // Resend. DocuSeal's native email is suppressed above (send_email:false)
      // because the account-level toggle is OFF in the DocuSeal dashboard.
      // Fire-and-forget per signer; a single email failure must not abort.
      const documentName = template ? template.label : 'Document';
      const propertyAddressForEmail = tx ? (tx.property_address || '') : '';
      await Promise.all(
        signerRows
          .filter((s) => s.email && s.signingUrl)
          .map((s) =>
            sendSigningEmail({
              signerName: s.name,
              signerEmail: s.email,
              documentName,
              propertyAddress: propertyAddressForEmail,
              signingUrl: s.signingUrl,
            }).catch((err) => {
              console.error(`[esign-templates] sendSigningEmail failed for ${s.email}:`, err && err.message ? err.message : err);
            })
          )
      );

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
