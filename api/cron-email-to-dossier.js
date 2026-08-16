// Vercel Serverless Function: /api/cron-email-to-dossier
//
// Watches Heath's own KW inbox (heath.shepard@kw.com) and files incoming
// emails into the correct transaction/dossier when the sender is an exact
// match on a counterparty already on file for an active deal (buyer, seller,
// buyer's agent, listing agent, title, lender). No fuzzy/AI-guessed matching
// in v1 — exact From-address match only, per Heath's 2026-08-12 ask.
//
// On a match:
//   1. Pull the message body (text/plain, falling back to stripped HTML).
//   2. One claude-haiku-4-5 call: summarize in 1-2 sentences, in the context
//      of the deal's current stage.
//   3. Append an entry to that transaction's notes_log jsonb column
//      (existing column/field — see src/utils/transactions.js in the Dossie
//      repo — reused rather than adding new schema). Entry carries
//      source:'email', stageId (deal's stage at ingest time), read:false so
//      the UI can badge it, plus from/subject/gmail ids for the "open thread"
//      link.
//
// No transaction match -> the email is left alone. No fuzzy matching in v1.
//
// Auth: reuses the same user_integrations OAuth row + lazy-refresh shape as
// api/cron-relevance-watcher.js / api/gmail-refresh.js / scripts/kw-mail.py.
// If the refresh_token itself is invalid_grant (revoked), this cron cannot
// self-heal -- Heath has to re-run Google consent (Connect Google Calendar
// button in /myjarvis). We send ONE Telegram alert the first time we see
// invalid_grant so that state doesn't sit silently broken for days.
//
// ENTITLEMENT GATE (added 2026-08-12, Heath via Cole mid-build): this is a
// paid add-on, not a free/built-in feature — it maps to the existing "Reply
// Monitoring — $10/mo" add-on already listed in docs/PRICING-HISTORY.md and
// shown (as a disabled "Coming Soon" card) in Dossie's Settings > Add-ons.
// NEITHER the other listed add-ons (AI Autopilot, Compliance Vault) NOR this
// one have any backend gating built anywhere in this repo today -- they are
// UI-only placeholders with a disabled checkbox. There was no existing
// pattern to copy. Rather than invent Stripe wiring or a self-serve toggle
// (explicitly out of scope per Heath's note), this gate reads
// subscriptions.reply_monitoring_enabled (real boolean column, added by
// supabase/migrations/20260812_reply_monitoring_addon.sql, applied 2026-08-12).
// Per-transaction-owner check (isReplyMonitoringEnabled(userId)) so this is
// already shaped correctly for the day this cron covers more than one
// mailbox -- today only HEATH_KW_USER_ID is ever checked.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — every 15 min (matches cron-relevance-watcher.js)

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-email-to-dossier');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const GMAIL_ACCOUNT = 'heath.shepard@kw.com';
// Same hardcoded id cron-relevance-watcher.js uses. (That file's comment says
// this account has no profiles row -- reconfirmed 2026-08-12 that it now
// does: profiles.id=0cd05e2f-... exists, plan='founding'. Leaving
// cron-relevance-watcher.js's comment alone, not this cron's problem to fix.)
const HEATH_KW_USER_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';
const HEATH_TELEGRAM_CHAT_ID = '7874782923';

const MAX_CANDIDATES = 50;
const MAX_SUMMARIZE_CALLS = 20; // cost guardrail, same discipline as relevance-watcher

// --------------------------------------------------------------------------
// Entitlement gate — see file header. Reads the real
// subscriptions.reply_monitoring_enabled column. Heath's own KW account is
// the builder/dogfood account, not a paying add-on subscriber -- always
// enabled for HEATH_KW_USER_ID, never gated behind its own price.
// --------------------------------------------------------------------------

async function isReplyMonitoringEnabled(userId) {
  if (userId === HEATH_KW_USER_ID) return true; // builder/dogfood account, never gated
  try {
    const res = await supaFetch(
      `subscriptions?select=reply_monitoring_enabled&user_id=eq.${encodeURIComponent(userId)}&status=eq.active&order=updated_at.desc&limit=1`,
    );
    if (!res.ok) return false;
    const rows = await res.json().catch(() => []);
    return !!(rows && rows[0] && rows[0].reply_monitoring_enabled === true);
  } catch (err) {
    // Any error -> NOT entitled. Fail closed, never fail open on a paid gate.
    console.warn('[cron-email-to-dossier] entitlement check failed, failing closed', err.message);
    return false;
  }
}

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

async function getCheckpoint() {
  const res = await supaFetch('email_watcher_state?tier=eq.dossier-file&select=last_check_ts');
  if (!res.ok) throw new Error(`checkpoint fetch failed: ${res.status}`);
  const rows = await res.json();
  const fallback = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  return rows && rows[0] ? rows[0].last_check_ts : fallback;
}

async function updateCheckpoint({ newTs, status, matches, notes }) {
  const patch = {
    last_check_ts: newTs,
    last_run_at: new Date().toISOString(),
    last_run_status: status,
    last_run_notes: notes ? String(notes).slice(0, 500) : null,
    matches_last_run: matches,
    updated_at: new Date().toISOString(),
  };
  const res = await supaFetch('email_watcher_state?tier=eq.dossier-file', {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    console.warn('[cron-email-to-dossier] checkpoint update failed', res.status, await res.text().catch(() => ''));
  }
}

// Active (non-closed) transactions for Heath's own KW account, with every
// counterparty email address we might match against. Pulls both the
// structured `parties` jsonb (buyer/seller/buyerAgent/listingAgent/title/
// lender) and the handful of flat email columns some deals populate instead.
async function loadActiveDealsWithContacts() {
  const res = await supaFetch(
    `transactions?user_id=eq.${encodeURIComponent(HEATH_KW_USER_ID)}&status=neq.closed` +
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
      // parties.*.email can hold comma-separated multiples (seen on real
      // Wild Cherry data: "TomLintonTX@Gmail.com, cmlinton88@gmail.com").
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
// Gmail (same OAuth row kw-mail.py / gmail-refresh.js / relevance-watcher use)
// --------------------------------------------------------------------------

async function loadGoogleTokens() {
  const res = await supaFetch(
    `user_integrations?select=access_token,refresh_token,expires_at&google_email=eq.${encodeURIComponent(GMAIL_ACCOUNT)}&limit=1`,
  );
  if (!res.ok) throw new Error(`user_integrations fetch failed: ${res.status}`);
  const rows = await res.json().catch(() => []);
  if (!rows || !rows.length) throw new Error('no_google_integration_row_for_heath_kw');
  return rows[0];
}

async function persistAccessToken(accessToken, expiresAt) {
  await supaFetch(`user_integrations?google_email=eq.${encodeURIComponent(GMAIL_ACCOUNT)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt }),
  }).catch((e) => console.warn('[cron-email-to-dossier] token persist failed', e.message));
}

async function refreshGoogleToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || `http_${res.status}`;
    const err = new Error(`google_refresh_failed:${detail}`);
    err.isInvalidGrant = data?.error === 'invalid_grant';
    throw err;
  }
  return data;
}

async function gmailFetch(accessToken, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`gmail_api_failed:${path}:${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function headerMap(headers) {
  const m = {};
  for (const h of headers || []) m[h.name.toLowerCase()] = h.value || '';
  return m;
}

function parseFromHeader(fromHeader) {
  const m = String(fromHeader || '').match(/^(?:"?([^"<]+?)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?$/);
  if (!m) return { name: '', email: (fromHeader || '').trim().toLowerCase() };
  return { name: (m[1] || '').trim(), email: (m[2] || '').trim().toLowerCase() };
}

// Walk the MIME tree for text/plain, falling back to stripped text/html.
// Ports scripts/kw-mail.py's body_of() to JS.
function bodyOfMessage(msg) {
  const plainParts = [];
  const htmlParts = [];
  const walk = (part) => {
    if (!part) return;
    const mimeType = part.mimeType || '';
    const data = part.body && part.body.data;
    if (data) {
      const txt = Buffer.from(data, 'base64url').toString('utf-8');
      if (mimeType === 'text/plain') plainParts.push(txt);
      else if (mimeType === 'text/html') htmlParts.push(txt);
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  if (plainParts.length) return plainParts.join('\n');
  if (htmlParts.length) return htmlParts.join('\n').replace(/<[^>]+>/g, ' ');
  return msg.snippet || '';
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
// Telegram — one-shot alert when the Google refresh token is dead. Not the
// per-email notify Heath hasn't approved yet (that's cron-relevance-watcher's
// RELEVANCE_WATCHER_NOTIFY flag, separate decision) -- this is purely "your
// Gmail connection broke, go reconnect it" so it doesn't sit silent.
// --------------------------------------------------------------------------

async function sendInvalidGrantAlertOnce(alreadyAlerted) {
  if (alreadyAlerted) return; // only alert on the transition into broken, not every 15 min
  if (!TELEGRAM_BOT_TOKEN) return;
  const text = [
    '⚠️ Gmail connection to Dossie broke.',
    'Google revoked the refresh token for heath.shepard@kw.com (invalid_grant) -- likely a KW Workspace reauth policy, not a bug.',
    'Fix: open /myjarvis and click "Connect Google Calendar" again to re-consent.',
  ].join('\n');
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: HEATH_TELEGRAM_CHAT_ID, text }),
  }).catch((e) => console.warn('[cron-email-to-dossier] telegram alert failed', e.message));
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
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(200).json({ ok: true, status: 'skipped', reason: 'GOOGLE_CLIENT_ID/SECRET not set' });
  }

  // Paid add-on gate ("Reply Monitoring") — only run the pipeline for
  // entitled accounts. Today this cron only ever looks at HEATH_KW_USER_ID's
  // mailbox, so a single check up front is equivalent to per-deal checks;
  // when this covers more than one mailbox, gate per deal owner instead of
  // (or in addition to) here.
  if (!(await isReplyMonitoringEnabled(HEATH_KW_USER_ID))) {
    return res.status(200).json({ ok: true, status: 'skipped', reason: 'reply_monitoring_not_enabled', user_id: HEATH_KW_USER_ID });
  }

  const stats = { candidates: 0, matched: 0, filed: 0, summarize_errors: 0, patch_failures: 0 };

  let checkpointRow;
  try {
    const cpRes = await supaFetch('email_watcher_state?tier=eq.dossier-file&select=last_check_ts,last_run_status');
    const cpRows = cpRes.ok ? await cpRes.json() : [];
    checkpointRow = cpRows && cpRows[0];
  } catch (_) { /* fall through to getCheckpoint's own fallback */ }

  let checkpoint;
  try {
    checkpoint = await getCheckpoint();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'checkpoint_read_failed', detail: String(err.message || err) });
  }

  let tokens;
  try {
    tokens = await loadGoogleTokens();
  } catch (err) {
    await updateCheckpoint({ newTs: checkpoint, status: 'error', matches: 0, notes: String(err.message || err) });
    return res.status(200).json({ ok: false, status: 'no_google_integration', error: String(err.message || err) });
  }

  let accessToken = tokens.access_token;
  let hitInvalidGrant = false;

  async function gmailFetchWithRefresh(path, params) {
    try {
      return await gmailFetch(accessToken, path, params);
    } catch (err) {
      if (err.status === 401) {
        const refreshed = await refreshGoogleToken(tokens.refresh_token);
        accessToken = refreshed.access_token;
        const expiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
        await persistAccessToken(accessToken, expiresAt);
        return await gmailFetch(accessToken, path, params);
      }
      throw err;
    }
  }

  const afterEpoch = Math.floor(new Date(checkpoint).getTime() / 1000) - 60;
  const q = [`after:${afterEpoch}`, '-in:sent', '-in:drafts', '-in:spam', '-in:trash', '-in:chats'].join(' ');

  let listResp;
  try {
    listResp = await gmailFetchWithRefresh('messages', { q, maxResults: String(MAX_CANDIDATES) });
  } catch (err) {
    hitInvalidGrant = err.isInvalidGrant || /invalid_grant/i.test(String(err.message || ''));
    if (hitInvalidGrant) await sendInvalidGrantAlertOnce(checkpointRow?.last_run_status === 'error');
    await updateCheckpoint({ newTs: checkpoint, status: 'error', matches: 0, notes: `gmail_list_failed:${String(err.message || err)}` });
    return res.status(200).json({ ok: false, status: 'gmail_list_failed', error: String(err.message || err) });
  }

  const messageIds = (listResp?.messages || []).map((m) => m.id);
  stats.candidates = messageIds.length;

  let deals = [];
  try {
    deals = await loadActiveDealsWithContacts();
  } catch (err) {
    await updateCheckpoint({ newTs: checkpoint, status: 'error', matches: 0, notes: `deals_load_failed:${String(err.message || err)}` });
    return res.status(200).json({ ok: false, status: 'deals_load_failed', error: String(err.message || err) });
  }

  let newestSeenIso = checkpoint;
  let summarizeCallsUsed = 0;

  for (const messageId of messageIds) {
    let msg;
    try {
      msg = await gmailFetchWithRefresh(`messages/${messageId}`, { format: 'full' });
    } catch (err) {
      console.warn('[cron-email-to-dossier] message fetch failed', messageId, err.message);
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
    if (!deal) continue; // no exact match -- v1 leaves it alone, no fuzzy guessing

    stats.matched++;

    // Dedupe: already filed this exact message into this deal.
    if (deal.notesLog.some((n) => n.gmailMessageId === messageId)) continue;

    if (summarizeCallsUsed >= MAX_SUMMARIZE_CALLS) continue; // cost guardrail, picked up next run

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
      console.warn('[cron-email-to-dossier] summarize failed', messageId, err.message);
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
      deal.notesLog = [entry, ...deal.notesLog]; // keep in-memory copy current for this run's dedupe
    } else {
      stats.patch_failures++;
    }
  }

  const finalTs = newestSeenIso > checkpoint ? newestSeenIso : new Date().toISOString();
  await updateCheckpoint({
    newTs: finalTs,
    status: 'ok',
    matches: stats.filed,
    notes: `candidates=${stats.candidates} matched=${stats.matched} filed=${stats.filed} errors=${stats.summarize_errors}`,
  });

  return res.status(200).json({ ok: true, status: 'complete', checkpoint_before: checkpoint, checkpoint_after: finalTs, stats });
}

module.exports = withTelemetry('cron-email-to-dossier', handler);

module.exports.config = {
  maxDuration: 90,
};
