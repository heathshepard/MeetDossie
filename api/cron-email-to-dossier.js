// Vercel Serverless Function: /api/cron-email-to-dossier
//
// Capability #1 of the "Email Integration" add-on (renamed + expanded from
// "Reply Monitoring" 2026-08-22). Watches each ENTITLED + CONNECTED customer's
// inbox and files incoming emails into the correct transaction/dossier when
// the sender is an exact match on a counterparty already on file for an
// active deal (buyer, seller, buyer's agent, listing agent, title, lender).
// No fuzzy/AI-guessed matching in v1 — exact From-address match only, per
// Heath's 2026-08-12 ask.
//
// On a match:
//   1. Pull the message body (text/plain, falling back to stripped HTML).
//   2. One claude-haiku-4-5 call: summarize in 1-2 sentences, in the context
//      of the deal's current stage.
//   3. Append an entry to that transaction's notes_log jsonb column.
//
// No transaction match -> the email is left alone. No fuzzy matching in v1.
//
// MULTI-TENANT (2026-08-22): previously hardcoded to one mailbox
// (heath.shepard@kw.com). Now loops over every customer who has BOTH email
// connected (user_integrations) AND the Email Integration add-on entitlement
// (subscriptions.email_integration_enabled) — see
// api/_lib/email-integration-customers.js. Per-customer Gmail OAuth lives in
// api/_lib/gmail-oauth.js (shared with cron-esign-events.js and
// cron-showingtime-feedback.js). Per-customer checkpoint is stored in
// email_watcher_state under tier = `dossier-file:${userId}` (one row per
// customer, same table, no schema change needed).
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — every 15 min (matches cron-relevance-watcher.js)

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-email-to-dossier');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { listEmailIntegrationCustomers } = require('./_lib/email-integration-customers');
const { makeMailClient } = require('./_lib/mail-client');
const { headerMap, parseFromHeader, bodyOfMessage } = require('./_lib/gmail-oauth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEATH_TELEGRAM_CHAT_ID = '7874782923';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const MAX_CANDIDATES_PER_USER = 50;
const MAX_SUMMARIZE_CALLS_PER_USER = 20; // cost guardrail, per customer per run

// --------------------------------------------------------------------------
// Supabase
// --------------------------------------------------------------------------

async function supaFetch(path, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}

function checkpointTier(userId) {
  return `dossier-file:${userId}`;
}

async function getCheckpoint(userId) {
  const tier = checkpointTier(userId);
  const res = await supaFetch(`email_watcher_state?tier=eq.${encodeURIComponent(tier)}&select=last_check_ts,last_run_status`);
  if (!res.ok) throw new Error(`checkpoint fetch failed: ${res.status}`);
  const rows = await res.json();
  const fallback = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  return { ts: rows && rows[0] ? rows[0].last_check_ts : fallback, lastStatus: rows && rows[0] ? rows[0].last_run_status : null };
}

async function updateCheckpoint(userId, { newTs, status, matches, notes }) {
  const tier = checkpointTier(userId);
  const patch = {
    tier,
    last_check_ts: newTs,
    last_run_at: new Date().toISOString(),
    last_run_status: status,
    last_run_notes: notes ? String(notes).slice(0, 500) : null,
    matches_last_run: matches,
    updated_at: new Date().toISOString(),
  };
  const res = await supaFetch(`email_watcher_state?on_conflict=tier`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    console.warn('[cron-email-to-dossier] checkpoint update failed', res.status, await res.text().catch(() => ''));
  }
}

// Active (non-closed) transactions for one user, with every counterparty
// email address we might match against.
async function loadActiveDealsWithContacts(userId) {
  const res = await supaFetch(
    `transactions?user_id=eq.${encodeURIComponent(userId)}&status=neq.closed` +
    `&select=id,dossier_number,property_address,stage,parties,notes_log,` +
    `buyer_email,seller_email,buyer2_email,seller2_email,listing_agent_email_addr,other_agent_email_addr,` +
    `loan_officer_email,title_officer_email`,
  );
  if (!res.ok) throw new Error(`transactions fetch failed: ${res.status}`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const emails = new Set();
    const addEmail = (v) => {
      if (!v || typeof v !== 'string') return;
      v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).forEach((e) => emails.add(e));
    };
    const p = r.parties || {};
    ['buyer', 'seller', 'buyerAgent', 'listingAgent', 'title', 'lender'].forEach((k) => addEmail(p[k]?.email));
    [r.buyer_email, r.seller_email, r.buyer2_email, r.seller2_email, r.listing_agent_email_addr, r.other_agent_email_addr, r.loan_officer_email, r.title_officer_email]
      .forEach(addEmail);
    return {
      id: r.id,
      dossierNumber: r.dossier_number,
      address: r.property_address,
      stage: r.stage,
      notesLog: Array.isArray(r.notes_log) ? r.notes_log : [],
      contactEmails: emails,
    };
  });
}

async function appendNotesLogEntry(dealId, currentNotesLog, entry) {
  const updated = [entry, ...currentNotesLog];
  const res = await supaFetch(`transactions?id=eq.${encodeURIComponent(dealId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ notes_log: updated }),
  });
  return res.ok;
}

// --------------------------------------------------------------------------
// Summarization — one Haiku call per matched email.
// --------------------------------------------------------------------------

const SUMMARIZE_SYSTEM_PROMPT = `You summarize a single email for a Texas real estate agent's transaction file. You will be given the deal's address and current stage, and the email's From/Subject/Body. Reply with ONLY a 1-2 sentence plain-language summary of what this email says or asks for -- no preamble, no "this email is about", just the substance (numbers, dates, and asks matter most). If it's a negotiation point (price, repairs, terms), name the specific figures.`;

async function summarizeEmail({ address, stage, fromDisplay, subject, body }) {
  const userMsg = [
    `Deal: ${address || '(no address on file)'} -- stage: ${stage || 'unknown'}`,
    '---',
    `From: ${fromDisplay}`,
    `Subject: ${subject || '(no subject)'}`,
    `Body: ${(body || '').slice(0, 3000)}`,
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 200,
      system: SUMMARIZE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`haiku_summarize_failed:${res.status}:${err.slice(0, 160)}`);
  }
  const json = await res.json();
  const text = ((json?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')).trim();
  return text.slice(0, 600);
}

// --------------------------------------------------------------------------
// Telegram — one-shot alert when a customer's Google refresh token is dead.
// --------------------------------------------------------------------------

async function sendInvalidGrantAlertOnce(email, alreadyAlerted, provider = 'google') {
  if (alreadyAlerted) return;
  if (!TELEGRAM_BOT_TOKEN) return;
  const providerLabel = provider === 'microsoft' ? 'Microsoft' : 'Google';
  const text = [
    `⚠️ ${providerLabel} connection to Dossie broke.`,
    `${providerLabel} revoked the refresh token for ${email} (invalid_grant).`,
    `Fix: that customer needs to reconnect ${providerLabel} in Settings.`,
  ].join('\n');
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: HEATH_TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.warn('[cron-email-to-dossier] telegram alert failed', e.message));
}

// --------------------------------------------------------------------------
// Per-customer run
// --------------------------------------------------------------------------

async function runForCustomer({ userId, email }) {
  const stats = { candidates: 0, matched: 0, filed: 0, summarize_errors: 0, patch_failures: 0 };

  const { ts: checkpoint, lastStatus } = await getCheckpoint(userId);

  const mail = await makeMailClient({ userId });
  if (!mail) {
    await updateCheckpoint(userId, { newTs: checkpoint, status: 'error', matches: 0, notes: 'no_mail_integration_row' });
    return { ok: false, status: 'no_mail_integration', userId, stats };
  }

  const gmail = mail.client;

  const afterEpoch = Math.floor(new Date(checkpoint).getTime() / 1000) - 60;
  const q = [`after:${afterEpoch}`, '-in:sent', '-in:drafts', '-in:spam', '-in:trash', '-in:chats'].join(' ');

  let listResp;
  try {
    listResp = await gmail('messages', { q, maxResults: String(MAX_CANDIDATES_PER_USER) });
  } catch (err) {
    const hitInvalidGrant = err.isInvalidGrant || /invalid_grant/i.test(String(err.message || ''));
    if (hitInvalidGrant) await sendInvalidGrantAlertOnce(email || mail.email, lastStatus === 'error', mail.provider);
    await updateCheckpoint(userId, { newTs: checkpoint, status: 'error', matches: 0, notes: `gmail_list_failed:${String(err.message || err)}` });
    return { ok: false, status: 'gmail_list_failed', userId, error: String(err.message || err), stats };
  }

  const messageIds = (listResp?.messages || []).map((m) => m.id);
  stats.candidates = messageIds.length;

  let deals = [];
  try {
    deals = await loadActiveDealsWithContacts(userId);
  } catch (err) {
    await updateCheckpoint(userId, { newTs: checkpoint, status: 'error', matches: 0, notes: `deals_load_failed:${String(err.message || err)}` });
    return { ok: false, status: 'deals_load_failed', userId, error: String(err.message || err), stats };
  }

  let newestSeenIso = checkpoint;
  let summarizeCallsUsed = 0;

  for (const messageId of messageIds) {
    let msg;
    try {
      msg = await gmail(`messages/${messageId}`, { format: 'full' });
    } catch (err) {
      console.warn('[cron-email-to-dossier] message fetch failed', userId, messageId, err.message);
      continue;
    }

    const hdr = headerMap(msg?.payload?.headers);
    const { name: fromName, email: fromEmail } = parseFromHeader(hdr['from']);
    const subject = hdr['subject'] || '';
    const dateHeader = hdr['date'];
    let emailDateIso = new Date().toISOString();
    if (dateHeader) {
      const d = new Date(dateHeader);
      if (!isNaN(d.getTime())) {
        emailDateIso = d.toISOString();
        if (emailDateIso > newestSeenIso) newestSeenIso = emailDateIso;
      }
    }

    if (!fromEmail) continue;

    const deal = deals.find((d) => d.contactEmails.has(fromEmail));
    if (!deal) continue;

    stats.matched++;

    if (deal.notesLog.some((n) => n.gmailMessageId === messageId)) continue;

    if (summarizeCallsUsed >= MAX_SUMMARIZE_CALLS_PER_USER) continue;

    summarizeCallsUsed++;
    const body = bodyOfMessage(msg);
    let summary;
    try {
      summary = await summarizeEmail({
        address: deal.address,
        stage: deal.stage,
        fromDisplay: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
        subject,
        body,
      });
    } catch (err) {
      stats.summarize_errors++;
      console.warn('[cron-email-to-dossier] summarize failed', userId, messageId, err.message);
      continue;
    }

    const entry = {
      id: `email-${messageId}`,
      source: 'email',
      stageId: deal.stage,
      text: summary,
      fromName: fromName || null,
      fromEmail,
      subject: subject || null,
      gmailMessageId: messageId,
      gmailThreadId: msg?.threadId || null,
      createdAt: emailDateIso,
      read: false,
    };

    const filed = await appendNotesLogEntry(deal.id, deal.notesLog, entry);
    if (filed) {
      stats.filed++;
      deal.notesLog = [entry, ...deal.notesLog];
    } else {
      stats.patch_failures++;
    }
  }

  const finalTs = newestSeenIso > checkpoint ? newestSeenIso : new Date().toISOString();
  await updateCheckpoint(userId, {
    newTs: finalTs,
    status: 'ok',
    matches: stats.filed,
    notes: `candidates=${stats.candidates} matched=${stats.matched} filed=${stats.filed} errors=${stats.summarize_errors}`,
  });

  return { ok: true, status: 'complete', userId, checkpoint_before: checkpoint, checkpoint_after: finalTs, stats };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function authorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || '';
  return !!(CRON_SECRET && auth === `Bearer ${CRON_SECRET}`);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(200).json({ ok: true, status: 'skipped', reason: 'ANTHROPIC_API_KEY not set' });
  }
  const googleConfigured = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  const microsoftConfigured = !!(MICROSOFT_CLIENT_ID && MICROSOFT_CLIENT_SECRET);
  if (!googleConfigured && !microsoftConfigured) {
    return res.status(200).json({ ok: true, status: 'skipped', reason: 'no mail provider configured (GOOGLE_CLIENT_ID/SECRET and MICROSOFT_CLIENT_ID/SECRET both unset)' });
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

  const results = [];
  for (const customer of customers) {
    try {
      results.push(await runForCustomer(customer));
    } catch (err) {
      console.error('[cron-email-to-dossier] customer run failed', customer.userId, err && err.message);
      results.push({ ok: false, status: 'unhandled_error', userId: customer.userId, error: String(err && err.message || err) });
    }
  }

  return res.status(200).json({ ok: true, status: 'complete', customers: customers.length, results });
}

module.exports = withTelemetry('cron-email-to-dossier', handler);

module.exports.config = {
  maxDuration: 120,
};
