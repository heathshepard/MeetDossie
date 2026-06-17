// DocuSeal Prefill API Helper
// Uses Heath's pre-mapped DocuSeal templates to fill forms.

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const DOCUSEAL_TEMPLATES = {
  'resale-contract': {
    templateId: 4018208,
    formName: 'One to Four Family Residential Contract (Resale)',
    roles: ['Buyer 1', 'Seller 2'],
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
    closing_date: 'closing_date',
    closing_year: 'closing_year',
    earnest_money_amount: 'earnest_money_amount',
    down_payment: 'down_payment',
    option_period_days: 'option_period_days',
    option_fee: 'option_fee',
    title_company_name: 'title_company_name',
    escrow_agent_name: 'escrow_agent_name',
    title_seller_pays: 'title_seller_pays',
    title_buyer_pays: 'title_buyer_pays',
    third_party_financing: 'third_party_financing',
    addendum_financing: 'addendum_financing',
    addendum_lead_paint: 'addendum_lead_paint',
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

function mapAndSanitizeFields(formType, fieldValues) {
  const mapping = KEY_MAP[formType];
  if (!mapping) {
    throw new Error('No field mapping defined for form type: ' + formType);
  }

  const mappedValues = {};
  for (const ourKey in fieldValues) {
    const ourVal = fieldValues[ourKey];
    const docusealName = mapping[ourKey];
    if (!docusealName) continue;

    const sanitized = sanitizeValue(ourVal);
    if (sanitized !== undefined) {
      mappedValues[docusealName] = sanitized;
    }
  }

  return mappedValues;
}

async function prefillDocuSealTemplate(formType, fieldValues) {
  if (!DOCUSEAL_API_KEY) {
    throw new Error('DOCUSEAL_API_KEY not set in environment');
  }

  const config = DOCUSEAL_TEMPLATES[formType];
  if (!config) {
    throw new Error('Unknown form type for DocuSeal: ' + formType);
  }

  const mappedValues = mapAndSanitizeFields(formType, fieldValues);

  const submitters = config.roles.map((role) => ({
    role: role,
    email: fieldValues.buyer_email || fieldValues.seller_email || placeholderEmail(role),
    send_email: false,
    values: mappedValues,
  }));

  const payload = {
    template_id: config.templateId,
    send_email: false,
    submitters: submitters,
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

  const submission = await res.json();

  if (!submission.id || !submission.documents || submission.documents.length === 0) {
    throw new Error('DocuSeal submission missing documents: ' + JSON.stringify(submission));
  }

  const pdfUrl = submission.documents[0].url;
  if (!pdfUrl) {
    throw new Error('DocuSeal submission missing document URL');
  }

  return {
    submissionId: submission.id,
    pdfUrl: pdfUrl,
    formName: config.formName,
  };
}

module.exports = { prefillDocuSealTemplate: prefillDocuSealTemplate, DOCUSEAL_TEMPLATES: DOCUSEAL_TEMPLATES };
