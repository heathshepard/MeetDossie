// Vercel Serverless Function: /api/esign-draft-handoff
// =============================================================================
// (E) Assisted handoff — DRAFTS the email that sends an executed document to
// the counterparty agent. It does NOT send. Sending is a separate, explicitly
// approved call to /api/esign-send-handoff carrying the exact wording the agent
// accepted.
//
// HARD RULE ON THIS ACCOUNT: nothing goes to a counterparty without the agent
// approving the exact words. This endpoint is deliberately incapable of
// sending — it has no mail transport in it at all, so no future edit can
// accidentally make it send.
//
// It also refuses to draft a handoff for a document whose signatures did not
// verify. Offering to forward a blank "completed" PDF is the exact failure this
// whole workflow exists to prevent.
//
// POST { eventId }            — draft from a recorded completion event
//   or { documentId, transactionId }
// Authorization: Bearer <supabase user JWT>
//
// Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION)
// =============================================================================

'use strict';

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-sonnet-5';

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

function counterpartyAgent(txn) {
  const p = (txn && txn.parties) || {};
  const email =
    txn.other_agent_email_addr ||
    p.buyerAgentEmail ||
    (p.buyerAgent && p.buyerAgent.email) ||
    null;
  const name =
    txn.other_agent_name ||
    (p.buyerAgent && p.buyerAgent.name) ||
    p.buyerAgentName ||
    null;
  return { email, name };
}

// Heath's actual email voice: 1-3 sentences, "Hey X," / "Thanks,", plain, no
// corporate throat-clearing. Deliberately understated.
const DRAFT_SYSTEM = `You draft a short email from a Texas real estate agent to the agent on the other side of a deal, sending over a document that has just been fully executed on their client's side.

Voice rules — match them exactly:
- 1 to 3 sentences. Never more.
- Open with "Hey <first name>," (or "Hi there," if no name).
- Plain, direct, warm. No corporate phrasing, no "Please find attached", no "I hope this email finds you well".
- Say what the document is, that it's signed on our side, and what you need from them.
- Close with "Thanks," then the sender's first name on its own line.
- Never invent facts, deadlines, dollar amounts, or names beyond what you are given.

Return ONLY JSON: {"subject": "...", "body": "..."} with \\n for line breaks in body.`;

async function draftEmail({ docName, address, agentName, senderName, deadlineNote, signerNames }) {
  const facts = [
    `Document: ${docName}`,
    `Property: ${address || '(address not on file)'}`,
    `Signed by: ${signerNames && signerNames.length ? signerNames.join(' and ') : 'our client(s)'}`,
    `Recipient agent first name: ${(agentName || '').split(' ')[0] || '(unknown)'}`,
    `Sender first name: ${(senderName || '').split(' ')[0] || 'Heath'}`,
    deadlineNote ? `Deadline context: ${deadlineNote}` : null,
    'What we need: their client to sign and return it.',
  ].filter(Boolean).join('\n');

  if (!ANTHROPIC_API_KEY) {
    // Deterministic fallback so the feature still works without the model.
    const first = (agentName || '').split(' ')[0] || 'there';
    const me = (senderName || 'Heath').split(' ')[0];
    return {
      subject: `${docName}${address ? ` — ${String(address).split(',')[0]}` : ''}`,
      body: `Hey ${first},\n\nAttached is ${docName}, signed on our side. Can you get it signed and sent back${deadlineNote ? ` ${deadlineNote}` : ''}?\n\nThanks,\n${me}`,
      generatedBy: 'fallback',
    };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: DRAFT_SYSTEM,
      messages: [{ role: 'user', content: facts }],
    }),
  });
  if (!res.ok) {
    const first = (agentName || '').split(' ')[0] || 'there';
    const me = (senderName || 'Heath').split(' ')[0];
    return {
      subject: `${docName}${address ? ` — ${String(address).split(',')[0]}` : ''}`,
      body: `Hey ${first},\n\nAttached is ${docName}, signed on our side. Can you get it signed and sent back${deadlineNote ? ` ${deadlineNote}` : ''}?\n\nThanks,\n${me}`,
      generatedBy: 'fallback_api_error',
    };
  }
  const json = await res.json();
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const cleaned = text.replace(/```json\s*|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return { subject: parsed.subject, body: parsed.body, generatedBy: MODEL };
  } catch (_) {
    return { subject: `${docName}`, body: cleaned.slice(0, 1200), generatedBy: `${MODEL}_unparsed` };
  }
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
  const { eventId } = body;
  let { documentId, transactionId } = body;
  let event = null;

  if (eventId) {
    const { ok, data } = await sb(
      `esign_events?select=*&id=eq.${encodeURIComponent(eventId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    );
    if (!ok || !Array.isArray(data) || !data.length) {
      return res.status(404).json({ ok: false, error: 'Signature event not found' });
    }
    event = data[0];
    documentId = event.document_id;
    transactionId = event.transaction_id;
  }

  if (!documentId) {
    return res.status(400).json({ ok: false, error: 'No executed document is on file for this signing yet.' });
  }

  // REFUSE to draft a handoff for a document that did not verify clean.
  if (event && event.verification_verdict && event.verification_verdict !== 'signed') {
    const problems = (event.verification && event.verification.problems) || [];
    return res.status(409).json({
      ok: false,
      error: 'refused_unverified_document',
      verdict: event.verification_verdict,
      message:
        event.verification_verdict === 'blank'
          ? 'This document reports as complete but has no signature marks on the page. It is not executed — sending it would forward a legally worthless document.'
          : 'The signatures on this document could not be confirmed. Open and confirm it before sending it to the other side.',
      problems,
    });
  }

  const [docRes, txnRes, profRes] = await Promise.all([
    sb(`documents?select=id,file_name,storage_path,transaction_id&id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`),
    transactionId
      ? sb(`transactions?select=id,property_address,parties,option_period_end,other_agent_email_addr,other_agent_name&id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`)
      : Promise.resolve({ ok: true, data: [] }),
    sb(`profiles?select=full_name,email&id=eq.${encodeURIComponent(userId)}&limit=1`),
  ]);

  if (!docRes.ok || !Array.isArray(docRes.data) || !docRes.data.length) {
    return res.status(404).json({ ok: false, error: 'Document not found' });
  }
  const doc = docRes.data[0];
  const txn = (txnRes.data && txnRes.data[0]) || null;
  const profile = (profRes.data && profRes.data[0]) || {};

  const agent = txn ? counterpartyAgent(txn) : { email: null, name: null };

  let deadlineNote = null;
  if (txn && txn.option_period_end) {
    const d = new Date(txn.option_period_end);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now()) {
      deadlineNote = `before the option period ends ${d.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    }
  }

  const signerNames = (event && event.verification && event.verification.signerNamesSeen) || [];
  const docName = (event && event.document_name) || doc.file_name || 'the executed document';

  const draft = await draftEmail({
    docName,
    address: txn ? txn.property_address : null,
    agentName: agent.name,
    senderName: profile.full_name,
    deadlineNote,
    signerNames,
  });

  return res.status(200).json({
    ok: true,
    // Explicitly a draft. The client must show this for approval and echo the
    // final wording back to /api/esign-send-handoff.
    draft: {
      to: agent.email,
      toName: agent.name,
      subject: draft.subject,
      body: draft.body,
      generatedBy: draft.generatedBy,
    },
    attachment: { documentId: doc.id, fileName: doc.file_name },
    context: {
      eventId: event ? event.id : null,
      transactionId: txn ? txn.id : null,
      propertyAddress: txn ? txn.property_address : null,
      verificationVerdict: event ? event.verification_verdict : null,
      signerNames,
      deadlineNote,
    },
    // Told plainly so no caller can mistake this for a send.
    sent: false,
    nextStep: 'Show this draft to the agent. On approval, POST the exact wording to /api/esign-send-handoff.',
  });
};
