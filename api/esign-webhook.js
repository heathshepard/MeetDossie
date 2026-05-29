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
    // If secret not set yet, log and pass through (allows testing without secret).
    console.warn('[esign-webhook] DOCUSEAL_WEBHOOK_SECRET not set — skipping HMAC verification.');
    return true;
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
async function sendSellerAgentEmail(sellerAgentEmail, sellerAgentName, fileName, pdfBuffer, propertyAddress) {
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
        from: 'Dossie <heath@meetdossie.com>',
        to: [sellerAgentEmail],
        subject,
        html: `
          <p>Hi ${sellerAgentName || 'there'},</p>
          <p>Please find the fully executed purchase contract attached. All parties have signed.</p>
          <p>Sent via <strong>DossieSign</strong> &mdash; transaction management for Texas REALTORS.</p>
          <p style="color:#888;font-size:12px;">Dossie &mdash; Your deals. Her job.</p>
        `,
        attachments: [
          {
            filename: fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`,
            content: base64Pdf,
          },
        ],
      }),
    });
    console.log(`[esign-webhook] Seller agent email sent to ${sellerAgentEmail}`);
  } catch (err) {
    console.error('[esign-webhook] Seller agent Resend email failed:', err && err.message);
  }
}

async function sendCompletionEmail(agentEmail, agentName, fileName) {
  if (!RESEND_API_KEY || !agentEmail) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Dossie <heath@meetdossie.com>',
        to: [agentEmail],
        subject: `All signatures complete: ${fileName}`,
        html: `
          <p>Hi ${agentName || 'there'},</p>
          <p>All parties have signed <strong>${fileName}</strong>. The signed copy has been saved to your Dossie document library.</p>
          <p>Log in to download or share the signed document: <a href="https://meetdossie.com/app">meetdossie.com/app</a></p>
          <p style="color:#888;font-size:12px;">Dossie &mdash; Your deals. Her job.</p>
        `,
      }),
    });
  } catch (err) {
    console.error('[esign-webhook] Resend email failed:', err && err.message);
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

      // Send agent email notification.
      const agentInfo = await fetchAgentEmailForUser(sr.user_id);
      await sendCompletionEmail(agentInfo?.email, agentInfo?.full_name, fileName);

      // If a seller's agent email is on the signature request, send them the executed PDF.
      if (sr.seller_agent_email && signedPdfBuffer) {
        await sendSellerAgentEmail(
          sr.seller_agent_email,
          sr.seller_agent_name || null,
          fileName,
          signedPdfBuffer,
          propertyAddress
        );
      } else if (sr.seller_agent_email && !signedPdfBuffer) {
        // DOCUSEAL_API_KEY not set or PDF fetch failed — log so we know to retry.
        console.warn(`[esign-webhook] seller_agent_email set (${sr.seller_agent_email}) but could not fetch signed PDF buffer — skipping seller email.`);
      }

      // Telegram notification.
      await sendTelegramNotification(fileName);
    }

    res.status(200).json({ ok: true, allSigned });
    return;
  }

  // Unknown event type — ack so DocuSeal does not retry.
  res.status(200).json({ ok: true, note: `unhandled event type: ${eventType}` });
};
