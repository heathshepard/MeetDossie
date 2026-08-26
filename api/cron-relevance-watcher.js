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
//      names), the standing client/customer watchlist from the
//      RELEVANCE_WATCHLIST_JSON env var, and the Dossie/MeetDossie brand
//      terms. No client names or customer addresses live in this file — the
//      repo is public. See loadWatchlist() below.
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

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-relevance-watcher');

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
// Known-clients / customer allow-list — read from env, NOT from source.
//
// THIS DATA IS NOT ALLOWED BACK IN THIS FILE. Until 2026-08-15 it was two
// hardcoded arrays right here: real client names, the client relationship,
// the property they bought, and the paying-customer roster with personal
// email addresses. heathshepard/MeetDossie is a PUBLIC repo — that was live
// client PII sitting in public source. It now comes from the
// RELEVANCE_WATCHLIST_JSON env var in Vercel (Production + Preview), same as
// any other secret-ish value. If you find yourself typing a client name into
// this file, stop.
//
// Shape (single-line JSON, both keys optional):
//   {
//     "clients":   [ { "name": "Jane Doe", "note": "buyer, closed 123 Example St 2024" } ],
//     "customers": [ { "label": "Jane Doe (Example Realty)", "match": "@examplerealty.com" } ]
//   }
// `match` is either an exact address or a whole domain starting with "@".
// Company-domain customers should use the domain (catches any address there);
// gmail-based customers must use the exact address — a bare "gmail.com" entry
// would match nearly everything and defeat the prefilter.
//
// To change the roster: update the env var in Vercel (all environments you
// care about) — it takes effect on the next deploy. Keep it in sync with
// docs/CUSTOMERS.md by hand, same as the old array was.
//
// Deals are deliberately NOT in here either (they change constantly) — those
// come live from the transactions table each run. This list is only for
// people/entities that matter to Heath but may not always have an open
// transactions row.
//
// Failure mode is deliberate: if the var is unset or malformed, the cron logs
// a warning and keeps going with live deals + brand terms only. Losing the
// static roster costs recall; it does not break the run.
// --------------------------------------------------------------------------

const DOSSIE_BUSINESS_TERMS = ['Dossie', 'MeetDossie', 'meetdossie.com'];

const EMPTY_WATCHLIST = { clients: [], customers: [] };

function loadWatchlist() {
  const raw = process.env.RELEVANCE_WATCHLIST_JSON;
  if (!raw || !raw.trim()) {
    console.warn('[cron-relevance-watcher] RELEVANCE_WATCHLIST_JSON unset — classifying on live deals only');
    return EMPTY_WATCHLIST;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[cron-relevance-watcher] RELEVANCE_WATCHLIST_JSON is not valid JSON — ignoring', err.message);
    return EMPTY_WATCHLIST;
  }
  const clients = Array.isArray(parsed?.clients) ? parsed.clients : [];
  const customers = Array.isArray(parsed?.customers) ? parsed.customers : [];
  return {
    clients: clients
      .filter((c) => c && typeof c.name === 'string' && c.name.trim())
      .map((c) => ({ name: c.name.trim(), note: typeof c.note === 'string' ? c.note.trim() : '' })),
    customers: customers
      .filter((c) => c && typeof c.match === 'string' && c.match.trim())
      .map((c) => ({ label: (typeof c.label === 'string' && c.label.trim()) || c.match.trim(), match: c.match.trim() })),
  };
}

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
  // Infra/deploy noise (Atlas 2026-08-26) — alert-health already owns real
  // outage alerting; a "your Vercel preview failed to build" email is not a
  // deal/client/customer signal and was previously slipping through relevant
  // because the From-domain check never actually ran (see gmailFetch bugfix
  // above). Confirmed real: 6 of 64 historical hits were exactly this.
  'vercel.com', 'vercel-status.com',
];

const NOREPLY_FROM_PATTERNS = [
  /noreply@/i, /no-reply@/i, /do[-_.]?not[-_.]?reply@/i, /donotreply@/i,
  /automated@/i, /notifications?@/i, /mailer-daemon@/i, /postmaster@/i,
  /bounces?@/i, /autoresponder@/i, /marketing@/i, /newsletter@/i,
];

// Heath's own outbound addresses. Copies of his own sent mail (e.g. a Resend
// send from heath@meetdossie.com landing back in his kw.com inbox) are not a
// "did something happen" signal — he already knows what he sent. Confirmed
// real: several historical hits were exactly Heath's own outreach copy text
// ("Hey Suzanne, I built Dossie...") misclassified as relevant inbound.
const SELF_SENT_PATTERNS = [
  /^heath@meetdossie\.com$/i,
  /^hello@meetdossie\.com$/i,
  /^heath\.shepard@kw\.com$/i,
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
  if (SELF_SENT_PATTERNS.some((rx) => rx.test(fromEmail))) return 'self_sent_copy';
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
    `&select=id,property_address,buyer_name,seller_name,client_names,dossier_number,stage`,
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
      id: r.id,
      address: r.property_address || null,
      buyer: r.buyer_name || null,
      seller: r.seller_name || null,
      client_names: r.client_names || null,
      stage: r.stage || null,
    }));
}

// Best-effort match of the Haiku-returned MATCH string back to one of Heath's
// live deals, so a real deal hit can carry a transaction_id into dossie_asks
// (not just sit in relevance_watch_hits, which nothing surfaces in-app).
// Deliberately conservative: substring match against address only. A miss
// just means the hit still gets a Telegram alert without a deal card — never
// blocks the alert.
function matchDealByVerdict(matched, deals) {
  if (!matched) return null;
  const needle = String(matched).toLowerCase();
  return deals.find((d) => d.address && needle.includes(d.address.toLowerCase().split(',')[0].trim())) || null;
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
  // BUGFIX (Atlas, 2026-08-26): PostgREST's `Prefer: resolution=merge-
  // duplicates` is a no-op without `on_conflict=<col>` in the URL telling it
  // which constraint to upsert against — omitting it means a duplicate
  // gmail_message_id (e.g. a manually-rewound checkpoint reprocessing a
  // message already on file) hits the plain unique-constraint violation
  // (23505) instead of updating. Reproduced live: this was silently eating
  // inserts any time the same message got re-seen. Never surfaced before
  // because normal 15-min incremental runs never revisit an old checkpoint.
  const res = await supaFetch('relevance_watch_hits?on_conflict=gmail_message_id', {
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

// BUGFIX (Atlas, 2026-08-26): new URLSearchParams({ metadataHeaders: [...] })
// stringifies an array value by joining it with commas into ONE query value
// ("From,To,Subject,..."), not repeated `metadataHeaders=From&metadataHeaders=To`
// params. Gmail's messages.get only returns headers that exactly match a
// requested name, so every format=metadata call here was asking for a header
// literally named "From,To,Subject,Date,List-Unsubscribe" — which doesn't
// exist — and got an empty headers array back every single time. Verified:
// every one of the 64 rows written to relevance_watch_hits before this fix has
// from_email/from_name/subject = null, and the bulk-mail prefilter (which also
// depends on the From header) never actually filtered anything by sender
// domain. classifyEmail() still worked because it also gets the Gmail
// `snippet`, which is NOT header-derived — that's why past verdicts/reasons
// read correctly despite blank From/Subject.
function buildGmailQuery(params) {
  const qs = new URLSearchParams();
  for (const [key, val] of Object.entries(params || {})) {
    if (Array.isArray(val)) {
      for (const v of val) qs.append(key, v);
    } else if (val !== undefined && val !== null) {
      qs.append(key, val);
    }
  }
  return qs.toString();
}

async function gmailFetch(accessToken, path, params = {}) {
  const qs = buildGmailQuery(params);
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

function buildContextBlock(deals, watchlist) {
  const { clients, customers } = watchlist || EMPTY_WATCHLIST;
  const dealLines = deals.length
    ? deals.map((d) => {
        const bits = [d.address, d.buyer && `buyer: ${d.buyer}`, d.seller && `seller: ${d.seller}`, d.client_names && `client: ${d.client_names}`, d.stage && `stage: ${d.stage}`]
          .filter(Boolean);
        return `- ${bits.join(' | ')}`;
      }).join('\n')
    : '- (no active deals in Dossie right now)';

  const clientLines = clients.length
    ? clients.map((c) => `- ${c.name}${c.note ? ` (${c.note})` : ''}`).join('\n')
    : '- (no standing client watchlist configured)';
  const customerLines = customers.length
    ? customers.map((c) => `- ${c.label}: ${c.match}`).join('\n')
    : '- (no customer roster configured)';

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
// Telegram — live as of 2026-08-26 (RELEVANCE_WATCHER_NOTIFY=1). Also gated
// by api/_lib/telegram-gate.js's TELEGRAM_CRON_NOTIFICATIONS allowlist.
// --------------------------------------------------------------------------

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendRelevanceTelegramAlert(hit) {
  if (!NOTIFY_ENABLED) return { ok: true, skipped: true, reason: 'notify_disabled' };
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, skipped: true, reason: 'no_telegram_token' };
  const text = [
    `📧 <b>Relevant email</b> — ${escapeHtml(hit.matched_deal_or_person || 'unmatched')}`,
    `From: ${escapeHtml(hit.from_name ? `${hit.from_name} <${hit.from_email}>` : (hit.from_email || 'unknown'))}`,
    `Subject: ${escapeHtml(hit.subject || '(no subject)')}`,
    hit.reason ? `<i>${escapeHtml(hit.reason)}</i>` : null,
    hit.snippet ? escapeHtml(hit.snippet) : null,
    hit.gmail_thread_id ? `<a href="https://mail.google.com/mail/u/0/#inbox/${hit.gmail_thread_id}">Open thread</a>` : null,
  ].filter(Boolean).join('\n\n');

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: HEATH_TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => null);
  // data.suppressed=true means telegram-gate ate this call — distinguishes a
  // real send from a muted one for the run stats below (see TELEGRAM_CRON_
  // NOTIFICATIONS in telegram-gate.js).
  return { ok: res.ok && data?.ok, status: res.status, suppressed: !!(data && data.suppressed) };
}

// Route a real deal-matched hit into dossie_asks too, so it surfaces on the
// app home screen (Morning Brief) — not just Telegram, which Heath has said
// he's drifting away from. Dedupes on source so a re-run of the same message
// (checkpoint overlap, manual reprocessing) never double-cards.
async function createEmailAsk({ userId, transactionId, matchedLabel, subject, snippet, reason, gmailThreadId, messageId }) {
  const source = `email:${messageId}`;
  const existing = await supaFetch(`dossie_asks?source=eq.${encodeURIComponent(source)}&select=id&limit=1`);
  if (existing.ok) {
    const rows = await existing.json().catch(() => []);
    if (Array.isArray(rows) && rows.length) return { ok: true, skipped: true, reason: 'already_filed' };
  }

  const threadUrl = gmailThreadId ? `https://mail.google.com/mail/u/0/#inbox/${gmailThreadId}` : null;
  const body = [
    reason || 'A new email came in on this deal.',
    subject ? `Subject: ${subject}` : null,
    snippet || null,
  ].filter(Boolean).join('\n\n').slice(0, 2000);

  const payload = {
    user_id: userId,
    transaction_id: transactionId,
    urgency: 'normal',
    title: `New email — ${String(matchedLabel || 'deal update').slice(0, 140)}`,
    body: body || 'A new email came in on this deal.',
    due_at: null,
    due_label: null,
    suggested_actions: [
      { id: 'reviewed', label: 'Reviewed', kind: 'primary', effect: 'resolve' },
      threadUrl ? { id: 'open_thread', label: 'Open in Gmail', kind: 'secondary', effect: 'none', url: threadUrl } : null,
    ].filter(Boolean),
    created_by: 'system',
    source,
  };

  const res = await supaFetch('dossie_asks', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn('[cron-relevance-watcher] dossie_asks insert failed', res.status, await res.text().catch(() => ''));
    return { ok: false };
  }
  return { ok: true };
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
    watchlist_clients: 0,
    watchlist_customers: 0,
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
    console.warn('[cron-relevance-watcher] deal load failed, continuing with watchlist context only', err.message);
  }
  const watchlist = loadWatchlist();
  stats.watchlist_clients = watchlist.clients.length;
  stats.watchlist_customers = watchlist.customers.length;
  const contextBlock = buildContextBlock(deals, watchlist);

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

    // Real deal match (address appears in Heath's live transactions) also
    // gets a persistent dossie_asks card, not just a Telegram ping that
    // scrolls away. Never blocks the Telegram send below.
    const dealMatch = matchDealByVerdict(verdict.matched, deals);
    if (dealMatch) {
      const askResult = await createEmailAsk({
        userId: HEATH_KW_USER_ID,
        transactionId: dealMatch.id,
        matchedLabel: verdict.matched,
        subject: hitRow.subject,
        snippet: hitRow.snippet,
        reason: verdict.reason,
        gmailThreadId: hitRow.gmail_thread_id,
        messageId,
      });
      stats.dossie_asks_created = (stats.dossie_asks_created || 0) + (askResult.ok && !askResult.skipped ? 1 : 0);
    }

    // RELEVANCE_WATCHER_NOTIFY=1 (Atlas, 2026-08-26 — Heath: "if you're
    // checking my email then we need to build a way for it to be actually
    // useful"). Still gated a second time by telegram-gate's
    // TELEGRAM_CRON_NOTIFICATIONS allowlist — sendRelevanceTelegramAlert()
    // reports back whether that gate actually suppressed the send so run
    // stats tell the truth about what really reached Heath's phone.
    if (NOTIFY_ENABLED) {
      const tg = await sendRelevanceTelegramAlert(hitRow);
      stats.notify_attempted = (stats.notify_attempted || 0) + 1;
      if (tg.suppressed) stats.notify_suppressed = (stats.notify_suppressed || 0) + 1;
      if (tg.ok && !tg.skipped && !tg.suppressed) stats.notify_sent = (stats.notify_sent || 0) + 1;
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

// Set here rather than in vercel.json's `functions` block -- that block is
// already at the platform's 50-property cap (see cron-trec-scanner.js /
// cron-ridge-watchdog.js for the same escape valve). Gmail list + per-message
// metadata fetch + up to MAX_CLASSIFY_CALLS Haiku calls, all sequential, need
// more headroom than the ~15s default.
module.exports.config = {
  maxDuration: 90,
};
