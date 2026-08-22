// Vercel Serverless Function: /api/cron-esign-events
// =============================================================================
// The e-signature completion workflow.
//
// Productizes the sequence Heath ran by hand on the live 104 Wild Cherry Ln
// amendment on 2026-08-13:
//   A. notice the provider's notification emails as parties act
//   B. pull the executed PDF and FILE it durably (the provider link dies)
//   C. LOOK at the pages and confirm the signatures actually rendered
//   D. update the deal and raise an ask for the next real-world step
//
// WHY A SEPARATE CRON FROM cron-email-to-dossier.js: that pipeline matches an
// email to a deal by EXACT COUNTERPARTY SENDER ADDRESS. These emails come from
// secure@authentisign.com — a provider, never a counterparty — so it can never
// match them, and its output (an AI prose summary appended to notes_log) is the
// wrong artifact for something with actionable state. Same inbox, different
// matching rule, different output. Kept alongside rather than bolted on.
//
// RETRIEVAL IS ATTACHMENT-FIRST, AND MAY LEGITIMATELY FAIL. Authentisign's
// "download the completed documents" link points at an authenticated web page,
// not at PDF bytes — an unauthenticated GET gets an HTML login page. So we try
// the email's own PDF attachment first, then the links, and if we cannot get
// real PDF bytes we say so and raise an ask telling the agent to pull it
// manually BEFORE the 7-day link expiry. We never record a document as filed
// when it isn't.
//
// NOTHING IS EVER SENT TO A COUNTERPARTY FROM HERE. Completion raises an ask;
// the agent approves exact wording via /api/esign-draft-handoff. Hard rule on
// this account.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — every 15 min
//
// MULTI-TENANT + ENTITLEMENT GATE (2026-08-22): this is capability #2 of the
// paid "Email Integration" add-on (renamed + expanded from "Reply
// Monitoring"). Previously ran unconditionally for Heath's own account with
// zero gating. Now loops over every customer who has BOTH email connected
// (user_integrations) AND subscriptions.email_integration_enabled — see
// api/_lib/email-integration-customers.js. Gmail OAuth is shared with
// cron-email-to-dossier.js and cron-showingtime-feedback.js via
// api/_lib/gmail-oauth.js.
//
// Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION); multi-tenant rewrite
// Carter, 2026-08-22 (SV-ENG-EMAIL-INTEGRATION-ADDON)
// =============================================================================

'use strict';

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { parseEsignNotification, matchToDeal } = require('./_lib/esign-notification-parser');
const { verifyExecutedPdf, VERDICT } = require('./_lib/signature-verifier');
const { listEmailIntegrationCustomers } = require('./_lib/email-integration-customers');
const { loadGoogleTokensForUser, makeGmailClient, headerMap, parseFromHeader, bodyOfMessage } = require('./_lib/gmail-oauth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const BUCKET = 'documents';

// Gmail search across the provider allowlist. Kept in sync with
// PROVIDER_DOMAINS in the parser — the parser still re-checks the sender, so a
// broad query here can only cost us a wasted fetch, never a false positive.
const PROVIDER_QUERY =
  '(from:authentisign.com OR from:lonewolf.com OR from:lwolf.com OR ' +
  'from:docusign.net OR from:docusign.com OR from:docuseal.com OR ' +
  'from:docuseal.co OR from:echosign.com OR from:adobesign.com)';

const LOOKBACK = 'newer_than:3d';
const MAX_MESSAGES = 40;

// --------------------------------------------------------------------------
// Supabase
// --------------------------------------------------------------------------

async function sb(pathAndQuery, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

async function loadActiveDeals(userId) {
  const { ok, data, status, text } = await sb(
    `transactions?user_id=eq.${encodeURIComponent(userId)}&status=neq.closed` +
    `&select=id,property_address,stage,parties,notes_log,option_expiration_date,` +
    `other_agent_email_addr,other_agent_name,listing_agent_email_addr,` +
    `buyer_email,seller_email,buyer2_email,seller2_email`,
  );
  if (!ok || !Array.isArray(data)) {
    // BUG FIX 2026-08-22 (Quinn QA): this used to select a column
    // (option_period_end) that does not exist on transactions, so PostgREST
    // 400'd on every call and this silently returned [] — meaning e-sign
    // completions could NEVER be matched to a deal, for any customer, ever.
    // Log loudly instead of swallowing so a future schema drift is visible
    // in Vercel logs instead of masquerading as "no active deals".
    console.error('[cron-esign-events] loadActiveDeals query failed for user', userId, 'status=', status, 'body=', String(text).slice(0, 300));
    return [];
  }
  return data.map((r) => ({
    id: r.id,
    address: r.property_address,
    stage: r.stage,
    parties: r.parties || {},
    notesLog: Array.isArray(r.notes_log) ? r.notes_log : [],
    optionPeriodEnd: r.option_expiration_date || null,
    otherAgentEmail: r.other_agent_email_addr || null,
    otherAgentName: r.other_agent_name || null,
    listingAgentEmail: r.listing_agent_email_addr || null,
    raw: r,
  }));
}

// Already handled this exact email? The unique index on
// (user_id, source_message_id) is the real guarantee; this is the cheap check.
async function alreadyProcessed(userId, messageId) {
  const { ok, data } = await sb(
    `esign_events?select=id,processed_at&user_id=eq.${encodeURIComponent(userId)}` +
    `&source_message_id=eq.${encodeURIComponent(messageId)}&limit=1`,
  );
  return ok && Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// --------------------------------------------------------------------------
// Gmail — shared OAuth client (api/_lib/gmail-oauth.js), same OAuth row as
// kw-mail.py / cron-email-to-dossier.js / cron-showingtime-feedback.js.
// loadGoogleTokensForUser / makeGmailClient / headerMap / bodyOfMessage are
// imported above. parseFrom below is a thin local alias so the rest of this
// file (written before the extraction) doesn't need every call site renamed.
// --------------------------------------------------------------------------

const parseFrom = parseFromHeader;

// Find PDF attachments on the notification email. This is the MOST RELIABLE
// retrieval path — no expiring link, no auth wall.
function findPdfAttachments(msg) {
  const found = [];
  const walk = (part) => {
    if (!part) return;
    const filename = part.filename || '';
    const isPdf = /\.pdf$/i.test(filename) || part.mimeType === 'application/pdf';
    if (isPdf && part.body && part.body.attachmentId) {
      found.push({ filename: filename || 'document.pdf', attachmentId: part.body.attachmentId, size: part.body.size || 0 });
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  return found;
}

async function downloadAttachment(gmail, messageId, attachmentId) {
  const data = await gmail(`messages/${messageId}/attachments/${attachmentId}`);
  if (!data || !data.data) return null;
  return Buffer.from(data.data, 'base64url');
}

// --------------------------------------------------------------------------
// B — retrieve the executed PDF
// --------------------------------------------------------------------------

function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length > 400 && buf.slice(0, 5).toString('latin1').startsWith('%PDF');
}

/**
 * Attachment first, then each candidate link. Returns { buffer, via, url } or
 * { buffer: null, attempts } — an honest failure, never a fake success.
 */
async function retrieveExecutedPdf({ gmail, messageId, msg, links }) {
  const attempts = [];

  for (const att of findPdfAttachments(msg)) {
    try {
      const buf = await downloadAttachment(gmail, messageId, att.attachmentId);
      if (looksLikePdf(buf)) {
        return { buffer: buf, via: 'email_attachment', url: null, fileName: att.filename, attempts };
      }
      attempts.push({ source: `attachment:${att.filename}`, result: 'not_a_pdf' });
    } catch (err) {
      attempts.push({ source: `attachment:${att.filename}`, result: `error:${String(err.message).slice(0, 80)}` });
    }
  }

  for (const url of (links || []).slice(0, 4)) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { Accept: 'application/pdf,*/*' } });
      const ct = String(res.headers.get('content-type') || '');
      if (!res.ok) { attempts.push({ source: url, result: `http_${res.status}` }); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (looksLikePdf(buf)) {
        return { buffer: buf, via: 'provider_link', url, fileName: null, attempts };
      }
      // Almost always an HTML login page — the expected Authentisign outcome.
      attempts.push({ source: url, result: `not_a_pdf(content-type=${ct.slice(0, 40)})` });
    } catch (err) {
      attempts.push({ source: url, result: `error:${String(err.message).slice(0, 80)}` });
    }
  }

  return { buffer: null, via: null, url: null, fileName: null, attempts };
}

function safeFileName(name) {
  return String(name || 'executed-document.pdf')
    .replace(/[\/\\]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._\-\s()#]/g, '_')
    .trim()
    .slice(0, 180) || 'executed-document.pdf';
}

async function storeExecutedPdf({ userId, transactionId, buffer, fileName }) {
  const ts = Date.now();
  const safe = safeFileName(fileName);
  const withExt = /\.pdf$/i.test(safe) ? safe : `${safe}.pdf`;
  const storagePath = `${userId}/${transactionId || 'no-transaction'}/executed-${ts}-${withExt}`;

  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'false',
    },
    body: buffer,
  });
  if (!upload.ok) {
    const t = await upload.text().catch(() => '');
    throw new Error(`storage_upload_failed:${upload.status}:${t.slice(0, 160)}`);
  }

  const { ok, data } = await sb('documents', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      transaction_id: transactionId || null,
      user_id: userId,
      file_name: `executed-${withExt}`,
      file_type: 'application/pdf',
      document_type: 'signed',
      storage_path: storagePath,
      file_size: buffer.length,
    }),
  });
  if (!ok) throw new Error('documents_insert_failed');
  const row = Array.isArray(data) ? data[0] : data;
  return { documentId: row && row.id ? row.id : null, storagePath };
}

// --------------------------------------------------------------------------
// D — deal state + the ask
// --------------------------------------------------------------------------

function counterpartyAgent(deal) {
  const p = deal.parties || {};
  const email =
    deal.otherAgentEmail ||
    p.buyerAgentEmail ||
    (p.buyerAgent && p.buyerAgent.email) ||
    null;
  const name =
    deal.otherAgentName ||
    (p.buyerAgent && p.buyerAgent.name) ||
    p.buyerAgentName ||
    null;
  return { email: email || null, name: name || null };
}

function buildAsk({ parsed, deal, verification, retrieval, documentId }) {
  const docName = parsed.documentName || 'the document';
  const agent = deal ? counterpartyAgent(deal) : { email: null, name: null };
  const agentLabel = agent.name || agent.email || "the other agent";
  const optionEnd = deal && deal.optionPeriodEnd ? new Date(deal.optionPeriodEnd) : null;
  const dueAt = optionEnd && !isNaN(optionEnd.getTime()) ? optionEnd.toISOString() : null;
  const dueLabel = dueAt ? `option period ends ${optionEnd.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : null;

  // Retrieval failed — the agent has to act before the provider link dies.
  if (!documentId) {
    const why = (retrieval.attempts || []).map((a) => a.result).join('; ') || 'no download source found';
    return {
      urgency: 'high',
      title: `Signing complete — I could not pull the executed copy`,
      body:
        `${docName} came back complete, but I could not retrieve the executed PDF automatically (${why}). ` +
        `Provider download links expire (7 days on Authentisign), so this needs to be downloaded and added to the file before it disappears. ` +
        `Once it's in the file I'll verify the signatures actually rendered and draft the handoff to ${agentLabel}.`,
      dueAt,
      dueLabel,
      actions: [
        { id: 'upload_executed', label: 'Upload executed copy', kind: 'primary' },
        { id: 'open_provider', label: 'Open provider link', kind: 'secondary' },
      ],
    };
  }

  // The loud failure: provider said done, the page is blank.
  if (verification.verdict === VERDICT.BLANK) {
    return {
      urgency: 'critical',
      title: `${docName} came back COMPLETE but BLANK — do not send it`,
      body:
        `The provider reported this signing as complete, but when I looked at the actual pages there are no signature marks on it. ` +
        `A completed-but-unsigned document is legally worthless. Do not forward this to ${agentLabel}. ` +
        `This needs to be re-sent for signature. ` +
        (verification.problems || []).slice(0, 3).join(' '),
      dueAt,
      dueLabel,
      actions: [
        { id: 'view_document', label: 'See the document', kind: 'primary' },
        { id: 'resend_signing', label: 'Re-send for signature', kind: 'secondary' },
      ],
    };
  }

  if (verification.verdict === VERDICT.PARTIAL) {
    return {
      urgency: 'high',
      title: `${docName} is only partially signed`,
      body:
        `This came back marked complete, but not every signature line is filled in. ` +
        `${(verification.problems || []).slice(0, 3).join(' ')} ` +
        `I've filed the copy — worth confirming before anything goes to ${agentLabel}.`,
      dueAt,
      dueLabel,
      actions: [
        { id: 'view_document', label: 'See the document', kind: 'primary' },
        { id: 'draft_handoff', label: `Draft email to ${agentLabel}`, kind: 'secondary' },
      ],
    };
  }

  if (verification.verdict === VERDICT.UNVERIFIABLE) {
    return {
      urgency: 'high',
      title: `${docName} is filed, but I could not confirm the signatures`,
      body:
        `I filed the executed copy, but I could not verify that the signature marks actually rendered ` +
        `(${(verification.problems || [])[0] || 'verification unavailable'}). ` +
        `Provider status alone isn't proof — please open it and confirm before it goes to ${agentLabel}.`,
      dueAt,
      dueLabel,
      actions: [
        { id: 'view_document', label: 'Open and confirm', kind: 'primary' },
        { id: 'draft_handoff', label: `Draft email to ${agentLabel}`, kind: 'secondary' },
      ],
    };
  }

  // Clean signed — the Wild Cherry happy path.
  const signers = (verification.signerNamesSeen || []).filter(Boolean);
  const who = signers.length === 2
    ? `${signers[0]} and ${signers[1]} both signed`
    : signers.length === 1
      ? `${signers[0]} signed`
      : 'All parties signed';
  const extras = (verification.problems || []).filter((p) => /still blank/i.test(p));

  return {
    urgency: 'high',
    title: `${who} — send the executed copy to ${agentLabel}?`,
    body:
      `${docName} is fully executed and I've verified the signatures actually appear on the page, not just that the provider marked it complete. ` +
      `The copy is filed in this deal's documents. ` +
      `Want me to draft the email sending it to ${agentLabel} so their side can sign?` +
      (extras.length ? ` One thing to note first — ${extras.join(' ')}` : ''),
    dueAt,
    dueLabel,
    actions: [
      { id: 'draft_handoff', label: `Draft email to ${agentLabel}`, kind: 'primary' },
      { id: 'view_document', label: 'See the document', kind: 'secondary' },
    ],
  };
}

async function createAsk({ userId, transactionId, ask, sourceLabel }) {
  const { ok, data } = await sb('dossie_asks', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      transaction_id: transactionId || null,
      urgency: ask.urgency,
      title: String(ask.title).slice(0, 160),
      body: String(ask.body).slice(0, 2000),
      due_at: ask.dueAt || null,
      due_label: ask.dueLabel || null,
      suggested_actions: ask.actions || [],
      created_by: 'dossie',
      source: sourceLabel,
    }),
  });
  if (!ok) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row && row.id ? row.id : null;
}

async function appendNote(deal, entry) {
  if (!deal) return;
  await sb(`transactions?id=eq.${encodeURIComponent(deal.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ notes_log: [entry, ...(deal.notesLog || [])] }),
  }).catch(() => {});
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function authorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || '';
  return !!(CRON_SECRET && auth === `Bearer ${CRON_SECRET}`);
}

// Runs the full watch → parse → retrieve → verify → file → ask pipeline for
// ONE entitled + connected customer. Returns a plain result object (never
// touches `res` directly) so the outer handler can loop over every customer
// and aggregate. dryRun mirrors the old query-param dry run, scoped to
// whichever customer the outer handler is currently processing.
async function runForCustomer({ userId, googleEmail }, { dryRun } = {}) {
  const stats = {
    candidates: 0, esign: 0, new: 0, completions: 0,
    filed: 0, retrieval_failures: 0, verified_signed: 0, flagged: 0, asks: 0, errors: 0,
  };
  const details = [];

  let gmail;
  try {
    const tokens = await loadGoogleTokensForUser(userId);
    if (!tokens) throw new Error('no_google_integration_row');
    gmail = makeGmailClient({ userId, tokens });
  } catch (err) {
    return { ok: false, status: 'no_google_integration', userId, googleEmail, error: String(err.message) };
  }

  let list;
  try {
    list = await gmail('messages', { q: `${PROVIDER_QUERY} ${LOOKBACK}`, maxResults: String(MAX_MESSAGES) });
  } catch (err) {
    return { ok: false, status: 'gmail_list_failed', userId, googleEmail, error: String(err.message) };
  }

  const ids = (list.messages || []).map((m) => m.id);
  stats.candidates = ids.length;

  const deals = await loadActiveDeals(userId);

  // Dry run: parse and report what WOULD happen, writing nothing. Provider
  // email layouts change without notice and are the most likely thing to break
  // this pipeline silently, so keeping a first-class way to inspect the real
  // parse is worth more than the few lines it costs.
  // CRON_SECRET-gated, same as the live path.
  if (dryRun) {
    const out = [];
    for (const messageId of ids.slice(0, 12)) {
      try {
        const msg = await gmail(`messages/${messageId}`, { format: 'full' });
        const hdr = headerMap(msg?.payload?.headers);
        const { email: fromEmail } = parseFrom(hdr['from']);
        const subject = hdr['subject'] || '';
        const body = bodyOfMessage(msg);
        const parsed = parseEsignNotification({ fromEmail, subject, body });
        const match = parsed ? matchToDeal(parsed, deals) : null;
        out.push({
          messageId,
          from: fromEmail,
          subject,
          attachments: findPdfAttachments(msg).map((a) => ({ name: a.filename, size: a.size })),
          parsed: parsed && {
            provider: parsed.provider,
            action: parsed.action,
            documentName: parsed.documentName,
            participantName: parsed.participantName,
            isCompletion: parsed.isCompletion,
            linkCount: (parsed.documentLinks || []).length,
          },
          match: match && { dealAddress: match.deal ? match.deal.address : null, confidence: match.confidence, reason: match.reason },
          bodyExcerpt: String(body).replace(/\s+/g, ' ').slice(0, 700),
        });
      } catch (err) {
        out.push({ messageId, error: String(err.message).slice(0, 160) });
      }
    }
    return {
      ok: true,
      status: 'dry_run',
      userId,
      googleEmail,
      activeDeals: deals.map((d) => d.address),
      messages: out,
    };
  }

  for (const messageId of ids) {
    try {
      if (await alreadyProcessed(userId, messageId)) continue;

      const msg = await gmail(`messages/${messageId}`, { format: 'full' });
      const hdr = headerMap(msg?.payload?.headers);
      const { email: fromEmail } = parseFrom(hdr['from']);
      const subject = hdr['subject'] || '';
      const body = bodyOfMessage(msg);
      const dateIso = hdr['date'] && !isNaN(new Date(hdr['date']).getTime())
        ? new Date(hdr['date']).toISOString()
        : new Date().toISOString();

      const parsed = parseEsignNotification({ fromEmail, subject, body, dateIso });
      if (!parsed) continue; // not an e-sign notification
      stats.esign++;

      const match = matchToDeal(parsed, deals);
      const deal = match.deal;

      // Record the event first, so nothing is ever silently dropped.
      const insert = await sb('esign_events', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          transaction_id: deal ? deal.id : null,
          provider: parsed.provider,
          document_name: parsed.documentName,
          participant_name: parsed.participantName,
          participant_email: parsed.participantEmail,
          action: parsed.action,
          event_at: parsed.eventAt,
          source_message_id: messageId,
          source_thread_id: msg.threadId || null,
          subject: subject.slice(0, 500),
          snippet: (msg.snippet || '').slice(0, 500),
          document_url: (parsed.documentLinks || [])[0] || null,
        }),
      });
      if (!insert.ok) {
        // Unique-index violation = another run already took it. Not an error.
        if (insert.status !== 409) stats.errors++;
        continue;
      }
      const eventRow = Array.isArray(insert.data) ? insert.data[0] : insert.data;
      stats.new++;

      // Non-completion events: recorded, and that's it. No noise.
      if (!parsed.isCompletion) {
        if (parsed.isNegative && deal) {
          const askId = await createAsk({
            userId,
            transactionId: deal.id,
            ask: {
              urgency: 'critical',
              title: `${parsed.participantName || 'A signer'} ${parsed.action} ${parsed.documentName || 'the signing'}`,
              body: `${parsed.documentName || 'A signing'} was ${parsed.action}${parsed.participantName ? ` by ${parsed.participantName}` : ''}. Nothing is executed. This needs a call before the deal timeline moves.`,
              dueAt: null,
              dueLabel: null,
              actions: [{ id: 'acknowledge', label: 'Got it', kind: 'primary' }],
            },
            sourceLabel: `esign:${messageId}`,
          });
          if (askId) {
            stats.asks++;
            await sb(`esign_events?id=eq.${eventRow.id}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ ask_id: askId, processed_at: new Date().toISOString() }),
            });
          }
        } else {
          await sb(`esign_events?id=eq.${eventRow.id}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ processed_at: new Date().toISOString() }),
          });
        }
        details.push({ messageId, action: parsed.action, participant: parsed.participantName, deal: deal ? deal.address : null });
        continue;
      }

      // ---- COMPLETION: retrieve → verify → file → ask ----
      stats.completions++;

      const retrieval = await retrieveExecutedPdf({
        gmail, messageId, msg, links: parsed.documentLinks,
      });

      let documentId = null;
      let verification = { verdict: VERDICT.UNVERIFIABLE, problems: ['No document retrieved.'], signerNamesSeen: [] };

      if (retrieval.buffer) {
        // C — verify BEFORE declaring anything done.
        const expectedSigners = [];
        if (deal) {
          const p = deal.parties || {};
          for (const key of ['seller', 'seller2', 'buyer', 'buyer2']) {
            const v = p[key];
            if (v && v.name) expectedSigners.push(v.name);
          }
        }
        verification = await verifyExecutedPdf({
          buffer: retrieval.buffer,
          expectedSigners,
          apiKey: ANTHROPIC_API_KEY,
          providerStatus: 'completed',
        });

        try {
          const stored = await storeExecutedPdf({
            userId,
            transactionId: deal ? deal.id : null,
            buffer: retrieval.buffer,
            fileName: retrieval.fileName || parsed.documentName || 'executed-document.pdf',
          });
          documentId = stored.documentId;
          stats.filed++;
        } catch (err) {
          stats.errors++;
          verification.problems = [...(verification.problems || []), `Could not file the copy: ${err.message}`];
        }
      } else {
        stats.retrieval_failures++;
      }

      if (verification.verdict === VERDICT.SIGNED) stats.verified_signed++;
      else stats.flagged++;

      const ask = buildAsk({ parsed, deal, verification, retrieval, documentId });
      const askId = deal || !documentId
        ? await createAsk({ userId, transactionId: deal ? deal.id : null, ask, sourceLabel: `esign:${messageId}` })
        : null;
      if (askId) stats.asks++;

      await sb(`esign_events?id=eq.${eventRow.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          document_id: documentId,
          verification_verdict: verification.verdict,
          verification: {
            problems: verification.problems || [],
            signerNamesSeen: verification.signerNamesSeen || [],
            datesSeen: verification.datesSeen || [],
            structural: verification.structural || null,
            visual: verification.visual || null,
            retrievalVia: retrieval.via,
            retrievalAttempts: retrieval.attempts || [],
            matchConfidence: match.confidence,
            matchReason: match.reason,
          },
          document_sha256: verification.sha256 || null,
          ask_id: askId,
          processed_at: new Date().toISOString(),
        }),
      });

      if (deal) {
        await appendNote(deal, {
          id: `esign-${messageId}`,
          source: 'esign',
          stageId: deal.stage,
          text:
            verification.verdict === VERDICT.SIGNED
              ? `${parsed.documentName} fully executed — signatures visually verified on the filed copy.`
              : `${parsed.documentName} reported complete by ${parsed.provider}, but verification returned "${verification.verdict}". ${(verification.problems || [])[0] || ''}`,
          createdAt: parsed.eventAt,
          read: false,
        });
      }

      details.push({
        messageId,
        action: parsed.action,
        deal: deal ? deal.address : null,
        matchConfidence: match.confidence,
        retrievedVia: retrieval.via,
        verdict: verification.verdict,
        filed: !!documentId,
        askCreated: !!askId,
      });
    } catch (err) {
      stats.errors++;
      console.error('[cron-esign-events] message failed', userId, messageId, err && err.message);
    }
  }

  return { ok: true, status: 'complete', userId, googleEmail, stats, details };
}

// --------------------------------------------------------------------------
// Outer handler — entitlement gate + per-customer loop
// --------------------------------------------------------------------------

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(200).json({ ok: true, status: 'skipped', reason: 'google_oauth_env_missing' });
  }

  let customers = [];
  try {
    customers = await listEmailIntegrationCustomers();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'entitlement_lookup_failed', detail: String(err.message || err) });
  }

  if (!customers.length) {
    return res.status(200).json({ ok: true, status: 'complete', customers: 0, results: [] });
  }

  const dryRun = !!(req.query && (req.query.dry === '1' || req.query.dry === 'true'));
  // ?dry=1 with no user_id scopes the dry run to the FIRST entitled customer
  // (keeps the diagnostic cheap); ?dry=1&user_id=<uuid> targets one directly.
  const targetUserId = req.query && req.query.user_id;
  const scoped = dryRun
    ? (targetUserId ? customers.filter((c) => c.userId === targetUserId) : customers.slice(0, 1))
    : customers;

  const results = [];
  for (const customer of scoped) {
    try {
      results.push(await runForCustomer(customer, { dryRun }));
    } catch (err) {
      console.error('[cron-esign-events] customer run failed', customer.userId, err && err.message);
      results.push({ ok: false, status: 'unhandled_error', userId: customer.userId, error: String(err && err.message || err) });
    }
  }

  return res.status(200).json({ ok: true, status: dryRun ? 'dry_run' : 'complete', customers: customers.length, results });
}

module.exports = withTelemetry('cron-esign-events', handler);
module.exports.config = { maxDuration: 300 };
