// Vercel Serverless Function: /api/cron-relevance-watcher
//
// Broad relevance scan of Heath's KW inbox (heath.shepard@kw.com). Unlike the
// tier1/tier2 sender-pattern watchers (SV-EMAIL-001, api/email-watcher-state.js
// — narrow allow-lists of sender domains for veteran-grant programs and paying
// customers), this cron scans EVERYTHING that isn't obvious bulk mail and asks
// a cheap model whether it touches one of Heath's active deals, a known client,
// or the Dossie/MeetDossie business itself.
//
// Pipeline per run:
//   1. Read checkpoint from email_watcher_state (tier='relevance').
//   2. List Gmail messages since checkpoint, Gmail-side category/bulk filters
//      already applied in the search query (mirrors cron-inbox-scan.js).
//   3. Per-candidate cheap prefilter: List-Unsubscribe header, known ESP/
//      newsletter sender domains, noreply-style senders. No model call spent
//      on anything that fails this.
//   4. Build the relevance context fresh each run: active (non-closed)
//      transactions for Heath's own KW account (property + buyer/seller
//      names), a small static known-clients list, and the Dossie/MeetDossie
//      allow-list (brand terms + known customer emails/domains, kept in sync
//      with docs/CUSTOMERS.md by hand).
//   5. ONE claude-haiku-4-5 call per surviving candidate — classify relevant
//      y/n, matched deal/person, <=2 sentence reason. No agentic loop, no
//      multi-turn, no big model. Cost discipline is deliberate here — see
//      api/_lib/paused-crons.js for the 2026-07-03 cost-freeze history that
//      makes "one small call per item, nothing bigger" the house rule for any
//      cron that touches the Anthropic API on unbounded input.
//   6. Relevant hits -> INSERT into relevance_watch_hits (landing zone only).
//   7. Checkpoint update on email_watcher_state, same shape tier1/tier2 use.
//
// v1 is DRY-RUN ONLY. Nothing here sends a Telegram message or any other
// notification — Heath has not chosen a channel/frequency yet. The send step
// is fully written (sendRelevanceTelegramAlert) but only fires behind the
// RELEVANCE_WATCHER_NOTIFY=1 env flag, which is intentionally NOT set in
// Vercel. Flip that var on (and only that var) when Heath approves going
// live; no code change needed at that point.
//
// Gmail auth: reuses the user_integrations OAuth row for heath.shepard@kw.com
// that scripts/kw-mail.py and api/gmail-refresh.js already read/write (Google
// token refresh done in-process here rather than via an HTTP hop to
// /api/gmail-refresh, since this function already holds
// SUPABASE_SERVICE_ROLE_KEY + GOOGLE_CLIENT_ID/SECRET directly).
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "*/15 * * * *"

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// OFF by default and on purpose — see file header. Do not flip in code; this
// only ever gets turned on by setting the env var in Vercel after Heath signs
// off on channel + frequency.
const NOTIFY_ENABLED = process.env.RELEVANCE_WATCHER_NOTIFY === '1';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const GMAIL_ACCOUNT = 'heath.shepard@kw.com';
// auth.users.id for heath.shepard@kw.com. Hardcoded rather than looked up
// because this account has no `profiles` row (Heath uses the app as its
// builder, not through the normal signup path) — there's nothing to join
// through. Same style as the hardcoded HEATH_CHAT_ID in
// cron-activation-triage.js. Confirmed 2026-08-06 via auth.users.
const HEATH_KW_USER_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';
const HEATH_TELEGRAM_CHAT_ID = '7874782923';

const MAX_CANDIDATES = 50;      // Gmail messages.list cap per run
const MAX_CLASSIFY_CALLS = 25;  // hard ceiling on Haiku calls per run, cost guardrail

// --------------------------------------------------------------------------
// Known-clients / business allow-list — static, hand-maintained.
//
// Deals are NOT hardcoded here (they change) — those come live from the
// transactions table each run. This list is for people/entities that matter
// to Heath but may not always have an open transactions row: named clients
// he's asked to be watched for, and the Dossie/MeetDossie business itself
// (customer support, sales inquiries). Keep in sync with docs/CUSTOMERS.md
// when the roster changes.
// --------------------------------------------------------------------------
const STATIC_KNOWN_CLIENTS = [
  { name: 'Kanika Jain', note: 'STR investor client, bought 9210 Serene Creek 2024, back for a second property' },
  { name: 'Ketan Thakkar', note: 'STR investor client, same household as Kanika Jain' },
];

const DOSSIE_BUSINESS_TERMS = ['Dossie', 'MeetDossie', 'meetdossie.com'];

// docs/CUSTOMERS.md roster, 2026-08-04 snapshot. Company-domain customers
// listed by domain (catches any address at that domain); gmail-based
// customers listed by exact address (a bare "gmail.com" allow-list would
// match nearly everything and defeat the point of prefiltering).
const KNOWN_CUSTOMER_CONTACTS = [
  { label: 'Brittney YBarbo (SETX Realty)', match: '@setxrealty.com' },
  { label: 'Suzanne Page', match: 'k.suzanne.page@gmail.com' },
  { label: 'Miki Mccarthy', match: 'mikirgvrealtor@gmail.com' },
  { label: 'Cecilia Whitley (Sterling & Associates)', match: '@sterlingassociatesre.com' },
  { label: 'Terry Katz', match: 'michellesellshouston@gmail.com' },
  { label: 'Amanda Nuckles', match: '@amandanuckles.com' },
  { label: 'Zelda Cain (A2Z Real Estate Consultants)', match: '@a2zrealestateconsultants.com' },
  { label: 'Natalie Megerson (Local Choice Group)', match: '@localchoicegroup.com' },
  { label: 'Jennifer Beltran (Casa Mia)', match: 'jenn.casamiateam@gmail.com' },
  { label: 'Lisa Nilsson (Premier Hill Country Properties)', match: 'lisanilssontx@gmail.com' },
];

// --------------------------------------------------------------------------
// Cheap bulk-mail prefilter — runs before any model call.
// --------------------------------------------------------------------------

const ESP_DOMAINS = [
  'mailchimp.com', 'mailchimpapp.net', 'list-manage.com',
  'sendgrid.net', 'sendgrid.com',
  'constantcontact.com', 'ccsend.com',
  'klaviyomail.com', 'klaviyo.com',
  'hubspotemail.net', 'hs-send.net', 'hubspot.com',
  'salesforce.com', 'exacttarget.com', 'marketingcloud.com',
  'mailgun.org', 'mailgun.net',
  'sparkpostmail.com', 'sparkpost.com',
  'activehosted.com', 'activecampaign.com',
  'getresponse.com',
  'aweber.com',
  'campaign-archive.com', 'campaignmonitor.com', 'createsend.com',
  'substack.com',
  'beehiiv.com',
  'mandrillapp.com',
  'e.customericare.com',
  'marketo.com', 'mktoresp.com',
  'braze.com',
  'iterable.com',
  'sendinblue.com', 'brevo.com',
  'convertkit.com', 'ck.page',
  'zernio.com',
];

const NOREPLY_FROM_PATTERNS = [
  /noreply@/i, /no-reply@/i, /do[-_.]?not[-_.]?reply@/i, /donotreply@/i,
  /automated@/i, /notifications?@/i, /mailer-daemon@/i, /postmaster@/i,
  /bounces?@/i, /autoresponder@/i, /marketing@/i, /newsletter@/i,
];

const BLOCKED_LABEL_IDS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SPAM', 'TRASH', 'DRAFT']);

function domainOf(email) {
  const m = String(email || '').match(/@([^@>\s]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function isBulkMail({ fromEmail, hasListUnsubscribe, labelIds }) {
  if (hasListUnsubscribe) return 'list_unsubscribe_header';
  if (hasBlockedLabel(labelIds)) return 'gmail_category_label';
  const domain = domainOf(fromEmail);
  if (domain && ESP_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return 'esp_domain';
  if (NOREPLY_FROM_PATTERNS.some((rx) => rx.test(fromEmail))) return 'noreply_pattern';
  return null;
}

function hasBlockedLabel(labelIds) {
  if (!Array.isArray(labelIds)) return false;
  for (const lid of labelIds) if (BLOCKED_LABEL_IDS.has(lid)) return true;
  return false;
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
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  return res;
}

async function getCheckpoint() {
  const res = await supaFetch('email_watcher_state?tier=eq.relevance&select=last_check_ts', { method: 'GET' });
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
  const res = await supaFetch('email_watcher_state?tier=eq.relevance', {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    console.warn('[cron-relevance-watcher] checkpoint update failed', res.status, await res.text().catch(() => ''));
  }
}

async function loadActiveDeals() {
  const res = await supaFetch(
    `transactions?user_id=eq.${encodeURIComponent(HEATH_KW_USER_ID)}&status=neq.closed` +
    `&select=property_address,buyer_name,seller_name,client_names,dossier_number,stage`,
    { method: 'GET' },
  );
  if (!res.ok) {
    console.warn('[cron-relevance-watcher] transactions fetch failed', res.status);
    return [];
  }
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => (r.property_address || r.buyer_name || r.seller_name || r.client_names))
    .map((r) => ({
      address: r.property_address || null,
      buyer: r.buyer_name || null,
      seller: r.seller_name || null,
      client_names: r.client_names || null,
      stage: r.stage || null,
    }));
}

async function loadGoogleTokens() {
  const res = await supaFetch(
    `user_integrations?select=access_token,refresh_token,expires_at&google_email=eq.${encodeURIComponent(GMAIL_ACCOUNT)}&limit=1`,
    { method: 'GET' },
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
  }).catch((e) => console.warn('[cron-relevance-watcher] token persist failed', e.message));
}

async function insertHit(row) {
  const res = await supaFetch('relevance_watch_hits', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.warn('[cron-relevance-watcher] hit insert failed', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
}

// --------------------------------------------------------------------------
// Gmail (same OAuth row kw-mail.py / gmail-refresh.js use, refreshed in-process)
// --------------------------------------------------------------------------

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
    throw new Error(`google_refresh_failed:${detail}`);
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
  if (!m) return { name: '', email: (fromHeader || '').trim() };
  return { name: (m[1] || '').trim(), email: (m[2] || '').trim() };
}

// --------------------------------------------------------------------------
// Relevance classification — one Haiku call per surviving candidate.
// --------------------------------------------------------------------------

function buildContextBlock(deals) {
  const dealLines = deals.length
    ? deals.map((d) => {
        const bits = [d.address, d.buyer && `buyer: ${d.buyer}`, d.seller && `seller: ${d.seller}`, d.client_names && `client: ${d.client_names}`, d.stage && `stage: ${d.stage}`]
          .filter(Boolean);
        return `- ${bits.join(' | ')}`;
      }).join('\n')
    : '- (no active deals in Dossie right now)';

  const clientLines = STATIC_KNOWN_CLIENTS.map((c) => `- ${c.name} (${c.note})`).join('\n');
  const customerLines = KNOWN_CUSTOMER_CONTACTS.map((c) => `- ${c.label}: ${c.match}`).join('\n');

  return [
    'Heath Shepard is a Texas REALTOR (heath.shepard@kw.com) and also built a product called Dossie/MeetDossie.',
    '',
    'His CURRENT ACTIVE DEALS (property/buyer/seller — an email about any of these matters):',
    dealLines,
    '',
    'Known CLIENTS to watch for even without an open deal right now:',
    clientLines,
    '',
    'Dossie/MeetDossie business terms (customer support, sales, product mentions):',
    DOSSIE_BUSINESS_TERMS.join(', '),
    '',
    'Known Dossie CUSTOMERS (emails from these people about their Dossie account matter):',
    customerLines,
  ].join('\n');
}

const CLASSIFY_SYSTEM_PROMPT = `You classify a single email for relevance to a Texas real estate agent's active work. You will be given context (his active deals, known clients, and his own product/business) and one email's From/Subject/Snippet.

Reply in EXACTLY this format, nothing else:
RELEVANT: yes or no
MATCH: <short name of the deal/person/business it matches, or "n/a">
REASON: <one or two sentences, plain, no fluff>

Mark RELEVANT: yes only if the email is plausibly about one of the named deals/people/business — not just because it's real-estate-adjacent in general. Routine automated notifications, unrelated cold outreach, and generic industry newsletters that slipped past the bulk filter are RELEVANT: no.`;

async function classifyEmail({ fromDisplay, subject, snippet }, contextBlock) {
  const userMsg = [
    contextBlock,
    '',
    '---',
    `From: ${fromDisplay}`,
    `Subject: ${subject || '(no subject)'}`,
    `Snippet: ${(snippet || '').slice(0, 400)}`,
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
      max_tokens: 150,
      system: CLASSIFY_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`haiku_classify_failed:${res.status}:${err.slice(0, 160)}`);
  }
  const json = await res.json();
  const text = ((json?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')).trim();

  const relevantMatch = text.match(/RELEVANT:\s*(yes|no)/i);
  const matchMatch = text.match(/MATCH:\s*(.+)/i);
  const reasonMatch = text.match(/REASON:\s*(.+)/is);

  return {
    relevant: !!relevantMatch && /yes/i.test(relevantMatch[1]),
    matched: matchMatch ? matchMatch[1].trim().slice(0, 200) : null,
    reason: reasonMatch ? reasonMatch[1].trim().split('\n')[0].slice(0, 500) : null,
    raw: text,
  };
}

// --------------------------------------------------------------------------
// Telegram — written, feature-flagged OFF. See file header.
// --------------------------------------------------------------------------

async function sendRelevanceTelegramAlert(hit) {
  if (!NOTIFY_ENABLED) return { ok: true, skipped: true, reason: 'notify_disabled' };
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, skipped: true, reason: 'no_telegram_token' };
  const text = [
    `📧 <b>Relevant email</b> — ${hit.matched_deal_or_person || 'unmatched'}`,
    `From: ${hit.from_name ? `${hit.from_name} <${hit.from_email}>` : hit.from_email}`,
    `Subject: ${hit.subject || '(no subject)'}`,
    hit.reason ? `<i>${hit.reason}</i>` : null,
    hit.gmail_thread_id ? `<a href="https://mail.google.com/mail/u/0/#inbox/${hit.gmail_thread_id}">Open thread</a>` : null,
  ].filter(Boolean).join('\n\n');

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: HEATH_TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data?.ok, status: res.status };
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

  const stats = {
    dry_run: !NOTIFY_ENABLED,
    candidates: 0,
    prefiltered_bulk: 0,
    classified: 0,
    relevant_hits: 0,
    classify_errors: 0,
    insert_failures: 0,
  };

  let checkpoint;
  try {
    checkpoint = await getCheckpoint();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'checkpoint_read_failed', detail: String(err.message || err) });
  }

  // Gmail auth: try the stored access token first, refresh on 401 — same
  // lazy-refresh shape as scripts/kw-mail.py's g()/refresh().
  let tokens;
  try {
    tokens = await loadGoogleTokens();
  } catch (err) {
    await updateCheckpoint({ newTs: checkpoint, status: 'error', matches: 0, notes: String(err.message || err) });
    return res.status(200).json({ ok: false, status: 'no_google_integration', error: String(err.message || err) });
  }

  let accessToken = tokens.access_token;

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

  const afterEpoch = Math.floor(new Date(checkpoint).getTime() / 1000) - 60; // 60s overlap for cron-timing slop
  const q = [
    `after:${afterEpoch}`,
    '-category:promotions',
    '-category:updates',
    '-category:social',
    '-category:forums',
    '-in:sent',
    '-in:drafts',
    '-in:spam',
    '-in:trash',
    '-in:chats',
  ].join(' ');

  let listResp;
  try {
    listResp = await gmailFetchWithRefresh('messages', { q, maxResults: String(MAX_CANDIDATES) });
  } catch (err) {
    await updateCheckpoint({ newTs: checkpoint, status: 'error', matches: 0, notes: `gmail_list_failed:${String(err.message || err)}` });
    return res.status(200).json({ ok: false, status: 'gmail_list_failed', error: String(err.message || err) });
  }

  const messageIds = (listResp?.messages || []).map((m) => m.id);
  stats.candidates = messageIds.length;

  let deals = [];
  try {
    deals = await loadActiveDeals();
  } catch (err) {
    console.warn('[cron-relevance-watcher] deal load failed, continuing with static context only', err.message);
  }
  const contextBlock = buildContextBlock(deals);

  let newestSeenIso = checkpoint;
  let classifyCallsUsed = 0;

  for (const messageId of messageIds) {
    let msg;
    try {
      msg = await gmailFetchWithRefresh(`messages/${messageId}`, {
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe'],
      });
    } catch (err) {
      console.warn('[cron-relevance-watcher] message fetch failed', messageId, err.message);
      continue;
    }

    const hdr = headerMap(msg?.payload?.headers);
    const { name: fromName, email: fromEmail } = parseFromHeader(hdr['from']);
    const subject = hdr['subject'] || '';
    const dateHeader = hdr['date'];
    if (dateHeader) {
      const d = new Date(dateHeader);
      if (!isNaN(d.getTime()) && d.toISOString() > newestSeenIso) newestSeenIso = d.toISOString();
    }

    const bulkReason = isBulkMail({
      fromEmail,
      hasListUnsubscribe: !!hdr['list-unsubscribe'],
      labelIds: msg?.labelIds,
    });
    if (bulkReason) {
      stats.prefiltered_bulk++;
      continue;
    }

    if (classifyCallsUsed >= MAX_CLASSIFY_CALLS) continue; // cost guardrail — rest picked up next run

    classifyCallsUsed++;
    stats.classified++;

    let verdict;
    try {
      verdict = await classifyEmail(
        { fromDisplay: fromName ? `${fromName} <${fromEmail}>` : fromEmail, subject, snippet: msg?.snippet },
        contextBlock,
      );
    } catch (err) {
      stats.classify_errors++;
      console.warn('[cron-relevance-watcher] classify failed', messageId, err.message);
      continue;
    }

    if (!verdict.relevant) continue;

    stats.relevant_hits++;
    const hitRow = {
      gmail_message_id: messageId,
      gmail_thread_id: msg?.threadId || null,
      from_email: fromEmail || null,
      from_name: fromName || null,
      subject: subject ? subject.slice(0, 500) : null,
      snippet: (msg?.snippet || '').slice(0, 500),
      matched_deal_or_person: verdict.matched,
      reason: verdict.reason,
    };
    const inserted = await insertHit(hitRow);
    if (!inserted) stats.insert_failures++;

    // Feature-flagged, OFF by default (RELEVANCE_WATCHER_NOTIFY unset in
    // Vercel). No-ops until Heath approves a live notify channel.
    if (NOTIFY_ENABLED) {
      const tg = await sendRelevanceTelegramAlert(hitRow);
      if (tg.ok && !tg.skipped) {
        await supaFetch(`relevance_watch_hits?gmail_message_id=eq.${encodeURIComponent(messageId)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ notified: true }),
        }).catch(() => {});
      }
    }
  }

  const finalTs = newestSeenIso > checkpoint ? newestSeenIso : new Date().toISOString();
  await updateCheckpoint({
    newTs: finalTs,
    status: 'ok',
    matches: stats.relevant_hits,
    notes: `candidates=${stats.candidates} bulk=${stats.prefiltered_bulk} classified=${stats.classified} hits=${stats.relevant_hits}`,
  });

  return res.status(200).json({ ok: true, status: 'complete', checkpoint_before: checkpoint, checkpoint_after: finalTs, stats });
}

module.exports = withTelemetry('cron-relevance-watcher', handler);
