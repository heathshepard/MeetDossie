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
  'financing-addendum': {
    property_address: 'property_address',
    first_loan_amount: 'first_loan_amount',
    first_interest_rate: 'first_interest_rate',
    first_loan_term_years: 'first_loan_term_years',
    fha_financing: 'fha_financing',
    fha_loan_amount: 'fha_loan_amount',
    fha_amortization_years: 'fha_amortization_years',
    va_financing: 'va_financing',
    va_loan_amount: 'va_loan_amount',
    usda_financing: 'usda_financing',
    credit_approval_days: 'credit_approval_days',
    conventional_financing: 'conventional_financing',
  },
  'hoa-addendum': {
    buyer_name: 'buyer_1_name',
    seller_name: 'Seller_1_name',
    property_address: 'Street Address and City',
  },
  'lead-paint-addendum': {
    property_address: 'property_address',
    known_lead_paint: 'known_lead_paint',
    known_lead_paint_description: 'known_lead_paint_description',
    no_knowledge_lead_paint: 'no_knowledge_lead_paint',
    buyer_waives_inspection: 'buyer_waives_inspection',
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
