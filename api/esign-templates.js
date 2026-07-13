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
    type: 'financing_addendum',
    label: 'TREC 40-11 Third Party Financing',
    description: 'Third Party Financing Addendum',
    envVar: 'DOCUSEAL_TEMPLATE_FINANCING_ADDENDUM',
    fallbackId: '4023463',
    defaultSigners: BUYER_SELLER_2,
    prefillFields: CORE_PREFILL,
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
    type: 'amendment',
    label: 'TREC 39-11 Amendment',
    description: 'Amendment to Contract — modify closing date, sales price, or other terms',
    envVar: 'DOCUSEAL_TEMPLATE_AMENDMENT',
    fallbackId: '4111320',
    defaultSigners: BUYER_SELLER_1,
    prefillFields: CORE_PREFILL,
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
  if (envVar && process.env[envVar]) return process.env[envVar];
  return fallbackId || null;
}

async function fetchTransaction(transactionId, userId) {
  const res = await supa(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,property_address,buyer_name,seller_name,sale_price,closing_date,city_state_zip,option_expiration_date&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
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
        role: s.role,
        status: 'sent',
        embed_src: null,
      })),
    };
  }

  const body = {
    template_id: templateId,
    send_email: true,
    submitters: signers.map((s) => ({
      name: s.name,
      email: s.email,
      role: s.role || 'Signer',
    })),
    ...(message ? { email_body: message } : {}),
    ...(prefillData && Object.keys(prefillData).length > 0 ? { values: prefillData } : {}),
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
