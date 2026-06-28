// DocuSeal Prefill API Helper
// Uses Heath's pre-mapped DocuSeal templates to fill forms.
//
// 2026-06-27 ATLAS FIX (E2E loop):
//   - DocuSeal API now returns an ARRAY of submitter rows (not an object) from POST /submissions.
//   - Multi-submitter prefill via per-submitter `values` returns 500. The correct approach is
//     top-level `fields: [{name, default_value}]` array.
//   - To download the prefilled PDF (before signing), use GET /submissions/{id}/documents,
//     not GET /submissions/{id} (which only returns submitter records).
// Without these fixes, every fill-form call to a DOCUSEAL_FORMS form_type
// returned 500 ("DocuSeal prefill failed").

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const DOCUSEAL_TEMPLATES = {
  'resale-contract': {
    templateId: 4018208,
    formName: 'One to Four Family Residential Contract (Resale)',
    roles: ['Buyer 1', 'Seller 1'],
  },
  'financing-addendum': {
    templateId: 4023463,
    formName: 'Third Party Financing Addendum (TREC 40-11)',
    roles: ['Buyer', 'Seller'],
  },
  'appraisal-termination': {
    templateId: 4023472,
    formName: 'Right to Terminate Due to Lender\'s Appraisal (TREC 49-1)',
    roles: ['Buyer', 'Seller'],
  },
  'sellers-disclosure': {
    templateId: 4023470,
    formName: 'Seller\'s Disclosure Notice (TREC OP-H)',
    roles: ['Seller 1'],
  },
  'hoa-addendum': {
    templateId: 4111321,
    formName: 'HOA Addendum (TREC 36-11)',
    roles: ['Buyer 1', 'Seller 1'],
  },
  'amendment': {
    templateId: 4111320,
    formName: 'Amendment to Contract (TREC 39-10)',
    roles: ['Buyer', 'Seller'],
  },
  'backup-contract': {
    templateId: 4023578,
    formName: 'Backup Contract Addendum (TREC 11-7)',
    roles: ['Buyer', 'Seller'],
  },
  'lead-paint-addendum': {
    templateId: 4023469,
    formName: 'Lead-Based Paint Addendum (OP-L)',
    roles: ['Buyer 1', 'Seller 1'],
  },
};

// Map our snake_case field names to DocuSeal's actual template field labels.
const KEY_MAP = {
  'resale-contract': {
    buyer_name: 'buyer_name',
    seller_name: 'seller_name',
    property_address: 'property_address',
    sales_price: 'sales_price',
    sale_price: 'sales_price',
    closing_date: 'closing_date',
    closing_year: 'closing_year',
    earnest_money_amount: 'earnest_money_amount',
    earnest_money: 'earnest_money_amount',
    down_payment: 'down_payment',
    option_period_days: 'option_period_days',
    option_days: 'option_period_days',
    option_fee: 'option_fee',
    title_company_name: 'title_company_name',
    title_company: 'title_company_name',
    escrow_agent_name: 'escrow_agent_name',
    title_seller_pays: 'title_seller_pays',
    title_buyer_pays: 'title_buyer_pays',
    third_party_financing: 'third_party_financing',
    addendum_financing: 'addendum_financing',
    addendum_lead_paint: 'addendum_lead_paint',
    county: 'county',
    city_state_zip: 'city_state_zip',
    legal_description: 'Legal_Description',
    legal_lot: 'legal_lot',
    legal_block: 'legal_block',
    addition_city: 'addition_city',
    loan_amount: 'loan_amount',
    buyer_phone: 'buyer_phone',
    buyer_email: 'buyer_email',
    buyer_notice_address: 'buyer_notice_address',
    seller_phone: 'seller_phone',
    seller_email: 'seller_email',
    seller_notice_address: 'seller_notice_address',
    listing_broker_firm: 'listing_broker_firm',
    listing_agent_name: 'listing_agent_name',
    as_is: 'as_is',
    sdn_received: 'sdn_received',
  },
  // 2026-06-27 ATLAS: expanded to full TREC 40-11 field set (verified via
  // GET /templates/4023463 — 67 fields). Maps both common extraction keys
  // (loan_amount, interest_rate_max) and addendum-specific direct fields.
  'financing-addendum': {
    property_address: 'property_address',
    property_address_p2: 'property_address_p2',
    // Conventional / first mortgage
    conventional_financing: 'conventional_financing',
    first_mortgage_loan: 'first_mortgage_loan',
    first_loan_amount: 'first_loan_amount',
    first_loan_amount_due: 'first_loan_amount_due',
    first_interest_rate: 'first_interest_rate',
    first_loan_term_years: 'first_loan_term_years',
    first_origination_cap: 'first_origination_cap',
    // Second mortgage
    second_mortgage_loan: 'second_mortgage_loan',
    second_loan_amount: 'second_loan_amount',
    second_loan_term: 'second_loan_term',
    second_interest_rate: 'second_interest_rate',
    second_origination_cap: 'second_origination_cap',
    second_loan_exclusion: 'second_loan_exclusion',
    // TX Vet
    tx_veterans_loan: 'tx_veterans_loan',
    tx_vet_loan_amount: 'tx_vet_loan_amount',
    tx_vet_loan_years: 'tx_vet_loan_years',
    // FHA
    fha_financing: 'fha_financing',
    fha_section: 'fha_section',
    fha_loan_amount: 'fha_loan_amount',
    fha_amortization_years: 'fha_amortization_years',
    fha_interest_rate: 'fha_interest_rate',
    fha_origination_text: 'fha_origination_text',
    fha_origination_cap: 'fha_origination_cap',
    will_fha: 'will_fha',
    will_not_fha: 'will_not_fha',
    fha_conversion_check: 'fha_conversion_check',
    fha_conversion_amount: 'fha_conversion_amount',
    // VA
    va_financing: 'va_financing',
    va_loan_amount: 'va_loan_amount',
    va_amortization_years: 'va_amortization_years',
    va_interest_rate: 'va_interest_rate',
    va_origination_cap: 'va_origination_cap',
    va_loan_estimate_cap: 'va_loan_estimate_cap',
    va_appraised_value: 'va_appraised_value',
    // USDA
    usda_financing: 'usda_financing',
    usda_loan_amount: 'usda_loan_amount',
    usda_interest_rate: 'usda_interest_rate',
    usda_term_years: 'usda_term_years',
    usda_origination_cap: 'usda_origination_cap',
    // Reverse mortgage
    reverse_mortgage: 'reverse_mortgage',
    reverse_loan_amount: 'reverse_loan_amount',
    reverse_funding_fee: 'reverse_funding_fee',
    reverse_term_1: 'reverse_term_1',
    reverse_rate_1: 'reverse_rate_1',
    // Misc / approval
    credit_approval_days: 'credit_approval_days',
    buyer_approval_required: 'buyer_approval_required',
    other_origination_percent: 'other_origination_percent',
    // Common-extraction aliases → addendum primary loan fields
    loan_amount: 'first_loan_amount',
    interest_rate_max: 'first_interest_rate',
    loan_term_years: 'first_loan_term_years',
  },
  // 2026-06-27 ATLAS: full HOA field map verified via
  // GET /templates/4111321 — 17 fields. DocuSeal scraped some field names
  // from PDF label text — the long descriptive names are real keys.
  'hoa-addendum': {
    // Headline fields
    property_address: 'Street Address and City',
    hoa_name_and_phone: 'Name of Property Owners Association Association and Phone Number',
    // Section B — Buyer Subdivision Information delivery options
    section_b1_within: '1 Within',
    section_b1_terminate_text:
      'the Subdivision Information to the Buyer If Seller delivers the Subdivision Information Buyer may terminate',
    section_b2_check: 'undefined',
    section_b2_subdivision_text: 'copy of the Subdivision Information to the Seller',
    section_b3_received:
      '3Buyer has received and approved the Subdivision Information before signing the contract Buyer',
    section_b3_does: 'does',
    section_b3_does_not:
      'does not require an updated resale certificate If Buyer requires an updated resale certificate Seller at',
    section_b4_no_delivery: '4Buyer does not require delivery of the Subdivision Information',
    // Section D — Reserves + Title cost
    section_d_reserves:
      'D DEPOSITS FOR RESERVES Buyer shall pay any deposits for reserves required at closing by the Association',
    title_buyer_pays: 'Buyer',
    title_seller_pays: 'Seller shall pay the Title Company the cost of obtaining the',
    // Signature roles
    buyer_name: 'buyer_1_name',
    buyer_1_name: 'buyer_1_name',
    buyer_2_name: 'buyer_2_name',
    seller_name: 'Seller_1_name',
    seller_1_name: 'Seller_1_name',
    seller_2_name: 'Seller_2_name',
  },
  // 2026-06-27 ATLAS: full OP-L Lead-Based Paint field map verified via
  // GET /templates/4023469 — 23 fields.
  'lead-paint-addendum': {
    property_address: 'property_address',
    // Seller disclosure
    known_lead_paint: 'known_lead_paint',
    known_lead_paint_description: 'known_lead_paint_description',
    no_knowledge_lead_paint: 'no_knowledge_lead_paint',
    records_available: 'records_available',
    records_description: 'records_description',
    no_records: 'no_records',
    // Buyer acknowledgement
    buyer_waives_inspection: 'buyer_waives_inspection',
    buyer_reserves_inspection: 'buyer_reserves_inspection',
    buyer_received_copies: 'buyer_received_copies',
    buyer_received_pamphlet: 'buyer_received_pamphlet',
    // Signatures and dates
    buyer_signature_1: 'buyer_signature_1',
    buyer_date_1: 'buyer_date_1',
    seller_signature_1: 'seller_signature_1',
    seller_date_1: 'seller_date_1',
    buyer_signature_2: 'buyer_signature_2',
    buyer_date_2: 'buyer_date_2',
    seller_signature_2: 'seller_signature_2',
    seller_date_2: 'seller_date_2',
    buyers_broker_signature: 'buyers_broker_signature',
    buyers_broker_date: 'buyers_broker_date',
    sellers_broker_signature: 'sellers_broker_signature',
    sellers_broker_date: 'sellers_broker_date',
    // Convenience aliases from extractor canonical keys
    seller_disclosure_choice: 'no_knowledge_lead_paint',
    buyer_acknowledgment: 'buyer_received_pamphlet',
  },
};

function placeholderEmail(role) {
  const normalized = role.toLowerCase().replace(/\s+/g, '-');
  return normalized + '-placeholder@meetdossie.com';
}

function sanitizeValue(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'boolean') return v ? 'X' : '';
  return String(v);
}

// Build the top-level `fields` array DocuSeal expects.
// Format: [{name: 'field_name', default_value: '...'}]
function buildFieldsArray(formType, fieldValues) {
  const mapping = KEY_MAP[formType];
  if (!mapping) {
    throw new Error('No field mapping defined for form type: ' + formType);
  }

  const fields = [];
  for (const ourKey in fieldValues) {
    const docusealName = mapping[ourKey];
    if (!docusealName) continue;
    const sanitized = sanitizeValue(fieldValues[ourKey]);
    if (sanitized !== undefined && sanitized !== '') {
      fields.push({ name: docusealName, default_value: sanitized });
    }
  }
  return fields;
}

// Fetch the prefilled PDF URL for a submission.
// Uses GET /submissions/{id}/documents which works pre-signing (returns prefilled PDF).
async function fetchSubmissionPdfUrl(submissionId, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
    try {
      const r = await fetch(`${DOCUSEAL_BASE}/submissions/${submissionId}/documents`, {
        headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
        timeout: 30000,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        lastErr = new Error('GET /submissions/' + submissionId + '/documents failed (' + r.status + '): ' + t.slice(0, 200));
        continue;
      }
      const j = await r.json();
      const pdfUrl = j?.documents?.[0]?.url;
      if (pdfUrl) return pdfUrl;
      lastErr = new Error('Documents endpoint returned no URL: ' + JSON.stringify(j).slice(0, 200));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not fetch prefilled PDF URL');
}

async function prefillDocuSealTemplate(formType, fieldValues) {
  if (!DOCUSEAL_API_KEY) {
    throw new Error('DOCUSEAL_API_KEY not set in environment');
  }

  const config = DOCUSEAL_TEMPLATES[formType];
  if (!config) {
    throw new Error('Unknown form type for DocuSeal: ' + formType);
  }

  const fields = buildFieldsArray(formType, fieldValues);

  // Build submitters — NO per-submitter `values` (causes 500 on multi-submitter templates).
  const submitters = config.roles.map((role) => ({
    role: role,
    email: fieldValues.buyer_email || fieldValues.seller_email || placeholderEmail(role),
    send_email: false,
  }));

  const payload = {
    template_id: config.templateId,
    send_email: false,
    submitters: submitters,
    fields: fields,
  };

  let res;
  try {
    res = await fetch(DOCUSEAL_BASE + '/submissions', {
      method: 'POST',
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeout: 30000,
    });
  } catch (err) {
    throw new Error('DocuSeal API fetch failed: ' + err.message);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error('DocuSeal API error (' + res.status + '): ' + text);
  }

  // Response shape (current API): array of submitter records.
  // Each has a `submission_id` we need.
  const submitterRows = await res.json();
  if (!Array.isArray(submitterRows) || submitterRows.length === 0) {
    throw new Error('DocuSeal returned unexpected response: ' + JSON.stringify(submitterRows).slice(0, 200));
  }

  const submissionId = submitterRows[0].submission_id;
  if (!submissionId) {
    throw new Error('DocuSeal submission missing submission_id: ' + JSON.stringify(submitterRows[0]).slice(0, 200));
  }

  // Fetch the prefilled PDF via the documents endpoint.
  const pdfUrl = await fetchSubmissionPdfUrl(submissionId, 3);

  return {
    submissionId: submissionId,
    pdfUrl: pdfUrl,
    formName: config.formName,
  };
}

module.exports = { prefillDocuSealTemplate: prefillDocuSealTemplate, DOCUSEAL_TEMPLATES: DOCUSEAL_TEMPLATES };
