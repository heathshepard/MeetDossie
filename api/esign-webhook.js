// Vercel Serverless Function: /api/esign-webhook
// POST — DocuSeal webhook receiver (no Supabase JWT; HMAC-SHA256 verified instead)
//
// Configure in DocuSeal dashboard:
//   URL:    https://meetdossie.com/api/esign-webhook
//   Secret: value of DOCUSEAL_WEBHOOK_SECRET env var
//   Events: form.viewed, form.started, form.completed
//
// DocuSeal webhook docs: https://www.docuseal.com/docs/api#webhooks
//
// Env vars required:
//   DOCUSEAL_WEBHOOK_SECRET   — HMAC signing secret set in DocuSeal dashboard
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DOCUSEAL_WEBHOOK_SECRET = process.env.DOCUSEAL_WEBHOOK_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DOCUSEAL_BASE = 'https://api.docuseal.com';
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const BUCKET = 'documents';

// DocuSeal needs the raw body bytes for HMAC verification, which Vercel's default
// body parser destroys. This config disables body parsing for this route so we
// can read raw bytes.
module.exports.config = { api: { bodyParser: false } };

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

// Read raw request body as a Buffer (works with Vercel bodyParser: false).
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Verify HMAC-SHA256 signature from DocuSeal.
// DocuSeal sends: X-Docuseal-Signature: <timestamp>.<sha256>
// The sha256 is HMAC-SHA256("<timestamp>.<rawBody>", DOCUSEAL_WEBHOOK_SECRET) in hex.
// We also enforce a 5-minute replay-attack window.
function verifyDocusealSignature(rawBody, signatureHeader) {
  if (!DOCUSEAL_WEBHOOK_SECRET) {
    // Fail closed (Atlas 2026-06-10) — previous behavior passed through
    // unauthenticated webhooks when the secret was unset. In production
    // this means an attacker could forge envelope-completed events and
    // poison signed-document state. Refuse to verify rather than skip.
    console.error('[esign-webhook] DOCUSEAL_WEBHOOK_SECRET not set — refusing webhook.');
    return false;
  }
  if (!signatureHeader) {
    console.warn('[esign-webhook] Missing x-docuseal-signature header.');
    return false;
  }

  // Header format: "<timestamp>.<sha256hex>"
  const dotIndex = signatureHeader.indexOf('.');
  if (dotIndex === -1) {
    console.warn('[esign-webhook] x-docuseal-signature has unexpected format (no dot separator).');
    return false;
  }
  const timestamp = signatureHeader.slice(0, dotIndex);
  const receivedHex = signatureHeader.slice(dotIndex + 1);

  // Replay-attack guard: reject webhooks older than 5 minutes.
  const tsSeconds = parseInt(timestamp, 10);
  if (!tsSeconds || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    console.warn('[esign-webhook] Webhook timestamp outside 5-minute window — possible replay attack.');
    return false;
  }

  // Compute expected HMAC over "<timestamp>.<rawBody>".
  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', DOCUSEAL_WEBHOOK_SECRET)
    .update(signedPayload)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks.
  // Both buffers must be the same length (hex strings of the same digest are always 64 chars).
  const sigBuf = Buffer.from(receivedHex.padEnd(64, '0'), 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

async function fetchSignatureRequest(submissionId) {
  const res = await supa(
    `signature_requests?docuseal_submission_id=eq.${encodeURIComponent(submissionId)}&select=*&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function updateSignerStatus(srId, email, newStatus, currentSigners) {
  const updated = (Array.isArray(currentSigners) ? currentSigners : []).map((s) =>
    s.email === email ? { ...s, status: newStatus } : s
  );
  const res = await supa(
    `signature_requests?id=eq.${encodeURIComponent(srId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ signers: updated, updated_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[esign-webhook] updateSignerStatus failed:', res.status, text.slice(0, 200));
  }
  return updated;
}

async function markRequestCompleted(srId, signedDocumentId) {
  const patch = {
    status: 'completed',
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(signedDocumentId ? { signed_document_id: signedDocumentId } : {}),
  };
  await supa(`signature_requests?id=eq.${encodeURIComponent(srId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

async function fetchAgentEmailForUser(userId) {
  const res = await supa(`profiles?id=eq.${encodeURIComponent(userId)}&select=email,full_name&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Fetch the original document row so we know the fileName.
async function fetchDocumentRow(documentId) {
  const res = await supa(`documents?id=eq.${encodeURIComponent(documentId)}&select=id,file_name,transaction_id,user_id&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Download signed PDF from DocuSeal and store in Supabase Storage.
// Returns the new document row id, or null on error.
async function downloadAndStoreSigned(sr, fileName) {
  if (!DOCUSEAL_API_KEY) {
    console.warn('[esign-webhook] DOCUSEAL_API_KEY not set — cannot download signed PDF.');
    return null;
  }

  // Fetch submission details from DocuSeal to get the signed document URL.
  const detailRes = await fetch(`${DOCUSEAL_BASE}/submissions/${encodeURIComponent(sr.docuseal_submission_id)}`, {
    headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
  });
  if (!detailRes.ok) {
    console.error('[esign-webhook] DocuSeal submission fetch failed:', detailRes.status);
    return null;
  }
  const submission = await detailRes.json().catch(() => null);
  const signedUrl = submission?.documents?.[0]?.url;
  if (!signedUrl) {
    console.error('[esign-webhook] No signed document URL in submission:', JSON.stringify(submission || {}).slice(0, 300));
    return null;
  }

  // Download the signed PDF bytes.
  const pdfRes = await fetch(signedUrl);
  if (!pdfRes.ok) {
    console.error('[esign-webhook] Failed to download signed PDF:', pdfRes.status);
    return null;
  }
  const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());

  // Build storage path: {userId}/{transactionId}/signed-{ts}-{originalFileName}
  const ts = Date.now();
  const safeName = fileName.replace(/[^A-Za-z0-9._\-\s()]/g, '_');
  const storagePath = `${sr.user_id}/${sr.transaction_id || 'no-transaction'}/signed-${ts}-${safeName}`;

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'false',
    },
    body: pdfBuffer,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    console.error('[esign-webhook] Storage upload failed:', uploadRes.status, text.slice(0, 200));
    return null;
  }

  // Insert documents row for the signed PDF.
  const docRes = await supa('documents', {
    method: 'POST',
    body: JSON.stringify({
      transaction_id: sr.transaction_id || null,
      user_id: sr.user_id,
      file_name: `signed-${safeName}`,
      file_type: 'application/pdf',
      document_type: 'signed',
      storage_path: storagePath,
      file_size: pdfBuffer.length,
    }),
  });
  if (!docRes.ok) {
    console.error('[esign-webhook] documents insert for signed PDF failed:', docRes.status);
    return null;
  }
  const docRows = await docRes.json().catch(() => []);
  const newDoc = Array.isArray(docRows) ? docRows[0] : docRows;
  return newDoc?.id || null;
}

// Email the seller's agent the fully executed PDF as an attachment.
// dossieUserEmail is the transaction owner's email (from profiles) — used as reply_to
// so the seller's agent can reply directly to the Dossie user who initiated the signing.
async function sendSellerAgentEmail(sellerAgentEmail, sellerAgentName, fileName, pdfBuffer, propertyAddress, dossieUserEmail) {
  if (!RESEND_API_KEY || !sellerAgentEmail) return;
  try {
    const base64Pdf = pdfBuffer.toString('base64');
    const subject = propertyAddress
      ? `Executed contract: ${propertyAddress}`
      : `Executed contract: ${fileName}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Dossie <dossie@meetdossie.com>',
        to: [sellerAgentEmail],
        ...(dossieUserEmail ? { reply_to: dossieUserEmail } : {}),
        subject,
        html: `
          <p>Hi ${sellerAgentName || 'there'},</p>
          <p>Please find the fully executed purchase contract attached. All parties have signed.</p>
          <p>Sent via <strong>DossieSign</strong> - transaction management for Texas REALTORS.</p>
          <p style="color:#888;font-size:12px;">Dossie - Your deals. Her job.</p>
        `,
        attachments: [
          {
            filename: fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`,
            content: base64Pdf,
          },
        ],
        // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
      }),
    });
    console.log(`[esign-webhook] Seller agent email sent to ${sellerAgentEmail}`);
  } catch (err) {
    console.error('[esign-webhook] Seller agent Resend email failed:', err && err.message);
  }
}

// 2026-07-06 ATLAS — Dossie-branded post-sign email to each signer.
// Replaces DocuSeal's default documents_copy_email (impersonal, wrong sender,
// broken sandbox download link). Attaches the signed PDF directly so no
// external link is needed. If the signer email matches a Dossie profile,
// links to their workspace; otherwise emits a plain closing line.
async function sendSignerCompletionEmail({ signerName, signerEmail, fileName, pdfBuffer, propertyAddress, dossieUserEmail }) {
  if (!RESEND_API_KEY) {
    console.warn('[esign-webhook] RESEND_API_KEY not set — skipping signer completion email.');
    return;
  }
  if (!signerEmail || !signerEmail.includes('@')) {
    console.warn(`[esign-webhook] Invalid signer email "${signerEmail}" — skipping completion email.`);
    return;
  }
  if (!pdfBuffer) {
    console.warn(`[esign-webhook] No PDF buffer for ${signerEmail} — sending completion email without attachment.`);
  }

  const firstName = String(signerName || '').trim().split(/\s+/)[0] || 'there';
  const contractLabel = propertyAddress
    ? `contract for ${propertyAddress}`
    : (fileName || 'contract');
  const subjectLabel = propertyAddress ? propertyAddress : (fileName || 'your contract');
  const subject = `Your signed contract - ${subjectLabel}`;
  const attachmentName = (fileName || 'signed-contract.pdf').endsWith('.pdf')
    ? (fileName || 'signed-contract.pdf')
    : `${fileName || 'signed-contract'}.pdf`;

  // Warm, on-brand HTML mirroring the Dossie signing-invite email style.
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
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Thanks for reviewing and signing the ${contractLabel}.</p>
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Your signed copy is attached to this email for your records. Everything's on file, and your agent will follow up with next steps.</p>
          <p style="margin:0 0 24px;font-size:16px;color:#333;">If you need help finding this later, just reply to this email and your agent can send it again.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:0 0 20px;">
          <p style="margin:0 0 8px;font-size:14px;color:#555;">Warmly,</p>
          <p style="margin:0 0 20px;font-size:14px;color:#555;">Dossie</p>
          <p style="margin:0;font-size:12px;color:#aaa;">Dossie - Your deals. Her job. Transaction management for Texas REALTORS.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const body = {
    from: 'Dossie <sign@meetdossie.com>',
    to: [signerEmail],
    ...(dossieUserEmail && dossieUserEmail !== signerEmail ? { reply_to: dossieUserEmail } : {}),
    subject,
    html,
  };
  if (pdfBuffer) {
    body.attachments = [{ filename: attachmentName, content: pdfBuffer.toString('base64') }];
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error(`[esign-webhook] Signer completion email failed for ${signerEmail} (${r.status}): ${text.slice(0, 200)}`);
      return null;
    }
    const j = await r.json().catch(() => ({}));
    console.log(`[esign-webhook] Signer completion email sent to ${signerEmail} (resend id: ${j?.id || 'unknown'})`);
    return j?.id || null;
  } catch (err) {
    console.error(`[esign-webhook] Signer completion Resend threw for ${signerEmail}:`, err && err.message);
    return null;
  }
}

// 2026-07-06 ATLAS — Dossie-branded "Contract executed" email to the transaction
// OWNER (the agent). Fires unconditionally on form.completed once all signers are
// done, INCLUDING when the agent is also the last signer (the previous
// sendCompletionEmail path skipped the owner entirely because it was in the signer
// loop). Attaches the fully-signed PDF so the agent can forward to title / other
// side of the transaction without logging in. Idempotency is gated in the caller
// via signature_requests.owner_notified_at.
async function sendAgentExecutedEmail({ agentEmail, agentName, fileName, pdfBuffer, propertyAddress }) {
  if (!RESEND_API_KEY) {
    console.warn('[esign-webhook] RESEND_API_KEY not set — skipping agent executed email.');
    return null;
  }
  if (!agentEmail || !agentEmail.includes('@')) {
    console.warn(`[esign-webhook] Invalid agent email "${agentEmail}" — skipping agent executed email.`);
    return null;
  }

  const firstName = String(agentName || '').trim().split(/\s+/)[0] || 'there';
  const subjectLabel = propertyAddress ? propertyAddress : (fileName || 'your contract');
  const subject = `Contract executed - ${subjectLabel}`;
  const contractLabel = propertyAddress
    ? `contract for ${propertyAddress}`
    : (fileName || 'contract');
  const attachmentName = (fileName || 'signed-contract.pdf').endsWith('.pdf')
    ? (fileName || 'signed-contract.pdf')
    : `${fileName || 'signed-contract'}.pdf`;

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
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Hi ${firstName},</p>
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Great news &mdash; the ${contractLabel} is fully executed. Every signature is in and the signed copy is attached.</p>
          <p style="margin:0 0 24px;font-size:16px;color:#333;">You're all set to forward it to the title company (and the other side of the transaction, if applicable).</p>
          <hr style="border:none;border-top:1px solid #eee;margin:0 0 20px;">
          <p style="margin:0 0 8px;font-size:14px;color:#555;">Warmly,</p>
          <p style="margin:0 0 20px;font-size:14px;color:#555;">Dossie</p>
          <p style="margin:0;font-size:12px;color:#aaa;">Dossie - Your deals. Her job. Transaction management for Texas REALTORS.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const body = {
    from: 'Dossie <sign@meetdossie.com>',
    to: [agentEmail],
    reply_to: 'heath@meetdossie.com',
    subject,
    html,
  };
  if (pdfBuffer) {
    body.attachments = [{ filename: attachmentName, content: pdfBuffer.toString('base64') }];
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error(`[esign-webhook] Agent executed email failed for ${agentEmail} (${r.status}): ${text.slice(0, 200)}`);
      return null;
    }
    const j = await r.json().catch(() => ({}));
    console.log(`[esign-webhook] Agent executed email sent to ${agentEmail} (resend id: ${j?.id || 'unknown'})`);
    return j?.id || null;
  } catch (err) {
    console.error(`[esign-webhook] Agent executed Resend threw for ${agentEmail}:`, err && err.message);
    return null;
  }
}

async function sendTelegramNotification(fileName) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `All signers complete on: ${fileName} - signed copy saved to Dossie.`,
      }),
    });
  } catch (err) {
    console.error('[esign-webhook] Telegram notification failed:', err && err.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  // Read raw body before any parsing.
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[esign-webhook] Failed to read request body:', err && err.message);
    res.status(400).json({ ok: false, error: 'Could not read request body.' });
    return;
  }

  // Verify HMAC signature.
  const sigHeader = req.headers['x-docuseal-signature'] || '';
  if (!verifyDocusealSignature(rawBody, sigHeader)) {
    console.warn('[esign-webhook] HMAC verification failed — rejecting webhook.');
    res.status(401).json({ ok: false, error: 'Invalid signature.' });
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[esign-webhook] Failed to parse JSON body:', err && err.message);
    res.status(400).json({ ok: false, error: 'Invalid JSON.' });
    return;
  }

  const eventType = event.event_type || event.type || '';
  const submitter = event.data || {};
  const submission = submitter.submission || submitter || {};
  const submissionId = String(submission.id || submitter.submission_id || '');
  const signerEmail = submitter.email || submitter.submitter?.email || '';

  console.log(`[esign-webhook] event="${eventType}" submission="${submissionId}" signer="${signerEmail}"`);

  if (!submissionId) {
    // Unknown event shape — ack and move on.
    res.status(200).json({ ok: true, note: 'no submission id found' });
    return;
  }

  // Look up our signature request record.
  const sr = await fetchSignatureRequest(submissionId);
  if (!sr) {
    console.warn(`[esign-webhook] No signature_request found for submission ${submissionId}`);
    // Still 200 so DocuSeal does not keep retrying for an unknown submission.
    res.status(200).json({ ok: true, note: 'submission not tracked' });
    return;
  }

  // Handle event types.
  if (eventType === 'form.viewed') {
    await updateSignerStatus(sr.id, signerEmail, 'viewed', sr.signers);
    res.status(200).json({ ok: true });
    return;
  }

  if (eventType === 'form.started') {
    await updateSignerStatus(sr.id, signerEmail, 'in_progress', sr.signers);
    res.status(200).json({ ok: true });
    return;
  }

  if (eventType === 'form.completed') {
    const updatedSigners = await updateSignerStatus(sr.id, signerEmail, 'signed', sr.signers);

    // Check if ALL signers have now signed.
    const allSigned = updatedSigners.every((s) => s.status === 'signed');

    if (allSigned) {
      // Fetch document name for notifications.
      const docRow = await fetchDocumentRow(sr.document_id);
      const fileName = docRow?.file_name || 'Document.pdf';

      // Fetch property address for seller agent email subject line (best-effort).
      let propertyAddress = null;
      if (sr.transaction_id) {
        try {
          const txRes = await supa(`transactions?id=eq.${encodeURIComponent(sr.transaction_id)}&select=property_address&limit=1`);
          if (txRes.ok) {
            const txRows = await txRes.json().catch(() => []);
            propertyAddress = (Array.isArray(txRows) && txRows[0]?.property_address) ? txRows[0].property_address : null;
          }
        } catch (_) { /* non-fatal */ }
      }

      // Download the signed PDF and store it back in Supabase.
      // We also capture the raw PDF buffer so we can email it to the seller's agent.
      let signedDocId = null;
      let signedPdfBuffer = null;

      if (DOCUSEAL_API_KEY) {
        try {
          // Fetch submission details to get the signed document URL.
          const detailRes = await fetch(`${DOCUSEAL_BASE}/submissions/${encodeURIComponent(sr.docuseal_submission_id)}`, {
            headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
          });
          if (detailRes.ok) {
            const submission = await detailRes.json().catch(() => null);
            const signedUrl = submission?.documents?.[0]?.url;
            if (signedUrl) {
              const pdfRes = await fetch(signedUrl);
              if (pdfRes.ok) {
                signedPdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
              }
            }
          }
        } catch (err) {
          console.error('[esign-webhook] Error fetching signed PDF for seller agent email:', err && err.message);
        }
      }

      // Use the existing downloadAndStoreSigned path for storage + documents row.
      signedDocId = await downloadAndStoreSigned(sr, fileName);

      // Mark the request completed.
      await markRequestCompleted(sr.id, signedDocId);

      // Fetch the Dossie user's profile (transaction owner) for notifications + reply_to.
      const dossieUser = await fetchAgentEmailForUser(sr.user_id);

      // 2026-07-06 ATLAS v3 — Send the transaction OWNER (agent) a Dossie-branded
      // "Contract executed" email with the signed PDF attached. Idempotent via
      // signature_requests.owner_notified_at so webhook retries don't double-send.
      // Previously sendCompletionEmail() was plain, had no attachment, AND was
      // skipped if the agent was also a signer — which is the common real-estate
      // case. Now fires unconditionally against the owner profile.
      if (!sr.owner_notified_at && dossieUser?.email) {
        const resendId = await sendAgentExecutedEmail({
          agentEmail: dossieUser.email,
          agentName: dossieUser.full_name,
          fileName,
          pdfBuffer: signedPdfBuffer,
          propertyAddress,
        });
        if (resendId) {
          // Stamp the timestamp so a webhook retry (DocuSeal retries on non-2xx)
          // won't re-fire. Best-effort — non-fatal if the update fails.
          try {
            const stampRes = await supa(
              `signature_requests?id=eq.${encodeURIComponent(sr.id)}`,
              {
                method: 'PATCH',
                body: JSON.stringify({ owner_notified_at: new Date().toISOString() }),
                headers: { Prefer: 'return=minimal' },
              }
            );
            if (!stampRes.ok) {
              const text = await stampRes.text().catch(() => '');
              console.warn('[esign-webhook] owner_notified_at stamp failed:', stampRes.status, text.slice(0, 200));
            }
          } catch (err) {
            console.warn('[esign-webhook] owner_notified_at stamp threw (non-fatal):', err && err.message);
          }
        }
      } else if (sr.owner_notified_at) {
        console.log(`[esign-webhook] owner already notified at ${sr.owner_notified_at} for sr ${sr.id} — skipping duplicate.`);
      }

      // 2026-07-06 ATLAS — Dossie-branded post-sign email to each signer with
      // the executed PDF attached. Replaces DocuSeal's default documents_copy_email
      // (which was showing the account owner's name as sender and a 404 sandbox link).
      // DocuSeal's default is now suppressed via template preferences set at
      // creation/clone time in api/esign-create.js.
      //
      // Skip the transaction owner's own email if it's in the signer list — the
      // owner just received the "Contract executed" email above, so a duplicate
      // "Your signed contract" here would be redundant.
      const signersForEmail = Array.isArray(sr.signers) ? sr.signers : [];
      if (signersForEmail.length > 0) {
        await Promise.all(
          signersForEmail
            .filter((s) => s && s.email && s.email !== dossieUser?.email)
            .map((s) =>
              sendSignerCompletionEmail({
                signerName: s.name || '',
                signerEmail: s.email,
                fileName,
                pdfBuffer: signedPdfBuffer,
                propertyAddress,
                dossieUserEmail: dossieUser?.email || null,
              }).catch((err) => {
                console.error(`[esign-webhook] Signer completion email failed for ${s.email}:`, err && err.message);
              })
            )
        );
      }

      // If a seller's agent email is on the signature request, send them the executed PDF.
      // reply_to is set to the Dossie user's own email so the seller's agent can reply directly to them.
      if (sr.seller_agent_email && signedPdfBuffer) {
        await sendSellerAgentEmail(
          sr.seller_agent_email,
          sr.seller_agent_name || null,
          fileName,
          signedPdfBuffer,
          propertyAddress,
          dossieUser?.email || null
        );
      } else if (sr.seller_agent_email && !signedPdfBuffer) {
        console.warn(`[esign-webhook] seller_agent_email set (${sr.seller_agent_email}) but could not fetch signed PDF buffer — skipping seller email.`);
      }

      // Telegram notification.
      await sendTelegramNotification(fileName);

      // If the completed document is a wire fraud warning, mark it acknowledged.
      if (docRow && docRow.id) {
        try {
          const docTypeRes = await supa(
            `documents?id=eq.${encodeURIComponent(docRow.id)}&select=document_type&limit=1`,
            { headers: { Prefer: '' } }
          );
          if (docTypeRes.ok) {
            const docTypeRows = await docTypeRes.json().catch(() => []);
            const docType = Array.isArray(docTypeRows) && docTypeRows[0] ? docTypeRows[0].document_type : null;
            if (docType === 'wire_fraud_warning') {
              const ackRes = await supa(
                `wire_fraud_deliveries?document_id=eq.${encodeURIComponent(docRow.id)}`,
                {
                  method: 'PATCH',
                  body: JSON.stringify({ acknowledged_at: new Date().toISOString() }),
                  headers: { Prefer: 'return=minimal' },
                }
              );
              if (!ackRes.ok) {
                const ackText = await ackRes.text().catch(() => '');
                console.warn('[esign-webhook] wire_fraud_deliveries ack update failed:', ackRes.status, ackText.slice(0, 200));
              } else {
                console.log('[esign-webhook] wire fraud warning acknowledged for document', docRow.id);
              }
            }
          }
        } catch (err) {
          console.error('[esign-webhook] wire fraud ack error (non-fatal):', err && err.message);
        }
      }
    }

    res.status(200).json({ ok: true, allSigned });
    return;
  }

  // Unknown event type — ack so DocuSeal does not retry.
  res.status(200).json({ ok: true, note: `unhandled event type: ${eventType}` });
};
