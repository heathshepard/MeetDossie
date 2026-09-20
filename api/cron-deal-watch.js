'use strict';

// Vercel Serverless Function: /api/cron-deal-watch
// =============================================================================
// THE WATCHER — the thing that notices, unprompted.
//
// Everything Dossie does today, she does because a member asked. This job is
// the exception: it walks each member's live deals on a schedule and surfaces,
// in plain language, the handful of things that would cost them something if
// nobody noticed. A transaction coordinator's actual job is noticing.
//
// The case that motivated it: on a live $1,295,000 listing (23 Nopalito), the
// seller replied answering the single biggest open question on the file —
// whether stale tax exemptions would cost them up to $20,000 at closing.
// Dossie said nothing. Not for lack of capability (api/_lib/inbox-tools.js
// shipped and works) but because nothing ran on a schedule that looked.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT WATCHES
//   1. party_reply       a party wrote in on a live file
//   2. awaiting_delivery someone owes something and hasn't delivered it
//   3. document_arrived  a signed/executed packet came back
//   4. missing_required  a live listing with no seller's disclosure
//   5. missing_contacts  the deal has no addresses, so nothing can ever be
//                        filed to it — the watcher reporting its own blind spot
//
// Deliberately NOT here: bare deadline reminders. cron-deadline-reminders.js
// already fires T-7/T-1/T-0 across ~21 deadline types with its own
// database-enforced dedup on (transaction_id, deadline_type, days_out). A
// second voice saying the same thing is the fastest route to the member muting
// both. What this job adds instead is the JOIN that cron cannot make: an unmet
// obligation held against the clock it threatens. "Wesley hasn't sent it AND
// the option ends Monday."
//
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY, DO NOT ACT
//   This job observes and tells. It never emails a client, never chases the
//   other agent, never files anything. Drafting a nudge for the member to
//   approve would be in scope; sending it is not. The only outbound side
//   effect in this entire file is one Telegram message to the member about
//   their own deals.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SWITCH — CURRENTLY OFF
//   A notification reaching a real person requires ALL of:
//     1. ops_flags.deal_watch_notify = TRUE   (seeded FALSE; one UPDATE, no deploy)
//     2. DEAL_WATCH_DRY_RUN unset / != '1'
//     3. the member has been baselined on a PREVIOUS run
//     4. a channel resolves for that specific member (see resolveChannel)
//     5. at least one fact clears every gate in deal-watch-policy.js
//   checkCapability() fails CLOSED on any read failure, so a missing row, an
//   unreadable table or a Supabase blip all resolve to "do not speak". There
//   is no path where the absence of a decision becomes permission.
//
// ─────────────────────────────────────────────────────────────────────────────
// MULTI-TENANCY
//   Every read is scoped to one member by user_id, and resolveChannel() will
//   not return a destination for a member it cannot positively identify as
//   the owner of that destination. A watcher that crossed tenants would
//   surface one agent's client correspondence to another agent, which is a
//   worse outcome than the silence this job exists to fix. See the comment on
//   resolveChannel for why the default is "no channel" rather than "Heath".
//
// Schedule: via api/cron-dispatch-daily-1330.js ("30 13 * * *" = 08:30 CT),
//   deliberately after cron-deadline-reminders (13:05) so the two never race,
//   and after cron-email-to-dossier has had all night at 15-minute intervals
//   to file overnight mail.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1
// =============================================================================

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-deal-watch');
const { wasSuppressed } = telegramGate;

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { checkCapability } = require('./_lib/ops-policy.js');
const { observeDeal, rollUpMissingContacts } = require('./_lib/deal-watch-observe.js');
const { decideRun, composeNotification } = require('./_lib/deal-watch-policy.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Env-level dry run, independent of the database flag. Either one being set
// keeps the job silent; both must be clear for a notification to go out.
const DRY_RUN = process.env.DEAL_WATCH_DRY_RUN === '1';

// Heath's personal Telegram chat, the same constant cron-email-to-dossier.js
// uses. It is the ONLY delivery destination that exists today.
const HEATH_TELEGRAM_CHAT_ID = '7874782923';

const MAX_DEALS_PER_MEMBER = 60;

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return res;
}

async function sbJson(path) {
  const res = await sb(path);
  if (!res.ok) throw new Error(`supabase_fetch_failed:${path}:${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

/**
 * Members worth watching: an active subscription, not a demo seed.
 *
 * NOTE this filter differs deliberately from cron-deadline-reminders.js, which
 * additionally excludes heath.shepard@ because it sends CUSTOMER emails and
 * Heath is not a customer to email. This job's first and (today) only
 * recipient IS Heath, on his own deals — so he is explicitly in scope here.
 */
async function loadMembers() {
  const subs = await sbJson('subscriptions?status=eq.active&select=user_id');
  const ids = [...new Set((subs || []).map((s) => s.user_id).filter(Boolean))];
  if (ids.length === 0) return [];

  const profiles = await sbJson(
    `profiles?id=in.(${ids.join(',')})&select=id,email,full_name,preferred_name,is_demo`,
  );

  return (profiles || [])
    .filter((p) => !p.is_demo)
    .filter((p) => p.email && !String(p.email).toLowerCase().includes('demo'))
    .map((p) => ({
      userId: p.id,
      email: String(p.email || '').toLowerCase(),
      name: p.preferred_name || p.full_name || null,
    }));
}

/**
 * Where a given member's notification may be delivered — or null.
 *
 * THE DEFAULT IS NULL, AND THAT IS THE POINT. There is exactly one Telegram
 * chat wired in this system and it belongs to Heath. Falling back to it for a
 * member we cannot identify would mean delivering one agent's client
 * correspondence — seller names, negotiation summaries, addresses — into
 * someone else's phone. That is a cross-tenant disclosure, and it is a
 * strictly worse failure than the silence this job exists to fix.
 *
 * So: a channel is returned only for a member positively identified as the
 * owner of that channel. Everyone else is fully observed and fully ledgered,
 * and their facts wait for a per-member channel to exist. `no_channel` in the
 * ledger is the honest record of that gap, and it is queryable — which is how
 * we will know how much value is sitting undelivered when it comes time to
 * build per-member delivery.
 */
function resolveChannel(member) {
  const e = member.email || '';
  const isHeath = e.startsWith('heath.shepard@') || e === 'heath@meetdossie.com';
  if (isHeath && TELEGRAM_BOT_TOKEN) {
    return { kind: 'telegram', chatId: HEATH_TELEGRAM_CHAT_ID };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-member state + ledger
// ---------------------------------------------------------------------------

async function loadState(userId) {
  const rows = await sbJson(
    `deal_watch_state?user_id=eq.${encodeURIComponent(userId)}&select=baseline_at,last_run_at`,
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/**
 * Every fact this member's ledger already holds, plus when each first landed.
 *
 * The timestamps drive the still-true reminder in deal-watch-policy.js: a
 * standing, unresolved, expensive condition gets one low-frequency nudge
 * rather than disappearing into the ledger forever. Without them, 23
 * Nopalito's "I can't watch this deal" would be recorded once at baseline and
 * never mentioned again — which is the failure this feature exists to fix,
 * just quieter.
 */
async function loadKnownFacts(userId) {
  const rows = await sbJson(
    `deal_watch_log?user_id=eq.${encodeURIComponent(userId)}&select=fact_key,created_at`,
  );
  const keys = new Set();
  const firstSeen = new Map();
  for (const r of rows || []) {
    keys.add(r.fact_key);
    // Keep the EARLIEST sighting: the reminder clock runs from when the
    // condition first appeared, not from the most recent row about it.
    const prev = firstSeen.get(r.fact_key);
    if (!prev || Date.parse(r.created_at) < Date.parse(prev)) {
      firstSeen.set(r.fact_key, r.created_at);
    }
  }
  return { keys, firstSeen };
}

async function upsertState(userId, patch) {
  const res = await sb('deal_watch_state?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, updated_at: new Date().toISOString(), ...patch }),
  });
  if (!res.ok) console.warn('[cron-deal-watch] state upsert failed', userId, res.status);
  return res.ok;
}

/**
 * Write a ledger row. A 409 means the UNIQUE (user_id, fact_key) constraint
 * already claimed this fact — which is success, not failure: it is the "say it
 * once" guarantee doing exactly its job.
 */
async function writeLedgerRow(row) {
  const res = await sb('deal_watch_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify(row),
  });
  if (res.status === 409) return { ok: true, duplicate: true, id: null };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn('[cron-deal-watch] ledger insert failed', res.status, text.slice(0, 200));
    return { ok: false, duplicate: false, id: null };
  }
  const body = await res.json().catch(() => null);
  return { ok: true, duplicate: false, id: Array.isArray(body) && body[0] ? body[0].id : null };
}

function ledgerRowFrom(decision, extra = {}) {
  const o = decision.observation;
  return {
    user_id: o.userId,
    transaction_id: o.dealId,
    // A still-true reminder writes under its OWN period-indexed key, so the
    // UNIQUE (user_id, fact_key) constraint keeps enforcing one utterance per
    // period instead of blocking the reminder outright.
    fact_key: decision.isReminder && decision.reminderKey ? decision.reminderKey : o.factKey,
    kind: o.kind,
    consequence: o.consequence,
    observed_at: o.observedAt || null,
    headline: o.headline,
    detail: o.detail || null,
    deadline_label: o.deadline ? o.deadline.label : null,
    deadline_date: o.deadline ? o.deadline.date : null,
    days_to_deadline: o.deadline ? o.deadline.days : null,
    outcome: decision.outcome,
    suppressed_reason: decision.speak ? null : decision.reason,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function sendTelegram(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  // The scheduled-Telegram kill switch intercepts fetch and returns a
  // synthetic body. A suppressed send is NOT a delivery, and must never be
  // recorded as one — that is exactly the "flag set optimistically next to
  // code that failed silently" shape the ledger's CHECK constraint forbids.
  if (parsed && wasSuppressed(parsed)) {
    return { ok: false, suppressed: true, messageId: null, error: 'suppressed_by_telegram_gate' };
  }
  if (!res.ok || !parsed || parsed.ok !== true) {
    return { ok: false, suppressed: false, messageId: null, error: `telegram_${res.status}:${raw.slice(0, 120)}` };
  }
  return { ok: true, suppressed: false, messageId: String(parsed.result?.message_id || ''), error: null };
}

// ---------------------------------------------------------------------------
// One member
// ---------------------------------------------------------------------------

async function watchMember(member, { notifyEnabled, todayYmd, nowMs }) {
  const { userId } = member;

  const deals = await sbJson(
    `transactions?user_id=eq.${encodeURIComponent(userId)}&status=neq.closed` +
    '&select=id,user_id,property_address,status,stage,role,updated_at,parties,notes_log,sale_price,' +
    'contract_effective_date,option_expiration_date,closing_date,loan_approval_deadline,' +
    'appraisal_deadline,survey_deadline,hoa_document_deadline,' +
    'sellers_disclosure_received_at,sdn_received,' +
    'seller_email,seller2_email,buyer_email,buyer2_email,other_agent_email_addr,' +
    `listing_agent_email_addr,title_officer_email,loan_officer_email&limit=${MAX_DEALS_PER_MEMBER}`,
  );

  if (!Array.isArray(deals) || deals.length === 0) {
    return { userId, status: 'no_deals', observed: 0, spoken: 0 };
  }

  // Signature requests for THIS member only. Scoped by user_id as well as
  // transaction_id — belt and braces on the tenancy boundary.
  const dealIds = deals.map((d) => d.id);
  let signatures = [];
  try {
    signatures = await sbJson(
      `signature_requests?user_id=eq.${encodeURIComponent(userId)}` +
      // Quoted + encoded, matching the convention in silence-alarm.js. These
      // are UUIDs from our own database, but building a PostgREST filter by
      // string concatenation is a shape worth keeping uniformly safe.
      `&transaction_id=in.(${encodeURIComponent(dealIds.map((id) => `"${id}"`).join(','))})` +
      '&select=id,user_id,transaction_id,status,signers,created_at,completed_at,docuseal_submission_id,seller_agent_name',
    );
  } catch (err) {
    console.warn('[cron-deal-watch] signature_requests load failed', userId, err.message);
    signatures = [];
  }
  const sigsByDeal = new Map();
  for (const s of signatures || []) {
    if (!sigsByDeal.has(s.transaction_id)) sigsByDeal.set(s.transaction_id, []);
    sigsByDeal.get(s.transaction_id).push(s);
  }

  // Observe.
  const observations = [];
  const dormantDealIds = new Set();
  for (const deal of deals) {
    const r = observeDeal({
      deal,
      signatureRequests: sigsByDeal.get(deal.id) || [],
      todayYmd,
      nowMs,
    });
    if (r.dormant) dormantDealIds.add(deal.id);
    observations.push(...r.observations);
  }

  // Collapse per-deal blind spots into a single member-level fact before
  // deciding. Nine invisible deals are one problem, not nine notifications.
  const rolled = rollUpMissingContacts(observations);

  // Decide.
  const state = await loadState(userId);
  const isBaselineRun = !state;
  const known = isBaselineRun ? { keys: new Set(), firstSeen: new Map() } : await loadKnownFacts(userId);
  const channel = resolveChannel(member);

  const run = decideRun({
    observations: rolled,
    isBaselineRun,
    knownFactKeys: known.keys,
    factFirstSeen: known.firstSeen,
    dormantDealIds,
    baselineAt: state ? state.baseline_at : null,
    nowMs,
    // No channel means nothing can be delivered, so nothing may be marked
    // spoken. Folding it in here keeps the ledger honest rather than recording
    // an intent to send that had nowhere to go.
    notifyEnabled: notifyEnabled && !DRY_RUN && Boolean(channel),
  });

  // Compose + deliver BEFORE writing 'spoken' rows, so the ledger can never
  // claim a delivery that did not happen.
  let sendResult = null;
  let text = null;
  if (run.spoken.length > 0 && channel) {
    text = composeNotification(run.spoken, { memberName: member.name });
    sendResult = await sendTelegram(channel.chatId, text);
  }

  // Persist every decision.
  let written = 0;
  for (const d of run.decisions) {
    let extra = {};
    if (d.speak) {
      if (sendResult && sendResult.ok) {
        extra = { telegram_message_id: sendResult.messageId, spoken_at: new Date().toISOString() };
      } else {
        // Downgrade: the fact was worth saying, but saying it did not work.
        // It keeps its fact_key, so it will not be retried into a duplicate.
        d.outcome = sendResult && sendResult.suppressed ? 'skipped_disabled' : 'failed';
        d.reason = sendResult ? sendResult.error : 'no delivery channel for this member';
        extra = { send_error: d.reason };
      }
    } else if (!channel && d.outcome === 'skipped_disabled') {
      d.reason = 'no_channel: no per-member delivery destination exists yet';
    }
    const res = await writeLedgerRow(ledgerRowFrom(d, extra));
    if (res.ok && !res.duplicate) written += 1;
  }

  const deliveredCount = sendResult && sendResult.ok ? run.spoken.length : 0;

  if (isBaselineRun) {
    await upsertState(userId, {
      baseline_at: new Date().toISOString(),
      baseline_facts: observations.length,
      last_run_at: new Date().toISOString(),
      last_run_status: 'baseline',
      last_run_notes: `seeded ${observations.length} pre-existing facts, announced none`,
      facts_spoken_last_run: 0,
    });
  } else {
    await upsertState(userId, {
      last_run_at: new Date().toISOString(),
      last_run_status: 'ok',
      last_run_notes: `observed=${observations.length} spoken=${deliveredCount} ` +
        `baseline=${run.summary.baseline} dormant=${run.summary.dormant} ` +
        `below=${run.summary.below_threshold} capped=${run.summary.capped}`,
      facts_spoken_last_run: deliveredCount,
    });
  }

  return {
    userId,
    status: isBaselineRun ? 'baselined' : 'ok',
    deals: deals.length,
    observed: observations.length,
    spoken: deliveredCount,
    ledger_rows_written: written,
    has_channel: Boolean(channel),
    summary: run.summary,
    preview: text ? text.slice(0, 500) : null,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
  }

  // Fails CLOSED: a missing row, an unreadable table or a Supabase blip all
  // resolve to "do not speak".
  let capability;
  try {
    capability = await checkCapability('deal_watch_notify');
  } catch (err) {
    capability = { allowed: false, decision: 'blocked_flag_off', reason: `capability check threw: ${err.message}` };
  }
  const notifyEnabled = Boolean(capability && capability.allowed);

  const nowMs = Date.now();
  const todayYmd = new Date(nowMs).toISOString().slice(0, 10);

  let members;
  try {
    members = await loadMembers();
  } catch (err) {
    return res.status(500).json({ ok: false, error: `member_load_failed: ${err.message}` });
  }

  const results = [];
  for (const m of members) {
    try {
      results.push(await watchMember(m, { notifyEnabled, todayYmd, nowMs }));
    } catch (err) {
      console.error('[cron-deal-watch] member failed', m.userId, err);
      results.push({ userId: m.userId, status: 'error', error: String(err && err.message || err) });
    }
  }

  const totalSpoken = results.reduce((a, r) => a + (r.spoken || 0), 0);
  return res.status(200).json({
    ok: true,
    job: 'cron-deal-watch',
    notify_enabled: notifyEnabled,
    notify_decision: capability && capability.decision,
    notify_reason: capability && capability.reason,
    dry_run: DRY_RUN,
    members: members.length,
    total_spoken: totalSpoken,
    // Silence is a valid morning and the expected one.
    silent: totalSpoken === 0,
    results,
  });
}

module.exports = withTelemetry('cron-deal-watch', handler);
module.exports.config = { maxDuration: 120 };
