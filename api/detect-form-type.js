// Vercel Serverless Function: /api/detect-form-type
// POST { document_id }
// Authorization: Bearer <supabase user JWT>
//
// Fetches the document from Supabase Storage, sends first page to Claude Haiku,
// returns the detected TREC form type.
//
// Returns: { ok: true, form_type, trec_number, confidence }
// form_type matches the canonical keys used in fill-form.js and esign-create.js

const Anthropic = require('@anthropic-ai/sdk');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { resolveBlankTemplatePdf } = require('./_lib/resolve-blank-template-pdf');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

// 2026-07-13 CARTER — SHORT_NAME → canonical form_type key, for the
// blank-template early-return path. Mirrors _lib/resolve-blank-template-pdf.js
// (kept local so we don't pay a round trip to re-fetch form_templates when
// the resolver already did).
const SHORT_NAME_TO_FORM_TYPE = {
  '1-4 Family Contract':           'resale-contract',
  'Financing Addendum':            'financing-addendum',
  'HOA Addendum':                  'hoa-addendum',
  'OP-L':                          'lead-paint-addendum',
  'Amendment':                     'amendment',
  'TREC 49-1':                     'appraisal-termination',
  'OP-H':                          'sellers-disclosure',
  'Seller Financing':              'seller-financing',
  'Sale of Other Property':        'sale-other-property',
  'Back-Up Contract':              'backup-contract',
  'Seller Disclosure':             'sellers-disclosure',
  'T-47':                          't47-affidavit',
  'TREC 9':                        'unimproved-property',
  'Buyer Rep Agreement':           'buyer-rep-agreement',
  'TAR 1501':                      'buyer-rep-agreement',
  'TAR 2001':                      'residential-leases',
  'TAR 2517':                      'wire-fraud-warning',
};

async function fetchFormTemplateShortName(formTemplateId) {
  if (!formTemplateId) return null;
  const r = await supa(
    `form_templates?id=eq.${encodeURIComponent(formTemplateId)}&select=short_name`
  );
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]?.short_name) || null;
}

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

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

async function fetchDocumentRow(documentId, userId) {
  const res = await supa(
    `documents?id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,storage_path,file_name,document_type,status,form_template_id`
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`documents fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError('Document not found or does not belong to you.', 404);
  }
  return rows[0];
}

async function fetchFileBytes(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Storage fetch failed (${res.status}) for path: ${storagePath}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

// Known TREC form types returned from detection
// Maps the canonical form_type key used throughout the codebase
const FORM_TYPE_DESCRIPTIONS = `
Known Texas TREC/TAR form types and their identifiers:
- resale-contract: TREC 20-18 (or 20-17), "One to Four Family Residential Contract (Resale)"
- unimproved-property: TREC 9-17, "Unimproved Property Contract"
- new-home-incomplete: TREC 23-18, "New Home Contract (Incomplete Construction)"
- new-home-complete: TREC 24-18, "New Home Contract (Completed Construction)"
- farm-ranch: TREC 25-15, "Farm and Ranch Contract"
- financing-addendum: TREC 40-11 or 49-1, "Third Party Financing Addendum" or "Right to Terminate Due to Lender's Appraisal"
- termination-notice: TREC 50-0, "Seller's Termination" (currently implemented - NOTE: This is seller-side termination, not buyer-side)
  - buyer-termination: TREC 38-7, "Notice of Buyer's Termination of Contract" (NOT YET IMPLEMENTED)
- amendment: TREC 39-10, "Amendment to Contract"
- sellers-disclosure: OP-H, "Seller's Disclosure Notice"
- hoa-addendum: TREC 36-11, "Addendum for Property Subject to Mandatory Membership in Property Owners Association"
- lead-paint-addendum: OP-L, "Lead-Based Paint Addendum"
- wire-fraud-advisory: TAR, "Wire Fraud Advisory"
- buyer-rep: TAR 2501, "Residential Buyer/Tenant Representation Agreement"
- t47-affidavit: T-47, "Residential Real Property Affidavit"
- loan-assumption: TREC 41-4, "Loan Assumption Addendum"
- backup-contract: TREC 11-7, "Addendum for Back-Up Contract"
- sale-other-property: TREC 10-7, "Addendum for Sale of Other Property"
- coastal-area: TREC 33-3, "Addendum for Coastal Area Property"
- hydrostatic-testing: TREC 49-2, "Seller's Temporary Residential Lease"
- environmental: TREC 28-3, "Environmental Assessment Addendum"
- short-sale: TREC 45-2, "Short Sale Addendum"
- oil-gas-minerals: TREC 44-3, "Addendum Concerning Right to Terminate Due to Lender's Appraisal"
- improvement-district: TREC 34-6, "Addendum for Property Located Seaward of the Gulf Intracoastal Waterway"
- buyers-temp-lease: TREC 15-6, "Buyer's Temporary Residential Lease"
- sellers-temp-lease: TREC 16-6, "Seller's Temporary Residential Lease"
- residential-leases: TREC 2001, "Residential Lease"
- propane-gas: TREC 47-2, "Addendum for Seller's Disclosure of Information on Lead-Based Paint"
- unknown: Cannot identify the form type
`;

async function detectFormType(pdfBytes) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const base64Pdf = pdfBytes.toString('base64');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Pdf,
            },
          },
          {
            type: 'text',
            text: `You are identifying a Texas real estate form. Look at the document title, form number, and content.

${FORM_TYPE_DESCRIPTIONS}

Respond with ONLY valid JSON (no explanation, no markdown):
{
  "form_type": "<canonical key from the list above>",
  "trec_number": "<e.g. OP-H, TREC 20-18, TAR 2501 — or empty string if unknown>",
  "confidence": <0.0 to 1.0>,
  "detected_title": "<form title as it appears on the document>"
}`,
          },
        ],
      },
    ],
  });

  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const text = ((response.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  const cleaned = text.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('[detect-form-type] JSON parse failed:', text.slice(0, 200));
    return { form_type: 'unknown', trec_number: '', confidence: 0, detected_title: '' };
  }

  return {
    form_type: parsed.form_type || 'unknown',
    trec_number: parsed.trec_number || '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    detected_title: parsed.detected_title || '',
  };
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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ ok: false, error: 'AI service not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'detect-form-type', 30, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const body = req.body || {};
    const documentId = sanitizeString(body.document_id, { maxLength: 200 });

    if (!documentId) throw new ValidationError('document_id is required.');

    const doc = await fetchDocumentRow(documentId, userId);

    // 2026-07-13 CARTER — Blank form_template placeholders (storage_path like
    // "template/{id}.pdf") 404 from Storage. We already know the form type
    // from form_templates.short_name, so skip Claude entirely and return the
    // canonical key with confidence 1.0. Falls through to Storage fetch for
    // normal user-uploaded docs.
    const resolvedBlank = await resolveBlankTemplatePdf(doc);
    if (resolvedBlank) {
      const shortName = await fetchFormTemplateShortName(doc.form_template_id);
      const canonical = SHORT_NAME_TO_FORM_TYPE[shortName] || 'unknown';
      console.log(`[detect-form-type] Blank template ${doc.form_template_id} short_name="${shortName}" → form_type="${canonical}" (Claude skipped).`);
      return res.status(200).json({
        ok: true,
        form_type: canonical,
        trec_number: shortName || '',
        confidence: canonical === 'unknown' ? 0 : 1,
        detected_title: shortName || '',
      });
    }

    if (!doc.storage_path) {
      throw new ValidationError('Document has no storage path — cannot detect form type.', 422);
    }

    const pdfBytes = await fetchFileBytes(doc.storage_path);

    if (!pdfBytes || pdfBytes.length < 100) {
      throw new ValidationError('Document file is empty or unreadable.', 422);
    }

    const result = await detectFormType(pdfBytes);

    return res.status(200).json({
      ok: true,
      form_type: result.form_type,
      trec_number: result.trec_number,
      confidence: result.confidence,
      detected_title: result.detected_title,
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
    console.error('[detect-form-type] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not detect form type. Try again.' });
  }
};
