// Vercel Serverless Function: /api/cron-inbox-scan
//
// Autonomous inbox monitor for Heath's Gmail. Pings Telegram when a HUMAN
// replies to an outbound blast (founding-member emails, cold outreach,
// grant follow-ups) or writes cold-inbound to a Dossie address.
//
// SV-INBOX-001 (Atlas, 2026-07-02).
//
// Schedule: 7 * * * * (hourly, off-minute) — vercel.json.
//
// Auth: Vercel cron header OR Authorization: Bearer $CRON_SECRET.
//
// Data model: inbox_alerts(gmail_message_id PK, alerted_at, ...) is the
// debounce log. We NEVER store email body content.
//
// Backfill: on first run (empty inbox_alerts), scan last 48h. Otherwise 2h
// window (+ small overlap to survive cron misfires).
//
// Env:
//   GMAIL_CLIENT_ID       - Google OAuth 2.0 client id
//   GMAIL_CLIENT_SECRET   - Google OAuth 2.0 client secret
//   GMAIL_REFRESH_TOKEN   - Long-lived refresh token from consent flow
//                           (scope: https://www.googleapis.com/auth/gmail.readonly)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   CRON_SECRET
//
// Optional env:
//   INBOX_SCAN_DRY_RUN=1   - Fetch + filter but do NOT send Telegram or
//                            write inbox_alerts rows. For staging APV.
//   INBOX_SCAN_TEST_MODE=1 - Same as DRY_RUN but also relaxes the debounce
//                            check so a known message can be re-simulated.

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;

const DRY_RUN = process.env.INBOX_SCAN_DRY_RUN === '1' || process.env.INBOX_SCAN_TEST_MODE === '1';
const TEST_MODE = process.env.INBOX_SCAN_TEST_MODE === '1';

// --------------------------------------------------------------------------
// Filters
// --------------------------------------------------------------------------

// From-header patterns we always drop.
const BLOCKED_FROM_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /do[-_.]?not[-_.]?reply@/i,
  /donotreply@/i,
  /automated@/i,
  /notifications?@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /bounces?@/i,
  /autoresponder@/i,
  /alerts?@/i,
  /support@vercel\.com/i,
  /support@supabase\.io/i,
  /noreply@stripe\.com/i,
  /noreply@github\.com/i,
  /notifications@github\.com/i,
  /notifications@linkedin\.com/i,
  /invitations@linkedin\.com/i,
  /noreply@linkedin\.com/i,
  /jobs-noreply@linkedin\.com/i,
  /messages-noreply@linkedin\.com/i,
  /noreply@calendar\.google\.com/i,
  /calendar-notification@google\.com/i,
  /noreply@youtube\.com/i,
  /noreply@zapier\.com/i,
  /notify@zernio\.com/i,
];

// Subject patterns that scream "automated".
const BLOCKED_SUBJECT_PATTERNS = [
  /^your (order|receipt|invoice|shipment)/i,
  /^order confirmation/i,
  /^payment received/i,
  /^delivery (update|notification)/i,
  /^you (were|have been) mentioned/i,
  /security alert/i,
  /new sign[- ]in/i,
  /verification code/i,
  /^welcome to /i,
  /^your (weekly|monthly|daily) (digest|summary|report)/i,
  /^(re: )?linkedin/i,
  /wants to connect/i,
  /viewed your profile/i,
];

// Gmail labels we always drop. Query uses -in:promotions -in:updates -in:social.
// This is a belt-and-suspenders check on the message payload.
const BLOCKED_LABEL_IDS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SPAM', 'TRASH', 'DRAFT']);

// Dossie-related inbound addresses that flag ANY sender as noteworthy
// (used to detect cold inbounds without a prior chain).
const DOSSIE_INBOUND_ADDRESSES = [
  /heath@meetdossie\.com/i,
  /hello@meetdossie\.com/i,
  /support@meetdossie\.com/i,
];

// --------------------------------------------------------------------------
// Gmail OAuth
// --------------------------------------------------------------------------

async function getGmailAccessToken() {
  const params = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    client_secret: GMAIL_CLIENT_SECRET,
    refresh_token: GMAIL_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || `status_${res.status}`;
    const err = new Error(`gmail_token_refresh_failed:${detail}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data.access_token;
}

async function gmailFetch(accessToken, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(`gmail_api_failed:${path}:${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// --------------------------------------------------------------------------
// Supabase (debounce log)
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

async function alertRowCount() {
  const res = await supaFetch('inbox_alerts?select=gmail_message_id&limit=1', {
    method: 'GET',
    headers: { Prefer: 'count=exact' },
  });
  if (!res.ok) return 0;
  const range = res.headers.get('content-range') || '';
  const match = range.match(/\/(\d+)$/);
  if (match) return parseInt(match[1], 10);
  return 0;
}

async function alreadyAlerted(messageId) {
  if (TEST_MODE) return false;
  const res = await supaFetch(
    `inbox_alerts?gmail_message_id=eq.${encodeURIComponent(messageId)}&select=gmail_message_id&limit=1`,
    { method: 'GET' }
  );
  if (!res.ok) return false;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function recordAlert(row) {
  if (DRY_RUN) return { ok: true, skipped: true };
  const res = await supaFetch('inbox_alerts', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: text };
  }
  return { ok: true };
}

// --------------------------------------------------------------------------
// Telegram
// --------------------------------------------------------------------------

async function sendTelegram(text) {
  if (DRY_RUN) return { ok: true, skipped: true };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data?.ok, status: res.status, data };
}

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --------------------------------------------------------------------------
// Filter helpers
// --------------------------------------------------------------------------

function headerMap(headers) {
  const m = {};
  for (const h of headers || []) m[h.name.toLowerCase()] = h.value || '';
  return m;
}

function parseFromHeader(fromHeader) {
  // "Jane Doe <jane@example.com>" or "jane@example.com"
  const m = String(fromHeader || '').match(/^(?:"?([^"<]+?)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?$/);
  if (!m) return { name: '', email: (fromHeader || '').trim() };
  return { name: (m[1] || '').trim(), email: (m[2] || '').trim() };
}

function isBlockedFrom(fromEmail) {
  return BLOCKED_FROM_PATTERNS.some((rx) => rx.test(fromEmail));
}

function isBlockedSubject(subject) {
  return BLOCKED_SUBJECT_PATTERNS.some((rx) => rx.test(subject));
}

function hasBlockedLabel(labelIds) {
  if (!Array.isArray(labelIds)) return false;
  for (const lid of labelIds) if (BLOCKED_LABEL_IDS.has(lid)) return true;
  return false;
}

function isReplyOrForward(subject, inReplyTo, references) {
  if (inReplyTo && inReplyTo.trim().length > 0) return true;
  if (references && references.trim().length > 0) return true;
  if (/^(re|fwd|fw):/i.test((subject || '').trim())) return true;
  return false;
}

function toDossieInbox(toHeader) {
  const to = String(toHeader || '');
  return DOSSIE_INBOUND_ADDRESSES.some((rx) => rx.test(to));
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function authorized(req) {
  // Vercel cron sets x-vercel-cron header. Also accept Bearer $CRON_SECRET.
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  return false;
}

function envSummary() {
  return {
    supabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    gmail_oauth: !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN),
    dry_run: DRY_RUN,
    test_mode: TEST_MODE,
  };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const env = envSummary();
  if (!env.supabase || !env.telegram) {
    return res.status(500).json({ ok: false, error: 'core_env_missing', env });
  }
  if (!env.gmail_oauth) {
    // Return 200 so cron telemetry doesn't spam "error" until Heath finishes
    // the one-time OAuth consent. Body clearly says gmail_not_configured.
    return res.status(200).json({
      ok: true,
      status: 'gmail_not_configured',
      env,
      note: 'Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in Vercel to activate scanning.',
    });
  }

  // Determine scan window. If inbox_alerts is empty, backfill 48h. Otherwise 2h + 10min overlap.
  let backfill = false;
  try {
    const count = await alertRowCount();
    backfill = count === 0;
  } catch { /* fall through: assume not backfill */ }

  const now = Math.floor(Date.now() / 1000);
  const windowSeconds = backfill ? 48 * 3600 : (2 * 3600 + 10 * 60);
  const after = now - windowSeconds;

  // Gmail search query. Newest first. Cap at 50 candidates per run.
  const q = [
    `after:${after}`,
    '-from:noreply',
    '-from:no-reply',
    '-from:donotreply',
    '-from:do-not-reply',
    '-from:notifications',
    '-from:mailer-daemon',
    '-from:postmaster',
    '-category:promotions',
    '-category:updates',
    '-category:social',
    '-category:forums',
    '-in:sent',
    '-in:drafts',
    '-in:spam',
    '-in:trash',
  ].join(' ');

  let accessToken;
  try {
    accessToken = await getGmailAccessToken();
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: 'gmail_token_refresh_failed',
      error: String(err?.message || err),
      env,
    });
  }

  let listResp;
  try {
    listResp = await gmailFetch(accessToken, 'messages', {
      q,
      maxResults: '50',
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: 'gmail_list_failed',
      error: String(err?.message || err),
    });
  }

  const messageIds = (listResp?.messages || []).map((m) => m.id);
  const stats = {
    window_seconds: windowSeconds,
    backfill,
    candidates: messageIds.length,
    already_alerted: 0,
    filtered_blocked_from: 0,
    filtered_blocked_subject: 0,
    filtered_blocked_label: 0,
    filtered_not_reply_or_dossie: 0,
    alerts_sent: 0,
    telegram_failures: 0,
    debug: [],
  };

  for (const messageId of messageIds) {
    if (await alreadyAlerted(messageId)) {
      stats.already_alerted++;
      continue;
    }

    let msg;
    try {
      msg = await gmailFetch(accessToken, `messages/${messageId}`, {
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'In-Reply-To', 'References', 'Date'],
      });
    } catch (err) {
      stats.debug.push({ id: messageId, err: String(err?.message || err) });
      continue;
    }

    if (hasBlockedLabel(msg?.labelIds)) {
      stats.filtered_blocked_label++;
      continue;
    }

    const hdr = headerMap(msg?.payload?.headers);
    const { name: fromName, email: fromEmail } = parseFromHeader(hdr['from']);
    const subject = hdr['subject'] || '';
    const inReplyTo = hdr['in-reply-to'] || '';
    const references = hdr['references'] || '';
    const toHeader = hdr['to'] || '';

    if (isBlockedFrom(fromEmail) || isBlockedFrom(hdr['from'] || '')) {
      stats.filtered_blocked_from++;
      continue;
    }
    if (isBlockedSubject(subject)) {
      stats.filtered_blocked_subject++;
      continue;
    }

    const looksLikeReply = isReplyOrForward(subject, inReplyTo, references);
    const dossieInbound = toDossieInbox(toHeader);

    if (!looksLikeReply && !dossieInbound) {
      stats.filtered_not_reply_or_dossie++;
      continue;
    }

    // Passed all filters. Build the alert.
    const snippet = (msg?.snippet || '').trim().slice(0, 240);
    const senderDisplay = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
    const threadUrl = msg?.threadId ? `https://mail.google.com/mail/u/0/#inbox/${msg.threadId}` : null;

    const parts = [
      `📬 <b>New reply</b> from ${escapeHtml(senderDisplay)}`,
      `<b>Subject:</b> ${escapeHtml(subject || '(no subject)')}`,
    ];
    if (snippet) parts.push(`<i>${escapeHtml(snippet)}</i>`);
    if (threadUrl) parts.push(`<a href="${threadUrl}">Open thread</a>`);

    const tg = await sendTelegram(parts.join('\n\n'));
    if (!tg.ok) {
      stats.telegram_failures++;
      // Do NOT record alert row — retry next cron cycle.
      continue;
    }

    const rec = await recordAlert({
      gmail_message_id: messageId,
      gmail_thread_id: msg?.threadId || null,
      sender: fromEmail || null,
      subject: subject ? subject.slice(0, 500) : null,
      account: 'primary',
    });
    if (!rec.ok) {
      stats.debug.push({ id: messageId, record_err: rec });
    }
    stats.alerts_sent++;
  }

  return res.status(200).json({ ok: true, status: 'complete', env, stats });
}

module.exports = withTelemetry('cron-inbox-scan', handler);
