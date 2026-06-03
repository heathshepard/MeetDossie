// Vercel Serverless Function: /api/esign-create
// POST { documentId, signers: [{name, email, role}], message?, fields?, templateId? }
// Authorization: Bearer <supabase user JWT>
//
// Sends a PDF for e-signature via DocuSeal Cloud Pro.
// If templateId is provided, creates a submission from a template (Phase 3).
// If fields are provided, field placement coordinates are sent to DocuSeal (Phase 2).
//
// ==========================================================================
// SQL — RUN IN SUPABASE SQL EDITOR BEFORE DEPLOYING
// ==========================================================================
//
//   CREATE TABLE IF NOT EXISTS public.signature_requests (
//     id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
//     transaction_id          UUID REFERENCES public.transactions(id) ON DELETE CASCADE,
//     document_id             UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
//     signed_document_id      UUID REFERENCES public.documents(id),
//     docuseal_submission_id  TEXT NOT NULL,
//     status                  TEXT NOT NULL DEFAULT 'sent',
//     signers                 JSONB NOT NULL DEFAULT '[]',
//     message                 TEXT,
//     completed_at            TIMESTAMPTZ,
//     created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//
//   CREATE INDEX IF NOT EXISTS idx_sr_transaction ON public.signature_requests(transaction_id);
//   CREATE INDEX IF NOT EXISTS idx_sr_user       ON public.signature_requests(user_id);
//   CREATE INDEX IF NOT EXISTS idx_sr_submission ON public.signature_requests(docuseal_submission_id);
//
//   ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
//
//   CREATE POLICY "owner_read"   ON public.signature_requests FOR SELECT USING (auth.uid() = user_id);
//   CREATE POLICY "owner_insert" ON public.signature_requests FOR INSERT WITH CHECK (auth.uid() = user_id);
//   CREATE POLICY "owner_update" ON public.signature_requests FOR UPDATE USING (auth.uid() = user_id);
//   CREATE POLICY "service_all"  ON public.signature_requests FOR ALL USING (auth.role() = 'service_role');
//
// ==========================================================================

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';
const BUCKET = 'documents';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || VERCEL_PREVIEW_RE.test(origin)) {
      allowOrigin = origin;
    }
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

async function getDocumentRow(documentId, userId) {
  const res = await supa(`documents?id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,transaction_id,storage_path,file_name,document_type`);
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

// TREC 20-17 (One to Four Family Residential Contract — Resale) field placement.
// Coordinates are fractions of page dimensions (0-1). Page numbers are 1-indexed.
// Buyer initials: bottom-left of pages 1-8 (matching "Initialed for identification by Buyer" line).
// Seller initials: bottom-right of pages 1-8 (matching "and Seller" line).
// Signature block: page 9, execution section.
function buildResaleContractFields(buyerRole, sellerRole) {
  const buyerFields = [];
  const sellerFields = [];

  for (let page = 1; page <= 8; page++) {
    buyerFields.push({
      name: `Buyer Initials P${page}`,
      type: 'initials',
      areas: [{ page, x: 0.08, y: 0.94, w: 0.08, h: 0.025 }],
    });
    sellerFields.push({
      name: `Seller Initials P${page}`,
      type: 'initials',
      areas: [{ page, x: 0.65, y: 0.94, w: 0.08, h: 0.025 }],
    });
  }

  buyerFields.push(
    { name: 'Buyer Signature', type: 'signature', areas: [{ page: 9, x: 0.05, y: 0.35, w: 0.35, h: 0.04 }] },
    { name: 'Buyer Printed Name', type: 'text',      areas: [{ page: 9, x: 0.05, y: 0.42, w: 0.35, h: 0.03 }] },
    { name: 'Buyer Date',        type: 'date',       areas: [{ page: 9, x: 0.45, y: 0.35, w: 0.15, h: 0.04 }] }
  );

  sellerFields.push(
    { name: 'Seller Signature', type: 'signature', areas: [{ page: 9, x: 0.55, y: 0.35, w: 0.35, h: 0.04 }] },
    { name: 'Seller Printed Name', type: 'text',   areas: [{ page: 9, x: 0.55, y: 0.42, w: 0.35, h: 0.03 }] },
    { name: 'Seller Date',        type: 'date',    areas: [{ page: 9, x: 0.55, y: 0.50, w: 0.15, h: 0.04 }] }
  );

  return { buyerRole, sellerRole, buyerFields, sellerFields };
}

async function getTransactionRow(transactionId, userId) {
  const res = await supa(`transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,property_address,buyer_name,seller_name,sale_price,closing_date,city_state_zip`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function generateSignedUrl(storagePath, expiresIn = 300) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw new Error(`Signed URL generation failed (${res.status})`);
  const json = await res.json();
  if (!json || !json.signedURL) throw new Error('No signedURL in storage response');
  const p = json.signedURL.startsWith('/') ? json.signedURL : `/${json.signedURL}`;
  return `${SUPABASE_URL}/storage/v1${p}`;
}

async function docusealCreateFromPdf({ documentUrl, fileName, signers, message, fields, fieldMap }) {
  // TODO: Replace stub with real call once DOCUSEAL_API_KEY is added to Vercel.
  if (!DOCUSEAL_API_KEY) {
    console.warn('[esign-create] DOCUSEAL_API_KEY not set — returning stub submission.');
    return {
      id: `stub-${Date.now()}`,
      submitters: signers.map((s, i) => ({
        uuid: `stub-uuid-${i}`,
        slug: `stub-slug-${i}`,
        name: s.name,
        email: s.email,
        role: s.role || 'Signer',
        status: 'sent',
        embed_src: null,
      })),
    };
  }

  // Build submitters array for DocuSeal /submissions/pdf endpoint.
  // Priority: fieldMap[role] (pre-built per-role arrays, e.g. TREC 20-17 resale contract)
  //           > fields filtered by signerRole (caller-supplied phase-2 placements)
  //           > default auto-place (Signature + Date only).
  const submitters = signers.map((s) => {
    const role = s.role || 'Signer';

    const roleSpecificFields = fieldMap && fieldMap[role] ? fieldMap[role] : null;

    const signerFields = roleSpecificFields !== null
      ? roleSpecificFields
      : (Array.isArray(fields) ? fields.filter((f) => f.signerRole === role) : []);

    const entry = {
      name: s.name,
      email: s.email,
      role,
    };

    if (signerFields.length > 0) {
      entry.fields = signerFields.map((f) => ({
        name: f.name,
        type: f.type,
        areas: (f.areas || []).map((a) => ({
          x: a.x,
          y: a.y,
          w: a.w,
          h: a.h,
          page: a.page,
        })),
      }));
    } else {
      // Default: include a Signature and Date field with no explicit placement
      // so DocuSeal auto-places them.
      entry.fields = [
        { name: 'Signature', type: 'signature' },
        { name: 'Date', type: 'date' },
      ];
    }
    return entry;
  });

  const body = {
    send_email: false,
    documents: [{ name: fileName, file: documentUrl }],
    submitters,
  };

  const res = await fetch(`${DOCUSEAL_BASE}/submissions/pdf`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ValidationError(`DocuSeal rejected the submission (${res.status}): ${text.slice(0, 200)}`, 422);
  }

  return res.json();
}

async function docusealCreateFromTemplate({ templateId, signers, message, prefillData }) {
  // Phase 3: creates a submission from a pre-built DocuSeal template.
  // TODO: Replace stub with real call once DOCUSEAL_API_KEY is set.
  if (!DOCUSEAL_API_KEY) {
    console.warn('[esign-create] DOCUSEAL_API_KEY not set — returning stub template submission.');
    return {
      id: `stub-tmpl-${Date.now()}`,
      submitters: signers.map((s, i) => ({
        uuid: `stub-uuid-tmpl-${i}`,
        slug: `stub-slug-tmpl-${i}`,
        name: s.name,
        email: s.email,
        role: s.role || 'Signer',
        status: 'sent',
        embed_src: null,
      })),
    };
  }

  const body = {
    template_id: templateId,
    send_email: false,
    submitters: signers.map((s) => ({
      name: s.name,
      email: s.email,
      role: s.role || 'Signer',
    })),
    ...(prefillData ? { values: prefillData } : {}),
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
    throw new ValidationError(`DocuSeal template submission failed (${res.status}): ${text.slice(0, 200)}`, 422);
  }

  return res.json();
}

async function sendSigningEmail({ signerName, signerEmail, documentName, propertyAddress, signingUrl }) {
  if (!RESEND_API_KEY) {
    console.warn('[esign-create] RESEND_API_KEY not set - skipping signing email.');
    return;
  }
  if (!signingUrl) {
    console.warn(`[esign-create] No signing URL for ${signerEmail} - skipping email.`);
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
    console.error(`[esign-create] Resend error for ${signerEmail} (${r.status}): ${text.slice(0, 200)}`);
  } else {
    console.log(`[esign-create] Signing email sent to ${signerEmail}`);
  }
}

// ---------------------------------------------------------------------------
// sendForAcknowledgment — uploads scanned PDF to DocuSeal as a new template,
// then creates a submission with buyer acknowledgment fields at OP-H page 3.
// Supports 1 or 2 buyers.
// ---------------------------------------------------------------------------
async function sendForAcknowledgment({ doc, userId, transactionId, formType, buyerEmail, buyerName, buyerEmail2, buyerName2, message }) {
  if (!DOCUSEAL_API_KEY) {
    throw new ValidationError('DocuSeal not configured.', 500);
  }

  // Fetch file bytes from Supabase Storage
  const storageUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${doc.storage_path}`;
  const fileRes = await fetch(storageUrl, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!fileRes.ok) {
    throw new Error(`Storage fetch failed (${fileRes.status}) for: ${doc.storage_path}`);
  }
  const fileBuffer = await fileRes.arrayBuffer();
  const base64Pdf = Buffer.from(fileBuffer).toString('base64');

  // Upload PDF to DocuSeal to create a temporary template
  // POST /templates/pdf with base64-encoded PDF
  const tmplBody = {
    name: doc.file_name || 'Seller Disclosure Notice',
    documents: [
      {
        name: doc.file_name || 'Sellers_Disclosure_Notice.pdf',
        file: `data:application/pdf;base64,${base64Pdf}`,
      },
    ],
  };

  const tmplRes = await fetch(`${DOCUSEAL_BASE}/templates/pdf`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(tmplBody),
  });

  if (!tmplRes.ok) {
    const text = await tmplRes.text().catch(() => '');
    throw new Error(`DocuSeal template creation failed (${tmplRes.status}): ${text.slice(0, 300)}`);
  }

  const tmplData = await tmplRes.json();
  const templateId = tmplData.id;
  if (!templateId) {
    throw new Error('DocuSeal template creation did not return an id.');
  }

  // Build buyer submitters.
  // Acknowledgment fields at OP-H page 3 (0-indexed page = 2 in DocuSeal areas).
  // Coordinates provided: signature at y~0.74, date at y~0.74 right side.
  // Second buyer optional.
  function buildBuyerFields(sigY, dateY) {
    return [
      {
        name: 'Buyer Signature',
        type: 'signature',
        areas: [{ page: 3, x: 0.07, y: sigY, w: 0.25, h: 0.04 }],
      },
      {
        name: 'Buyer Date',
        type: 'date',
        areas: [{ page: 3, x: 0.73, y: dateY, w: 0.18, h: 0.03 }],
      },
    ];
  }

  const submitters = [
    {
      name: buyerName,
      email: buyerEmail,
      role: 'Buyer 1',
      fields: buildBuyerFields(0.74, 0.74),
    },
  ];

  if (buyerEmail2 && buyerName2) {
    submitters.push({
      name: buyerName2,
      email: buyerEmail2,
      role: 'Buyer 2',
      fields: buildBuyerFields(0.82, 0.82),
    });
  }

  // Create submission from the uploaded template
  const submBody = {
    template_id: templateId,
    send_email: false,
    submitters,
    ...(message ? { message } : {}),
  };

  const submRes = await fetch(`${DOCUSEAL_BASE}/submissions`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submBody),
  });

  if (!submRes.ok) {
    const text = await submRes.text().catch(() => '');
    throw new Error(`DocuSeal submission creation failed (${submRes.status}): ${text.slice(0, 300)}`);
  }

  const submData = await submRes.json();
  const submissionId = String(submData.id || '');

  // Normalise submitters from DocuSeal response
  const signerRows = (Array.isArray(submData.submitters) ? submData.submitters : []).map((sub, i) => {
    const slug = sub.slug || null;
    const signingUrl = slug ? `https://docuseal.com/s/${slug}` : (sub.embed_src || null);
    return {
      name: sub.name || submitters[i]?.name || '',
      email: sub.email || submitters[i]?.email || '',
      role: sub.role || submitters[i]?.role || 'Buyer',
      status: sub.status || 'sent',
      signingUrl,
      uuid: sub.uuid || null,
    };
  });

  return { submissionId, signerRows, templateId };
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
  const rows = await res.json();
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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[esign-create] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'esign-create', 20, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const body = req.body || {};

    // action: 'send_for_acknowledgment' — scanned Seller's Disclosure → buyer signs
    const action = sanitizeString(body.action, { maxLength: 50 }) || null;
    if (action === 'send_for_acknowledgment') {
      const documentId = sanitizeString(body.document_id, { maxLength: 200 });
      const formType = sanitizeString(body.form_type, { maxLength: 100 }) || 'sellers_disclosure';
      const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 }) || null;
      const buyerEmail = sanitizeString(body.buyer_email, { maxLength: 200 });
      const buyerName = sanitizeString(body.buyer_name, { maxLength: 200 });
      const buyerEmail2 = sanitizeString(body.buyer_email_2, { maxLength: 200 }) || null;
      const buyerName2 = sanitizeString(body.buyer_name_2, { maxLength: 200 }) || null;
      const ackMessage = sanitizeString(body.message, { maxLength: 1000 }) || null;

      if (!documentId) throw new ValidationError('document_id is required for send_for_acknowledgment.');
      if (!buyerEmail || !buyerEmail.includes('@')) throw new ValidationError('buyer_email must be a valid email address.');
      if (!buyerName) throw new ValidationError('buyer_name is required.');
      if (buyerEmail2 && !buyerEmail2.includes('@')) throw new ValidationError('buyer_email_2 must be a valid email address.');
      if (buyerEmail2 && !buyerName2) throw new ValidationError('buyer_name_2 is required when buyer_email_2 is provided.');

      const doc = await getDocumentRow(documentId, userId);

      if (!doc.storage_path) {
        throw new ValidationError('Document has no storage path — cannot send for acknowledgment.', 422);
      }

      const { submissionId, signerRows, templateId: createdTemplateId } = await sendForAcknowledgment({
        doc,
        userId,
        transactionId: transactionId || doc.transaction_id || null,
        formType,
        buyerEmail,
        buyerName,
        buyerEmail2,
        buyerName2,
        message: ackMessage,
      });

      const txId = transactionId || doc.transaction_id || null;
      const tx = txId ? await getTransactionRow(txId, userId) : null;
      const propertyAddress = tx ? (tx.property_address || '') : '';

      // Send signing emails via Resend
      await Promise.all(
        signerRows.map((s) =>
          sendSigningEmail({
            signerName: s.name,
            signerEmail: s.email,
            documentName: doc.file_name || 'Seller\'s Disclosure Notice',
            propertyAddress,
            signingUrl: s.signingUrl,
          }).catch((err) => {
            console.error(`[esign-create] ack email failed for ${s.email}:`, err && err.message ? err.message : err);
          })
        )
      );

      const inserted = await insertSignatureRequest({
        user_id: userId,
        transaction_id: txId,
        document_id: documentId,
        docuseal_submission_id: submissionId,
        status: 'sent',
        signers: signerRows,
        message: ackMessage || null,
      });

      // Update documents row with DocuSeal submission ID for tracking
      if (submissionId) {
        await supa(
          `documents?id=eq.${encodeURIComponent(documentId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ docuseal_submission_id: submissionId }),
            headers: { Prefer: 'return=minimal' },
          }
        ).catch((e) => {
          console.warn('[esign-create] documents patch for submission_id failed:', e && e.message ? e.message : e);
        });
      }

      return res.status(200).json({
        ok: true,
        submissionId,
        signatureRequestId: inserted?.id || null,
        signers: signerRows,
        docusealTemplateId: createdTemplateId,
      });
    }

    const documentId = sanitizeString(body.documentId, { maxLength: 200 });
    const templateId = sanitizeString(body.templateId, { maxLength: 200 }) || null;
    const message = sanitizeString(body.message, { maxLength: 1000 }) || null;
    const signers = Array.isArray(body.signers) ? body.signers : [];
    const fields = Array.isArray(body.fields) ? body.fields : null;
    // Phase 3: pre-fill data for template submissions
    const prefillData = (body.prefillData && typeof body.prefillData === 'object') ? body.prefillData : null;

    // Agent-as-final-signer fields
    const agentSignerEmail = sanitizeString(body.agentSignerEmail, { maxLength: 200 }) || null;
    const agentSignerName = sanitizeString(body.agentSignerName, { maxLength: 200 }) || 'Agent';

    // Seller's agent fields (stored on the signature_requests row; used by webhook on completion)
    const sellerAgentName = sanitizeString(body.sellerAgentName, { maxLength: 200 }) || null;
    const sellerAgentEmail = sanitizeString(body.sellerAgentEmail, { maxLength: 200 }) || null;

    if (!documentId) {
      throw new ValidationError('documentId is required.');
    }
    if (signers.length === 0) {
      throw new ValidationError('At least one signer is required.');
    }
    for (const s of signers) {
      if (!s.name || typeof s.name !== 'string' || !s.name.trim()) {
        throw new ValidationError('Each signer must have a name.');
      }
      if (!s.email || typeof s.email !== 'string' || !s.email.includes('@')) {
        throw new ValidationError(`Signer "${s.name}" must have a valid email address.`);
      }
    }
    if (agentSignerEmail && !agentSignerEmail.includes('@')) {
      throw new ValidationError('agentSignerEmail must be a valid email address.');
    }
    if (sellerAgentEmail && !sellerAgentEmail.includes('@')) {
      throw new ValidationError('sellerAgentEmail must be a valid email address.');
    }

    // Fetch the document (verifies ownership).
    const doc = await getDocumentRow(documentId, userId);
    const fileName = doc.file_name || 'Document.pdf';
    const transactionId = doc.transaction_id || null;

    // Fetch the transaction so we have property_address for both email subjects
    // and template prefill. Non-fatal if missing.
    const tx = transactionId ? await getTransactionRow(transactionId, userId) : null;
    const propertyAddress = tx ? (tx.property_address || '') : '';

    // Build the full ordered signers list.
    // If agentSignerEmail is provided, append the agent as the last signer so
    // DocuSeal routes sequentially: buyers first, then agent.
    const allSigners = agentSignerEmail
      ? [
          ...signers,
          { name: agentSignerName, email: agentSignerEmail, role: 'Agent' },
        ]
      : signers;

    let submissionResult;

    if (templateId) {
      // Phase 3 path — template-based submission with optional pre-fill.
      let prefill = prefillData || {};
      if (tx) {
        // Merge known transaction fields as pre-fill defaults.
        prefill = {
          property_address: tx.property_address || '',
          buyer_name: tx.buyer_name || '',
          seller_name: tx.seller_name || '',
          purchase_price: tx.sale_price ? String(tx.sale_price) : '',
          closing_date: tx.closing_date || '',
          ...prefill,
        };
      }
      submissionResult = await docusealCreateFromTemplate({ templateId, signers: allSigners, message, prefillData: prefill });
    } else {
      // Phase 1 path — direct PDF submission.
      // Generate a 5-minute signed URL so DocuSeal can pull the PDF.
      const signedUrl = await generateSignedUrl(doc.storage_path, 300);

      // Auto-apply TREC 20-17 field placements when the document is a resale contract
      // and the caller has not provided their own explicit field placements.
      // Determine buyer/seller roles from the signers list: first non-Agent signer with
      // role 'Buyer' maps to buyerRole; first with role 'Seller' maps to sellerRole.
      // Falls back to positional order if roles are not explicitly set.
      let autoFieldMap = null;
      if (!fields && doc.document_type === 'resale_contract') {
        const buyerSigner = allSigners.find((s) => (s.role || '').toLowerCase() === 'buyer')
          || allSigners.find((s) => (s.role || '').toLowerCase() !== 'seller' && (s.role || '').toLowerCase() !== 'agent');
        const sellerSigner = allSigners.find((s) => (s.role || '').toLowerCase() === 'seller');

        if (buyerSigner && sellerSigner) {
          const { buyerRole, sellerRole, buyerFields, sellerFields } = buildResaleContractFields(
            buyerSigner.role || 'Buyer',
            sellerSigner.role || 'Seller'
          );
          autoFieldMap = {
            [buyerRole]: buyerFields,
            [sellerRole]: sellerFields,
          };
        }
      }

      submissionResult = await docusealCreateFromPdf({
        documentUrl: signedUrl,
        fileName,
        signers: allSigners,
        message,
        fields,
        fieldMap: autoFieldMap,
      });
    }

    const submissionId = String(submissionResult.id || '');

    // Normalise signer list from DocuSeal response.
    // allSigners is the source of truth for name/email/role if DocuSeal omits them.
    // Signing URL: prefer slug-based public link (https://docuseal.com/s/{slug}) over embed_src.
    const signerRows = (Array.isArray(submissionResult.submitters) ? submissionResult.submitters : []).map((sub, i) => {
      const slug = sub.slug || null;
      const signingUrl = slug
        ? `https://docuseal.com/s/${slug}`
        : (sub.embed_src || null);
      return {
        name: sub.name || allSigners[i]?.name || '',
        email: sub.email || allSigners[i]?.email || '',
        role: sub.role || allSigners[i]?.role || 'Signer',
        status: sub.status || 'sent',
        signingUrl,
        uuid: sub.uuid || null,
      };
    });

    // Send Dossie-branded signing emails via Resend.
    // Fire-and-forget per signer — a single email failure must not abort the submission.
    // Skip the agent signer (agentSignerEmail) — only external signers get notified here.
    await Promise.all(
      signerRows
        .filter((s) => s.email && s.email !== agentSignerEmail)
        .map((s) =>
          sendSigningEmail({
            signerName: s.name,
            signerEmail: s.email,
            documentName: fileName,
            propertyAddress,
            signingUrl: s.signingUrl,
          }).catch((err) => {
            console.error(`[esign-create] sendSigningEmail failed for ${s.email}:`, err && err.message ? err.message : err);
          })
        )
    );

    // Persist the signature request.
    // seller_agent_name / seller_agent_email are stored here so the webhook can
    // send the executed PDF to the seller's agent when all parties have signed.
    const inserted = await insertSignatureRequest({
      user_id: userId,
      transaction_id: transactionId,
      document_id: documentId,
      docuseal_submission_id: submissionId,
      status: 'sent',
      signers: signerRows,
      message: message || null,
      ...(sellerAgentName ? { seller_agent_name: sellerAgentName } : {}),
      ...(sellerAgentEmail ? { seller_agent_email: sellerAgentEmail } : {}),
    });

    return res.status(200).json({
      ok: true,
      submissionId,
      signatureRequestId: inserted?.id || null,
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
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[esign-create] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not send document for signature. Try again.' });
  }
};

