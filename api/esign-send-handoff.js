// Vercel Serverless Function: /api/esign-send-handoff
// =============================================================================
// Sends an executed document to the counterparty agent — ONLY with the exact
// wording the agent approved, and ONLY if the signatures actually verified.
//
// THREE GATES, all required:
//   1. `confirmed: true` must be present. No implicit sends.
//   2. `subject` and `body` come from the request — the wording the human saw
//      and approved. This endpoint never generates copy of its own.
//   3. The document's verification verdict must be 'signed'. A blank or
//      unverified "completed" document is refused with 409, because forwarding
//      one is the precise failure this workflow exists to prevent.
//
// Contrast with api/esign-webhook.js, which auto-emails the executed contract
// to the seller's agent with no human in the loop. That predates this rule.
// This path does not inherit that behaviour.
//
// After a successful send it records the send in esign_events.verification
// (sentTo/sentAt) so "did this actually go out" is answerable from the record
// rather than assumed — the same reason Heath checks his sent folder by hand.
//
// POST {
//   eventId | documentId,
//   to, subject, body,      // EXACT approved wording
//   confirmed: true
// }
// Authorization: Bearer <supabase user JWT>
//
// Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION)
// =============================================================================

'use strict';

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function sb(pathAndQuery, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function downloadFromStorage(storagePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/documents/${storagePath}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

function isEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let userId;
  try {
    ({ userId } = await verifySupabaseToken(req));
  } catch (err) {
    return res.status(err instanceof AuthError && err.status ? err.status : 401).json({ ok: false, error: 'Unauthorized' });
  }

  const body = req.body || {};
  const { eventId, confirmed, to, subject } = body;
  let { documentId } = body;
  const emailBody = body.body;

  // GATE 1 — explicit confirmation.
  if (confirmed !== true) {
    return res.status(400).json({
      ok: false,
      error: 'not_confirmed',
      message: 'The agent must approve the exact wording. Send confirmed: true with the approved subject and body.',
    });
  }
  if (!isEmail(to)) return res.status(400).json({ ok: false, error: 'A valid recipient address is required.' });
  // GATE 2 — wording comes from the human, not from here.
  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ ok: false, error: 'Approved subject is required.' });
  }
  if (!emailBody || typeof emailBody !== 'string' || !emailBody.trim()) {
    return res.status(400).json({ ok: false, error: 'Approved body is required.' });
  }

  let event = null;
  if (eventId) {
    const { ok, data } = await sb(
      `esign_events?select=*&id=eq.${encodeURIComponent(eventId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    );
    if (!ok || !Array.isArray(data) || !data.length) {
      return res.status(404).json({ ok: false, error: 'Signature event not found' });
    }
    event = data[0];
    documentId = documentId || event.document_id;
  }

  if (!documentId) return res.status(400).json({ ok: false, error: 'documentId or eventId is required.' });

  // GATE 3 — never forward an unverified or blank document.
  if (event) {
    if (event.verification_verdict !== 'signed') {
      return res.status(409).json({
        ok: false,
        error: 'refused_unverified_document',
        verdict: event.verification_verdict || 'unknown',
        message:
          event.verification_verdict === 'blank'
            ? 'Refused: this document reports complete but has no signature marks on the page. Sending it would forward a legally worthless document.'
            : 'Refused: the signatures on this document have not been confirmed. Verify it before sending it to the other side.',
        problems: (event.verification && event.verification.problems) || [],
      });
    }
  }

  const { ok: docOk, data: docData } = await sb(
    `documents?select=id,file_name,storage_path,transaction_id&id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  if (!docOk || !Array.isArray(docData) || !docData.length) {
    return res.status(404).json({ ok: false, error: 'Document not found' });
  }
  const doc = docData[0];

  if (!RESEND_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Email transport is not configured.' });
  }

  const pdf = await downloadFromStorage(doc.storage_path);
  if (!pdf) return res.status(500).json({ ok: false, error: 'Could not read the document from storage.' });

  const { data: profData } = await sb(
    `profiles?select=email,full_name&id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  const profile = (profData && profData[0]) || {};

  const fileName = /\.pdf$/i.test(doc.file_name || '') ? doc.file_name : `${doc.file_name || 'document'}.pdf`;
  const html = String(emailBody)
    .split('\n')
    .map((l) => (l.trim() ? `<p style="margin:0 0 12px">${l.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</p>` : ''))
    .join('');

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Dossie <dossie@meetdossie.com>',
      to: [to.trim()],
      ...(profile.email ? { reply_to: profile.email } : {}),
      subject: subject.trim(),
      html,
      text: emailBody,
      attachments: [{ filename: fileName, content: pdf.toString('base64') }],
    }),
  });

  const sendJson = await sendRes.json().catch(() => null);
  if (!sendRes.ok) {
    return res.status(502).json({
      ok: false,
      error: 'send_failed',
      detail: (sendJson && (sendJson.message || sendJson.name)) || `http_${sendRes.status}`,
    });
  }

  const sentAt = new Date().toISOString();

  // Record the send against the event so "did it actually go" is answerable
  // from the record instead of assumed.
  if (event) {
    await sb(`esign_events?id=eq.${encodeURIComponent(event.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        verification: {
          ...(event.verification || {}),
          handoff: {
            sentTo: to.trim(),
            sentAt,
            providerMessageId: (sendJson && sendJson.id) || null,
            subject: subject.trim(),
          },
        },
      }),
    }).catch(() => {});
  }

  return res.status(200).json({
    ok: true,
    sent: true,
    to: to.trim(),
    sentAt,
    providerMessageId: (sendJson && sendJson.id) || null,
    attachment: fileName,
  });
};
