// DocuSeal Prefill API Helper
// Uses Heath's pre-mapped DocuSeal templates to fill forms.
// Each template has field names already set up in DocuSeal UI.
// This helper POSTs values to DocuSeal API and returns the filled PDF URL.

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

// Template ID mapping — TREC forms Heath pre-mapped in DocuSeal
// Role names MUST match exactly what's in each DocuSeal template definition.
const DOCUSEAL_TEMPLATES = {
  'resale-contract': {
    templateId: 4018208,
    formName: 'One to Four Family Residential Contract (Resale)',
    roles: ['Buyer 1', 'Seller 2'], // actual submitter names from template
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

/**
 * Prefill a DocuSeal template and get the filled PDF URL
 * @param {string} formType - form type key (e.g. 'resale-contract')
 * @param {object} fieldValues - { field_name: value, ... } from chat extraction
 * @returns {Promise<{pdfUrl: string, submissionId: string}>}
 */
async function prefillDocuSealTemplate(formType, fieldValues) {
  if (!DOCUSEAL_API_KEY) {
    throw new Error('DOCUSEAL_API_KEY not set in environment');
  }

  const config = DOCUSEAL_TEMPLATES[formType];
  if (!config) {
    throw new Error(`Unknown form type for DocuSeal: ${formType}`);
  }

  // Build submitters array. Each role gets the same field values unless overridden.
  // For single-role forms (e.g., Seller's Disclosure), only include that role.
  const submitters = config.roles.map((role) => ({
    role,
    email: `${role.toLowerCase()}@dossie.local`,
    send_email: false,
    values: fieldValues,
  }));

  // POST to DocuSeal /submissions API
  const payload = {
    template_id: config.templateId,
    send_email: false,
    submitters,
  };

  let res;
  try {
    res = await fetch(`${DOCUSEAL_BASE}/submissions`, {
      method: 'POST',
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeout: 30000, // 30s timeout for DocuSeal response
    });
  } catch (err) {
    throw new Error(`DocuSeal API fetch failed: ${err.message}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `DocuSeal API error (${res.status}): ${text}`
    );
  }

  const submission = await res.json();

  // Submission may return immediately with status 'pending' or 'completed'.
  // In prefill-only mode (no signature flow), the documents are ready right away.
  if (!submission.id || !submission.documents || submission.documents.length === 0) {
    throw new Error(
      `DocuSeal submission missing documents: ${JSON.stringify(submission)}`
    );
  }

  const pdfUrl = submission.documents[0].url;
  if (!pdfUrl) {
    throw new Error('DocuSeal submission missing document URL');
  }

  return {
    submissionId: submission.id,
    pdfUrl,
    formName: config.formName,
  };
}

module.exports = { prefillDocuSealTemplate, DOCUSEAL_TEMPLATES };
