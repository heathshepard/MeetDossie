// Vercel Serverless Function: /api/fill-form-via-docuseal
// Fills TREC forms via DocuSeal instead of pdf-lib.
// Uses pre-configured DocuSeal templates with intelligent field mapping.
//
// POST { transaction_id, form_type, field_values }
// form_type: 'resale-contract' (only form_type supported for now)
// field_values: { buyer_name, seller_name, property_address, sales_price, closing_date, ... }
//
// Authorization: Bearer <supabase user JWT>
// Returns: { ok: true, documentId, storagePath, signedUrl, fileName, submissionId }

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
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
const DOCUSEAL_TEMPLATE_RESALE_ID = Number(process.env.DOCUSEAL_TEMPLATE_RESALE_ID) || 4018208;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+(?:-heathshepard-6590s-projects)?\.vercel\.app$/;

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (LOCALHOST_ORIGIN_RE.test(origin)) return true;
  if (VERCEL_PREVIEW_RE.test(origin)) return true;
  return false;
}

async function supabaseStorageUpload(path, buffer, contentType = 'application/pdf') {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
    },
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase Storage upload failed: ${response.status} ${text.slice(0, 200)}`);
  }
  return { path };
}

async function supabaseStorageSignedUrl(path, expirationSeconds) {
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: expirationSeconds }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase Storage signed URL failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.signedURL;
}

async function supabaseInsertDocument(docRow) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/documents`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(docRow),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`documents insert failed: ${response.status} ${text.slice(0, 200)}`);
  }
  const rows = await response.json();
  return rows && rows.length > 0 ? rows[0] : null;
}

async function docusealCreateSubmission(templateId, submitters, transactionId) {
  const payload = {
    template_id: templateId,
    send_email: false,
    submitters: submitters,
  };

  const response = await fetch(`${DOCUSEAL_BASE}/submissions`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DocuSeal submission creation failed: ${response.status} ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return data;
}

async function docusealGetSubmissionPdf(submissionId) {
  // Fetch the submission to get document links
  const response = await fetch(`${DOCUSEAL_BASE}/submissions/${submissionId}`, {
    method: 'GET',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DocuSeal submission fetch failed: ${response.status} ${text.slice(0, 200)}`);
  }

  const submission = await response.json();

  // Submission object should have a field with the PDF URL or document data
  // Check for common response shapes
  if (submission.documents && submission.documents.length > 0) {
    const pdfUrl = submission.documents[0].url || submission.documents[0].file_url;
    if (pdfUrl) {
      // Download the PDF
      const pdfResponse = await fetch(pdfUrl);
      if (!pdfResponse.ok) {
        throw new Error(`PDF download failed: ${pdfResponse.status}`);
      }
      return await pdfResponse.buffer();
    }
  }

  // Fallback: check for a direct download URL
  if (submission.file_url || submission.url) {
    const pdfUrl = submission.file_url || submission.url;
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`PDF download failed: ${pdfResponse.status}`);
    }
    return await pdfResponse.buffer();
  }

  throw new Error('DocuSeal submission has no PDF URL');
}

// Map incoming field_values keys to DocuSeal template field names

// Translate extract-form-fields output keys to DocuSeal template field names
function mapExtractedFieldsToDocuSeal(fieldValues) {
  // extract-form-fields emits canonical keys like sale_price, earnest_money, option_days, title_company
  // DocuSeal template expects different names: sales_price, earnest_money_amount, option_period_days, title_company_name + escrow_agent_name
  // This layer bridges them and handles special cases.

  const docusealFields = {};

  // Direct 1:1 mappings
  const directMap = {
    'buyer_name': 'buyer_name',
    'seller_name': 'seller_name',
    'property_address': 'property_address',
    'city_state_zip': 'city_state_zip',
    'county': 'county',
    'legal_description': 'Legal_Description',
    'legal_lot': 'legal_lot',
    'legal_block': 'legal_block',
    'addition_city': 'addition_city',
    'loan_amount': 'loan_amount',
    'down_payment': 'down_payment',
    'option_fee': 'option_fee',
    'closing_date': 'closing_date',
    'escrow_agent_address': 'escrow_agent_address',
    'buyer_phone': 'buyer_phone',
    'buyer_email': 'buyer_email',
    'buyer_notice_address': 'buyer_notice_address',
    'seller_phone': 'seller_phone',
    'seller_email': 'seller_email',
    'seller_notice_address': 'seller_notice_address',
    'buyer_attorney': 'buyer_attorney',
    'seller_attorney': 'seller_attorney',
    'listing_broker_firm': 'listing_broker_firm',
    'listing_agent_name': 'listing_agent_name',
    'other_broker_firm': 'other_broker_firm',
    'other_agent_name': 'other_agent_name',
    'permitted_use': 'permitted_use',
    'property_repairs_list': 'property_repairs_list',
    'special_provisions': 'special_provisions',
    'survey_c1': 'survey_c1',
    'survey_c2': 'survey_c2',
    'survey_c3': 'survey_c3',
    'survey_c1_days': 'survey_c1_days',
    'survey_c2_days': 'survey_c2_days',
    'survey_c3_days': 'survey_c3_days',
    'survey_not_amended': 'survey_not_amended',
    'survey_new_expense_buyer': 'survey_new_expense_buyer',
    'survey_new_expense_seller': 'survey_new_expense_seller',
    'survey_amend_buyer': 'survey_amend_buyer',
    'survey_amend_seller': 'survey_amend_seller',
    'sdn_received': 'sdn_received',
    'sdn_not_received': 'sdn_not_received',
    'sdn_not_required': 'sdn_not_required',
    'sdn_delivery_days': 'sdn_delivery_days',
    'has_residential_leases': 'has_residential_leases',
    'has_fixture_leases': 'has_fixture_leases',
    'has_natural_resource_leases': 'has_natural_resource_leases',
    'as_is': 'as_is',
    'as_is_with_repairs': 'as_is_with_repairs',
    'exclusions': 'exclusions',
    'third_party_financing': 'third_party_financing',
    'title_buyer_pays': 'title_buyer_pays',
    'title_seller_pays': 'title_seller_pays',
    'title_objection_days': 'title_objection_days',
    'broker_fee_percent': 'broker_fee_percent',
    'broker_fee_percent_check': 'broker_fee_percent_check',
    'broker_fee_flat_amount': 'broker_fee_flat_amount',
    'broker_fee_flat_check': 'broker_fee_flat_check',
    'seller_buyer_broker_pct': 'seller_buyer_broker_pct',
    'seller_buyer_broker_pct_check': 'seller_buyer_broker_pct_check',
    'seller_buyer_broker_amount': 'seller_buyer_broker_amount',
    'seller_buyer_broker_dollar_check': 'seller_buyer_broker_dollar_check',
    'seller_closing_cost_credit': 'seller_closing_cost_credit',
    'additional_em_days': 'additional_em_days',
    'additional_earnest_money': 'additional_earnest_money',
    'required_notices': 'required_notices',
    'execution_day': 'execution_day',
    'execution_month': 'execution_month',
    'execution_year': 'execution_year',
    'closing_year': 'closing_year',
  };

  // Apply direct mappings (only if field has a real value)
  for (const [extractKey, docKey] of Object.entries(directMap)) {
    if (extractKey in fieldValues && fieldValues[extractKey] != null && fieldValues[extractKey] !== '') {
      docusealFields[docKey] = String(fieldValues[extractKey]).trim();
    }
  }

  // Special case: sale_price (from extract) → sales_price (DocuSeal)
  if ('sale_price' in fieldValues && fieldValues.sale_price != null && fieldValues.sale_price !== '') {
    docusealFields['sales_price'] = String(fieldValues.sale_price).trim();
  }

  // Special case: earnest_money (from extract) → earnest_money_amount (DocuSeal)
  if ('earnest_money' in fieldValues && fieldValues.earnest_money != null && fieldValues.earnest_money !== '') {
    docusealFields['earnest_money_amount'] = String(fieldValues.earnest_money).trim();
  }

  // Special case: option_days (from extract) → option_period_days (DocuSeal)
  if ('option_days' in fieldValues && fieldValues.option_days != null && fieldValues.option_days !== '') {
    docusealFields['option_period_days'] = String(fieldValues.option_days).trim();
  }

  // Special case: title_company (from extract) → title_company_name + escrow_agent_name (DocuSeal)
  // One extracted field becomes two DocuSeal fields (same company often plays both roles)
  if ('title_company' in fieldValues && fieldValues.title_company != null && fieldValues.title_company !== '') {
    const companyName = String(fieldValues.title_company).trim();
    docusealFields['title_company_name'] = companyName;
    docusealFields['escrow_agent_name'] = companyName;
  }

  // Special case: possession (from extract) is a string like "closing" or "leaseback"
  // DocuSeal template uses boolean checkboxes: possession_closing, possession_leaseback
  if ('possession' in fieldValues && fieldValues.possession != null && fieldValues.possession !== '') {
    const possessionType = String(fieldValues.possession).toLowerCase().trim();
    if (possessionType === 'closing') {
      docusealFields['possession_closing'] = true;
    } else if (possessionType === 'leaseback') {
      docusealFields['possession_leaseback'] = true;
    }
  }

  return docusealFields;
}

module.exports = async (req, res) => {
  // CORS
  const origin = req.headers.origin || '';
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let transactionId, formType, fieldValues, userId;
  let storagePathForCleanup = null;

  try {
    // Auth
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      throw new AuthError('Missing authorization token', 401);
    }

    const { userId } = await verifySupabaseToken(req);

    // Rate limit
    const clientIp = clientIpFromReq(req);
    await checkRateLimit(clientIp, 'fill-form-via-docuseal', 20, 3600); // 20 per hour

    // Parse body
    const body = req.body || {};
    transactionId = body.transaction_id;
    formType = body.form_type;
    fieldValues = body.field_values || {};

    // Validate
    if (!transactionId) {
      throw new ValidationError('Missing transaction_id', 400);
    }
    if (!formType) {
      throw new ValidationError('Missing form_type', 400);
    }
    if (typeof fieldValues !== 'object' || fieldValues === null) {
      throw new ValidationError('field_values must be an object', 400);
    }

    // Only resale-contract is supported for now
    if (formType !== 'resale-contract') {
      throw new ValidationError(`Form type ${formType} not yet supported via DocuSeal. Supported: resale-contract`, 400);
    }

    // Map and sanitize fields
    const docusealFields = mapExtractedFieldsToDocuSeal(fieldValues);

    // Create DocuSeal submission
    // Use actual emails from field_values if available; fall back to placeholder emails
    // DocuSeal requires valid email format but doesn't send (send_email: false)
    const submitters = [
      {
        role: 'Buyer',
        email: fieldValues.buyer_email || 'buyer-placeholder@meetdossie.com',
        name: fieldValues.buyer_name || 'Buyer',
        send_email: false,
        values: docusealFields,
      },
      {
        role: 'Seller',
        email: fieldValues.seller_email || 'seller-placeholder@meetdossie.com',
        name: fieldValues.seller_name || 'Seller',
        send_email: false,
        values: docusealFields,
      },
    ];

    const submission = await docusealCreateSubmission(
      DOCUSEAL_TEMPLATE_RESALE_ID,
      submitters,
      transactionId
    );

    const submissionId = submission.id;
    if (!submissionId) {
      throw new Error('DocuSeal did not return submission ID');
    }

    // Wait a moment for the PDF to be generated
    await new Promise(resolve => setTimeout(resolve, 500));

    // Fetch the filled PDF
    let pdfBuffer;
    try {
      pdfBuffer = await docusealGetSubmissionPdf(submissionId);
    } catch (err) {
      console.warn('[fill-form-via-docuseal] PDF fetch failed, will retry:', err.message);
      // Retry once after a short delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      pdfBuffer = await docusealGetSubmissionPdf(submissionId);
    }

    // Upload to Supabase Storage
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    const storagePath = `${transactionId}/TREC-Resale-Contract-${timestamp}.pdf`;
    storagePathForCleanup = storagePath;

    await supabaseStorageUpload(storagePath, pdfBuffer, 'application/pdf');

    // Insert documents row
    const docRow = await supabaseInsertDocument({
      transaction_id: transactionId,
      document_type: 'resale_contract',
      status: 'filled',
      storage_url: storagePath,
      name: `TREC-Resale-Contract-${timestamp}.pdf`,
      created_at: new Date().toISOString(),
    });

    // Generate signed URL
    const signedUrl = await supabaseStorageSignedUrl(storagePath, 3600);

    return res.status(200).json({
      ok: true,
      documentId: docRow && docRow.id ? docRow.id : null,
      storagePath,
      signedUrl,
      fileName: `TREC-Resale-Contract-${timestamp}.pdf`,
      submissionId,
      formName: 'One to Four Family Residential Contract (Resale)',
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
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    const msg = (error && error.message) ? error.message : String(error);
    console.error('[fill-form-via-docuseal] error:', msg);
    return res.status(422).json({ ok: false, error: msg || 'Could not fill that form via DocuSeal.' });
  }
};
