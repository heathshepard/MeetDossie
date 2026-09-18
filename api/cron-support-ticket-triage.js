'use strict';

// api/cron-support-ticket-triage.js
// =============================================================================
// AUTONOMOUS BUG-REPORT PIPELINE — intake -> classify -> acknowledge -> dispatch
//
// THE CASE THIS EXISTS TO PREVENT
//   2026-08-24, support_tickets 503a1d1b: Amanda Nuckles, a paying founding
//   member, filed a ticket that read, in full, "How do I cancel my account?".
//   Nobody replied. It is still status='open' on 2026-09-18. She cancelled.
//
// WHAT ALREADY EXISTED, AND WHAT DID NOT
//   api/cron-support-ticket-alert.js (*/30 via cron-dispatch-every30) already
//   escalates open tickets to Heath's Telegram at 2h / 24h / 72h / 7d. It is
//   not the gap. The gaps were:
//     - nothing ever replied to the CUSTOMER,
//     - nothing classified the ticket (Amanda's says ticket_type='bug'),
//     - nothing turned a genuine bug into queued work on its own,
//     - and nothing recorded, with evidence, what was actually done.
//   This cron closes those four and leaves the alerter untouched.
//
// WHAT IT WILL NOT DO
//   - It will not merge to main, push, or deploy. Its dispatch path ends at an
//     agent_queue row whose brief says "branch only, do not merge".
//   - It will not auto-fix anything touching auth, payments, contract
//     generation, or data deletion. Those escalate to Heath with the
//     diagnosis, however obvious the fix looks
//     (api/_lib/support-ticket-classify.js SENSITIVE_AREAS).
//   - It will not auto-reply to a cancellation, a billing dispute, an unhappy
//     customer, or anything legal. Those route to Heath and say why.
//   - It will not email an internal address (quinn@meetdossie.internal,
//     demo@ / demo2@meetdossie.com, Heath's own).
//
// THE SWITCH — CURRENTLY OFF
//   A real customer email requires ALL of:
//     1. ops_flags.ack_support_ticket = TRUE   (seeded FALSE; one UPDATE, no deploy)
//     2. SUPPORT_TRIAGE_DRY_RUN unset/!= '1'
//     3. RESEND_API_KEY present
//   checkCapability() fails CLOSED on any read failure, so a missing row, an
//   unreadable table or a Supabase blip all resolve to "do not send". There is
//   no path where the absence of a decision becomes permission.
//
//   Separately and independently: ACK_MAX_AGE_HOURS (48) means the 18 rows
//   already in support_tickets can never be mailed by this cron even with the
//   flag on. History is not a mailing list. Amanda's ticket is 25 days old and
//   is a cancellation — it fails both gates, on purpose.
//
// EVIDENCE, NOT FLAGS
//   Every decision lands in public.support_triage_log. UNIQUE(source,ticket_id)
//   makes a second acknowledgement structurally impossible. CHECK constraints
//   make ack_outcome='sent' unassertable without a real Resend message id and
//   fix_outcome='queued' unassertable without a real agent_queue id. Today's
//   activation forensics found ten profiles marked emailed that never were;
//   that shape is illegal in this table.
//
// TWO PRODUCTS, ONE PIPELINE
//   source='dossie' — public.support_tickets, this Supabase project.
//   source='rust'   — public.app_feedback in project aflqnvlhpkbokfneyhqh,
//                     read via RUST_SUPABASE_URL / RUST_SUPABASE_SERVICE_ROLE_KEY.
//                     Rust's own api/feedback.ts ALREADY sends its own
//                     thank-you at intake, so this cron never acks a Rust row
//                     (ack_outcome='skipped_other_system') — it only classifies,
//                     dispatches, and escalates. Sending from here too would
//                     double-mail.
//
// SCHEDULE: */15 via api/cron-dispatch-every15.js (cron-multiplex).
// AUTH: x-vercel-cron header OR Authorization: Bearer $CRON_SECRET.
//
// ALARM: this cron reports through withTelemetry() into cron_runs, and
// api/_lib/silence-alarm.js checkSupportTriageSilence() fires if it stops
// running OR if a real customer ticket sits un-triaged. A poller that dies
// quietly is the failure mode this whole file exists to prevent, so it ships
// with its own alarm in the same change (feedback_silent-failure-is-the-enemy).
//
// Owner: Carter, 2026-09-18
// =============================================================================

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-support-ticket-triage');
const { wasSuppressed } = telegramGate;

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { classify, buildAck, findPromise } = require('./_lib/support-ticket-classify.js');
const { sendOutboundEmailRow, isValidEmail } = require('./_lib/outbound-email-send.js');
const { isSuppressed } = require('./_lib/check-suppression.js');
const { checkCapability, logAutonomousAction } = require('./_lib/ops-policy.js');
const { resolveBusinessLine } = require('./_lib/business-line.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Rust's own Supabase project. Absent from MeetDossie's Vercel env as of the
// 2026-07-27 audit (CLAUDE.md §19 lists 68 vars, none RUST_*), so the Rust leg
// no-ops with status 'not_configured' until Heath adds them. Values exist
// locally at ~/.rust-app-secrets/rust-supabase.env — precedent:
// scripts/rust-grant-free-months.js.
const RUST_SUPABASE_URL = (process.env.RUST_SUPABASE_URL || '').replace(/\/$/, '');
const RUST_SUPABASE_SERVICE_ROLE_KEY = process.env.RUST_SUPABASE_SERVICE_ROLE_KEY;
const RUST_EXPECTED_PROJECT_REF = 'aflqnvlhpkbokfneyhqh';

// ─── Caps. Every one of these exists so a bad day can't become a mailing list.
const ACK_MAX_AGE_HOURS = Number(process.env.SUPPORT_ACK_MAX_AGE_HOURS || 48);
const MAX_ACKS_PER_RUN = Number(process.env.SUPPORT_ACK_MAX_PER_RUN || 5);
const MAX_ACKS_PER_DAY = Number(process.env.SUPPORT_ACK_MAX_PER_DAY || 20);
const MAX_ACKS_PER_RECIPIENT_7D = Number(process.env.SUPPORT_ACK_MAX_PER_RECIPIENT_7D || 3);
// If this many tickets land in an hour, something is wrong with the form, a
// bot found it, or a customer is in a retry loop. Halt ALL acks and tell Heath
// rather than mailing somebody fifty times.
const FLOOD_TICKETS_PER_HOUR = Number(process.env.SUPPORT_FLOOD_PER_HOUR || 10);
const MAX_DISPATCH_PER_RUN = Number(process.env.SUPPORT_DISPATCH_MAX_PER_RUN || 3);
const DISPATCH_MAX_AGE_DAYS = Number(process.env.SUPPORT_DISPATCH_MAX_AGE_DAYS || 14);
// Hard ceiling on rows examined per run. Keeps one run bounded regardless of
// what's in the table.
const SCAN_LIMIT = 50;
// This runs INSIDE api/cron-dispatch-every15.js's shared 40s budget alongside
// seven sibling jobs, so it bails well before it could starve them. Unfinished
// tickets are simply picked up on the next tick 15 minutes later — the ledger's
// unique constraint makes that safe to repeat. Precedent: cron-autonomous-loop's
// 18-minute bail.
const RUN_BUDGET_MS = Number(process.env.SUPPORT_TRIAGE_BUDGET_MS || 20000);

const DRY_RUN = process.env.SUPPORT_TRIAGE_DRY_RUN === '1';

const ACK_FROM_EMAIL = 'heath@meetdossie.com';

// ─── Supabase REST ───────────────────────────────────────────────────────────

function makeSb(baseUrl, key) {
  return async function sb(pathAndQuery, init = {}) {
    if (!baseUrl || !key) return { ok: false, status: 0, data: null, error: 'not_configured' };
    try {
      const res = await fetch(`${baseUrl}/rest/v1/${pathAndQuery}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          apikey: key,
          Authorization: `Bearer ${key}`,
          ...(init.headers || {}),
        },
      });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = null; } }
      return { ok: res.ok, status: res.status, data, raw: text };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: e.message };
    }
  };
}

const sb = makeSb(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const rustSb = makeSb(RUST_SUPABASE_URL, RUST_SUPABASE_SERVICE_ROLE_KEY);

// Returns { ok } where ok=true means A MESSAGE ACTUALLY REACHED HEATH.
// Never true for a dry run, a missing token, or a gate suppression — callers
// stamp heath_notified_at off this, and a timestamp that means "we would have
// told him" is the same optimistic-flag bug this whole change exists to kill.
async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: 'telegram_not_configured' };
  if (DRY_RUN) return { ok: false, reason: 'dry_run', dryRun: true };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: String(text).slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.ok && wasSuppressed(data)) {
      return { ok: false, reason: 'suppressed_by_telegram_gate' };
    }
    return { ok: res.ok && !!(data && data.ok), data };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── Intake: Dossie ──────────────────────────────────────────────────────────

async function fetchDossieTickets() {
  const q = 'support_tickets'
    + '?select=id,user_id,agent_email,ticket_type,message,status,created_at'
    + '&status=in.(open,new,in_progress)'
    + `&order=created_at.desc&limit=${SCAN_LIMIT}`;
  const { ok, data, status } = await sb(q);
  if (!ok || !Array.isArray(data)) {
    return { ok: false, status, tickets: [] };
  }
  return {
    ok: true,
    tickets: data.map((t) => ({
      source: 'dossie',
      id: t.id,
      user_id: t.user_id,
      agent_email: t.agent_email,
      ticket_type: t.ticket_type,
      message: t.message,
      created_at: t.created_at,
      raw_status: t.status,
    })),
  };
}

// ─── Intake: Rust ────────────────────────────────────────────────────────────
//
// app_feedback lives in Rust's OWN Supabase project. Schema (Rust
// migrations/023_app_feedback.sql):
//   id uuid, user_id uuid, type text (bug|feature|missing_exercise|other),
//   description text, page text, user_agent text, status text, created_at
//
// There is NO email column. The address lives in auth.users, which PostgREST
// does not expose — reaching it needs the GoTrue admin API. This cron never
// emails a Rust submitter (Rust's own api/feedback.ts already does that at
// intake), so it deliberately does NOT do that join. It maps type -> a
// ticket_type hint and leaves agent_email null, which the classifier treats
// as "no recipient".
//
// The migration's own header notes app_feedback pre-existed in production
// without a `status` column. If that migration has not actually been applied
// to aflqnvlhpkbokfneyhqh, the status filter below 400s and this leg reports
// 'fetch_failed' rather than silently returning zero rows.
async function fetchRustFeedback() {
  if (!RUST_SUPABASE_URL || !RUST_SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 'not_configured', tickets: [] };
  }
  if (!RUST_SUPABASE_URL.includes(RUST_EXPECTED_PROJECT_REF)) {
    // Same guard as scripts/rust-grant-free-months.js — refuse to run against
    // an unexpected project rather than write to the wrong tenant.
    return { ok: false, status: 'wrong_project_ref', tickets: [] };
  }
  const q = 'app_feedback'
    + '?select=id,user_id,type,description,page,status,created_at'
    + '&status=eq.new'
    + `&order=created_at.desc&limit=${SCAN_LIMIT}`;
  const { ok, data, status } = await rustSb(q);
  if (!ok || !Array.isArray(data)) return { ok: false, status: status || 'fetch_failed', tickets: [] };
  return {
    ok: true,
    tickets: data.map((f) => ({
      source: 'rust',
      id: f.id,
      user_id: f.user_id,
      agent_email: null, // deliberately not resolved — see header
      ticket_type: f.type === 'missing_exercise' ? 'bug' : f.type,
      message: f.description,
      created_at: f.created_at,
      raw_status: f.status,
      page: f.page,
    })),
  };
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

async function loadProcessedIds(tickets) {
  // One query per source, ids only. Nothing else is needed to know a ticket
  // has already been decided.
  const bySource = new Map();
  for (const t of tickets) {
    if (!bySource.has(t.source)) bySource.set(t.source, []);
    bySource.get(t.source).push(t.id);
  }
  const seen = new Set();
  for (const [source, ids] of bySource) {
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const list = chunk.map((id) => `"${id}"`).join(',');
      const { ok, data } = await sb(
        `support_triage_log?select=ticket_id&source=eq.${source}&ticket_id=in.(${encodeURIComponent(list)})`
      );
      if (ok && Array.isArray(data)) {
        for (const row of data) seen.add(`${source}:${row.ticket_id}`);
      }
    }
  }
  return seen;
}

// Insert IS the claim. A 409 from the unique constraint means another run (or
// another instance of this run) already owns this ticket — that is a success,
// not an error. It is the reason a duplicate acknowledgement cannot happen
// even if this cron double-fires.
async function claimTicket(row) {
  const res = await sb('support_triage_log', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (res.ok && Array.isArray(res.data) && res.data[0]) {
    return { ok: true, row: res.data[0] };
  }
  if (res.status === 409) return { ok: false, conflict: true };
  return { ok: false, status: res.status, error: (res.raw || '').slice(0, 300) };
}

async function updateLedger(id, patch) {
  const res = await sb(`support_triage_log?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return { ok: res.ok, status: res.status, error: (res.raw || '').slice(0, 300) };
}

async function countAcksSince(isoSince, extraFilter = '') {
  const { ok, data } = await sb(
    `support_triage_log?select=id&ack_outcome=eq.sent&ack_sent_at=gte.${encodeURIComponent(isoSince)}${extraFilter}&limit=200`
  );
  return ok && Array.isArray(data) ? data.length : 0;
}

// ─── Recipient identity ──────────────────────────────────────────────────────

async function lookupProfile(userId, email) {
  const tryQuery = async (q) => {
    const { ok, data } = await sb(q);
    if (ok && Array.isArray(data) && data[0]) return data[0];
    return null;
  };
  let p = null;
  if (userId) p = await tryQuery(`profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,email&limit=1`);
  if (!p && email) p = await tryQuery(`profiles?email=eq.${encodeURIComponent(email)}&select=full_name,email&limit=1`);
  return p || {};
}

// ─── Fix dispatch ────────────────────────────────────────────────────────────
//
// Reuses the machinery api/cron-autonomous-loop.js already uses — a direct
// agent_queue insert, with the SAME signal_key shape ('customer_bug:<id>') so
// the two systems dedup against EACH OTHER instead of both filing the same
// bug. No parallel queue, no new dispatcher.

function buildTaskBrief(ticket, cls, profile) {
  const who = ticket.agent_email || profile.email || ticket.user_id || 'unknown';
  const lines = [
    `Customer bug report — ${ticket.source === 'rust' ? 'Rust fitness app' : 'Dossie'}.`,
    ``,
    `Ticket: ${ticket.id}`,
    `From: ${who}`,
    `Filed: ${ticket.created_at}`,
    ticket.page ? `Page: ${ticket.page}` : null,
    ``,
    `Report as written by the customer:`,
    `"""`,
    String(ticket.message || '').slice(0, 3000),
    `"""`,
    ``,
    `Classified: ${cls.ticketClass} (${cls.route}).`,
    `Why: ${cls.reasons.join('; ')}`,
    ``,
    `HARD CONSTRAINTS ON THIS TASK — from Heath's standing rules:`,
    `  - Reproduce first. Do not "fix" what you have not seen fail.`,
    `  - Fix on a BRANCH off origin/main. Do NOT merge to main. Do NOT deploy.`,
    `    Heath is the final gate on every merge (CLAUDE.md §3).`,
    `  - If the real cause turns out to touch auth, payments, contract`,
    `    generation, or data deletion, STOP and escalate to Heath with the`,
    `    diagnosis instead of fixing it, however obvious the fix looks.`,
    `  - Do NOT email the customer. The acknowledgement is handled by`,
    `    api/cron-support-ticket-triage.js; any substantive reply is Heath's.`,
    ticket.source === 'rust'
      ? `  - This is the Rust repo (/mnt/c/Users/Heath/Projects/Rust), NOT MeetDossie.\n    Dispatch a background agent against that checkout.`
      : null,
    ``,
    `When done: report the branch name and what you verified in a real browser`,
    `(CLAUDE.md §17 — backend-only testing is never sufficient).`,
  ].filter((l) => l !== null);
  return lines.join('\n');
}

async function dispatchFix(ticket, cls, profile) {
  const signalKey = ticket.source === 'rust'
    ? `rust_bug:${ticket.id}`
    : `customer_bug:${ticket.id}`;

  // Dedup against anything already pending — including rows the autonomous
  // loop filed for this same ticket under the same signal_key.
  const dupe = await sb(
    `agent_queue?select=id,status&metadata->>signal_key=eq.${encodeURIComponent(signalKey)}`
    + `&status=in.(pending,in_progress,blocked)&limit=1`
  );
  if (dupe.ok && Array.isArray(dupe.data) && dupe.data.length > 0) {
    return { outcome: 'deduped', queueId: dupe.data[0].id };
  }

  // Rust has no agent lane of its own (no Rust persona; the merge queue is
  // MeetDossie-only). It goes to cole — the dispatch lane — with
  // business_line='rust', rather than pretending carter owns another repo.
  const agentName = ticket.source === 'rust' ? 'cole' : 'carter';
  const businessLine = resolveBusinessLine(agentName, ticket.source === 'rust' ? 'rust' : 'dossie');

  const payload = {
    agent_name: agentName,
    task_subject: `Customer bug (${ticket.source}): ${String(ticket.message || '').replace(/\s+/g, ' ').slice(0, 150)}`,
    task_brief: buildTaskBrief(ticket, cls, profile).slice(0, 8000),
    priority: 1, // customer bugs preempt — same tier cron-autonomous-loop uses
    depends_on: [],
    venture: 'general',
    business_line: businessLine,
    status: 'pending',
    metadata: {
      source: 'support-ticket-triage',
      source_table: ticket.source === 'rust' ? 'app_feedback' : 'support_tickets',
      source_id: ticket.id,
      signal_source: 'customer_bug',
      signal_key: signalKey,
      signal_score: 100,
      product: ticket.source,
      ticket_class: cls.ticketClass,
      enqueued_at: new Date().toISOString(),
      enqueued_by: 'cron-support-ticket-triage',
      no_merge: true,
      no_deploy: true,
    },
  };

  if (DRY_RUN) return { outcome: 'dry_run', queueId: null, payload };

  const ins = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
  const queueId = (ins.ok && Array.isArray(ins.data) && ins.data[0]) ? ins.data[0].id : null;
  if (!queueId) {
    return { outcome: 'failed', queueId: null, error: `agent_queue insert failed (${ins.status}): ${(ins.raw || '').slice(0, 200)}` };
  }
  return { outcome: 'queued', queueId };
}

// ─── Heath escalation ────────────────────────────────────────────────────────

function buildEscalation(ticket, cls, profile) {
  const who = profile.full_name
    ? `${profile.full_name} (${ticket.agent_email || profile.email || 'no email'})`
    : (ticket.agent_email || profile.email || ticket.user_id || 'unknown');
  const headline = {
    cancellation: '🚪 <b>CANCELLATION REQUEST — do not let this sit</b>',
    billing: '💳 <b>Billing question — needs you, not a template</b>',
    unhappy: '🔥 <b>Unhappy customer — needs you, not a template</b>',
    legal: '⚖️ <b>Legal / privacy matter — needs you</b>',
    question: '❓ <b>Customer question — needs a real answer</b>',
    unknown: '📝 <b>Unclassified ticket — needs eyes</b>',
    bug: '🐛 <b>Bug in a protected area — NOT auto-fixed</b>',
    feature: '💡 <b>Feature request — your call</b>',
  }[cls.ticketClass] || '📮 <b>Support ticket</b>';

  const parts = [
    headline,
    `<b>From:</b> ${esc(who)}`,
    `<b>Product:</b> ${esc(ticket.source)}`,
    `<b>They wrote:</b> <i>${esc(String(ticket.message || '').replace(/\s+/g, ' ').slice(0, 400))}</i>`,
    ``,
    `<b>Why this came to you and not an auto-reply:</b>`,
    ...cls.reasons.map((r) => `• ${esc(r)}`),
  ];
  if (cls.sensitiveAreas.length > 0) {
    parts.push(``, `<b>Protected areas touched:</b>`);
    for (const a of cls.sensitiveAreas) {
      parts.push(`• <b>${esc(a.key)}</b> — ${esc(a.why)} (matched "${esc(a.matched)}")`);
    }
    parts.push(`No agent has been dispatched against this. Your call.`);
  }
  parts.push(``, `<b>Ticket:</b> <code>${esc(ticket.id)}</code>`);
  return parts.join('\n');
}

// ─── The ack decision cascade ────────────────────────────────────────────────
//
// Ordered most-structural first, so the ledger records the most PERMANENT
// reason a ticket wasn't mailed. "skipped_stale" stays true forever;
// "skipped_disabled" changes the moment Heath flips the flag. Recording the
// former where both apply makes the history honest.
function decideAck(ticket, cls, ctx) {
  if (cls.ticketClass === 'internal') return { outcome: 'skipped_internal', note: 'sender is not a customer' };
  if (!cls.mayAutoReply) return { outcome: 'skipped_escalated', note: `${cls.ticketClass} — routed to Heath, never auto-replied` };
  if (ticket.source === 'rust') {
    return { outcome: 'skipped_other_system', note: "Rust's own api/feedback.ts acknowledges at intake — a second send here would double-mail" };
  }
  if (!isValidEmail(ticket.agent_email)) return { outcome: 'skipped_no_recipient', note: 'no valid address on the ticket' };

  const ageHours = (Date.now() - new Date(ticket.created_at).getTime()) / 3600000;
  if (!(ageHours < ACK_MAX_AGE_HOURS)) {
    return { outcome: 'skipped_stale', note: `ticket is ${Math.round(ageHours / 24)}d old; backfill window is ${ACK_MAX_AGE_HOURS}h — history is not a mailing list` };
  }
  if (ctx.flooding) return { outcome: 'skipped_capped', note: `flood guard: ${ctx.ticketsLastHour} tickets in the last hour (limit ${FLOOD_TICKETS_PER_HOUR})` };
  if (ctx.sentThisRun >= MAX_ACKS_PER_RUN) return { outcome: 'skipped_capped', note: `per-run cap ${MAX_ACKS_PER_RUN}` };
  if (ctx.sentToday >= MAX_ACKS_PER_DAY) return { outcome: 'skipped_capped', note: `per-day cap ${MAX_ACKS_PER_DAY}` };
  if (ctx.recipientCount >= MAX_ACKS_PER_RECIPIENT_7D) {
    return { outcome: 'skipped_capped', note: `recipient already acked ${ctx.recipientCount}x in 7d (cap ${MAX_ACKS_PER_RECIPIENT_7D})` };
  }
  if (!ctx.capabilityAllowed) return { outcome: 'skipped_disabled', note: ctx.capabilityReason };
  if (ctx.suppressed) return { outcome: 'skipped_suppressed', note: 'recipient is on the suppression list' };
  if (DRY_RUN || !process.env.RESEND_API_KEY) {
    return { outcome: 'dry_run', note: DRY_RUN ? 'SUPPORT_TRIAGE_DRY_RUN=1' : 'RESEND_API_KEY not configured' };
  }
  return { outcome: 'send' };
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function authorized(req) {
  if (req.headers && req.headers['x-vercel-cron']) return true;
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return Boolean(CRON_SECRET && auth === `Bearer ${CRON_SECRET}`);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'core_env_missing' });
  }

  const startedAt = Date.now();
  const stats = {
    dry_run: DRY_RUN,
    sources: {},
    scanned: 0,
    already_processed: 0,
    decided: 0,
    acks_sent: 0,
    acks_by_outcome: {},
    fixes_queued: 0,
    fixes_by_outcome: {},
    escalated_to_heath: 0,
    classes: {},
    errors: [],
    decisions: [],
  };

  // ── Gather from both intakes.
  const [dossie, rust] = await Promise.all([fetchDossieTickets(), fetchRustFeedback()]);
  stats.sources.dossie = { ok: dossie.ok, count: dossie.tickets.length, status: dossie.status };
  stats.sources.rust = { ok: rust.ok, count: rust.tickets.length, status: rust.status };
  if (!dossie.ok) stats.errors.push(`dossie_fetch_failed:${dossie.status}`);
  if (!rust.ok && rust.status !== 'not_configured') stats.errors.push(`rust_fetch_failed:${rust.status}`);

  const tickets = [...dossie.tickets, ...rust.tickets];
  stats.scanned = tickets.length;
  if (tickets.length === 0) {
    return res.status(200).json({ ok: true, status: 'nothing_to_do', stats, ms: Date.now() - startedAt });
  }

  // ── Flood guard, computed BEFORE any decision so it gates the whole run.
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const ticketsLastHour = tickets.filter((t) => t.created_at && t.created_at >= hourAgo).length;
  const flooding = ticketsLastHour >= FLOOD_TICKETS_PER_HOUR;
  stats.tickets_last_hour = ticketsLastHour;
  stats.flooding = flooding;
  if (flooding) {
    await tg(
      `🚨 <b>Support ticket flood — auto-acknowledgement HALTED</b>\n`
      + `${ticketsLastHour} tickets in the last hour (limit ${FLOOD_TICKETS_PER_HOUR}).\n`
      + `No customer has been emailed. Triage classification and logging continue as normal.`
    );
  }

  // ── The switch. Read ONCE per run; fails closed.
  const capability = await checkCapability('ack_support_ticket');
  stats.capability = { allowed: capability.allowed, decision: capability.decision, reason: capability.reason };

  const processed = await loadProcessedIds(tickets);
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  let sentToday = await countAcksSince(dayAgo);
  let sentThisRun = 0;
  let dispatchedThisRun = 0;

  // Oldest first — a customer who has been waiting longest gets decided first.
  tickets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  for (const ticket of tickets) {
    if (processed.has(`${ticket.source}:${ticket.id}`)) {
      stats.already_processed++;
      continue;
    }
    if (Date.now() - startedAt > RUN_BUDGET_MS) {
      // Out of budget. Everything decided so far is already committed to the
      // ledger; the rest is picked up next tick. Never leaves a half-decision.
      stats.budget_exhausted = true;
      stats.deferred = (stats.deferred || 0) + 1;
      continue;
    }

    const cls = classify(ticket);
    stats.classes[cls.ticketClass] = (stats.classes[cls.ticketClass] || 0) + 1;

    const profile = cls.ticketClass === 'internal'
      ? {}
      : await lookupProfile(ticket.user_id, ticket.agent_email);

    // Per-recipient history + suppression, only when it can matter.
    let recipientCount = 0;
    let suppressed = false;
    if (cls.mayAutoReply && ticket.source === 'dossie' && isValidEmail(ticket.agent_email)) {
      recipientCount = await countAcksSince(weekAgo, `&recipient_email=eq.${encodeURIComponent(ticket.agent_email)}`);
      suppressed = await isSuppressed(ticket.agent_email, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    }

    const decision = decideAck(ticket, cls, {
      flooding,
      ticketsLastHour,
      sentThisRun,
      sentToday,
      recipientCount,
      suppressed,
      capabilityAllowed: capability.allowed,
      capabilityReason: capability.reason,
    });

    const willSend = decision.outcome === 'send';
    const ack = (cls.mayAutoReply && ticket.source === 'dossie')
      ? buildAck({ ticketClass: cls.ticketClass, fullName: profile.full_name, email: ticket.agent_email })
      : null;

    // Last line of defence on the copy. If anyone ever edits the templates and
    // slips a timeline or a "this is fixed" into them, refuse the send rather
    // than make Heath a promise he has to keep.
    if (willSend && ack) {
      const promise = findPromise(ack.bodyText);
      if (promise) {
        decision.outcome = 'skipped_capped';
        decision.note = `copy guard tripped: acknowledgement contained a promise ("${promise}") — refusing to send`;
        stats.errors.push(`promise_guard_tripped:${ticket.id}`);
      }
    }

    const reasons = [...cls.reasons];
    if (decision.note) reasons.push(`ack: ${decision.outcome} — ${decision.note}`);

    // Claim. The insert is the lock; a conflict means somebody else owns it.
    const claim = await claimTicket({
      source: ticket.source,
      ticket_id: ticket.id,
      ticket_created_at: ticket.created_at,
      recipient_email: ticket.agent_email || profile.email || null,
      ticket_class: cls.ticketClass,
      route: cls.route,
      sensitive_areas: cls.sensitiveAreas.map((a) => a.key),
      reasons,
      // Terminal outcome straight away unless we're actually about to send.
      ack_outcome: decision.outcome === 'send' ? 'claimed' : decision.outcome,
      ack_subject: ack ? ack.subject : null,
      ack_body: ack ? ack.bodyText : null,
    });
    if (claim.conflict) { stats.already_processed++; continue; }
    if (!claim.ok) {
      stats.errors.push(`claim_failed:${ticket.id}:${claim.status}:${claim.error}`);
      continue;
    }
    const ledgerId = claim.row.id;
    stats.decided++;
    stats.acks_by_outcome[decision.outcome] = (stats.acks_by_outcome[decision.outcome] || 0) + 1;

    // ── Acknowledgement leg.
    let finalAckOutcome = decision.outcome;
    if (willSend) {
      const send = await sendOutboundEmailRow({
        to_email: ticket.agent_email,
        from_email: ACK_FROM_EMAIL,
        reply_to: ACK_FROM_EMAIL,
        subject: ack.subject,
        body_text: ack.bodyText,
        metadata: { queued_by: 'cron-support-ticket-triage', ticket_id: ticket.id },
      });
      if (send.ok && send.id) {
        // ack_outcome='sent' is only writable WITH this id — the CHECK
        // constraint rejects the row otherwise.
        await updateLedger(ledgerId, {
          ack_outcome: 'sent',
          ack_provider: 'resend',
          ack_provider_message_id: send.id,
          ack_sent_at: new Date().toISOString(),
          ack_attempts: 1,
        });
        finalAckOutcome = 'sent';
        sentThisRun++; sentToday++; stats.acks_sent++;
        await logAutonomousAction({
          capability: 'ack_support_ticket',
          decision: 'autonomous',
          action: `acknowledged support ticket ${ticket.id} to ${ticket.agent_email} (resend ${send.id})`,
          firedBy: 'cron-support-ticket-triage',
          gatesPassed: ['not_internal_sender', 'not_escalation_class', 'within_backfill_age_window', 'idempotent_unique_ticket', 'suppression_list', 'rate_caps_and_flood_guard', 'no_promise_in_copy'],
          refTable: 'support_triage_log',
          refId: ledgerId,
          metadata: { ticket_class: cls.ticketClass, resend_message_id: send.id },
        });
      } else {
        // NEVER retried. A send that reports failure may still have gone out
        // (feedback_never-retry-an-unverified-send — a retry triple-texted a
        // client on 2026-09-11). One attempt, then it becomes Heath's.
        await updateLedger(ledgerId, {
          ack_outcome: 'failed',
          ack_attempts: 1,
          ack_error: String(send.errorText || `resend_${send.status}`).slice(0, 500),
        });
        finalAckOutcome = 'failed';
        stats.errors.push(`ack_send_failed:${ticket.id}:${send.errorText}`);
        await tg(
          `⚠️ <b>Support acknowledgement FAILED to send</b>\n`
          + `To: ${esc(ticket.agent_email)}\nTicket: <code>${esc(ticket.id)}</code>\n`
          + `Error: ${esc(String(send.errorText || send.status))}\n\n`
          + `Not retried on purpose — an unverified send may have landed. Reply yourself.`
        );
      }
    } else if (!capability.allowed && cls.mayAutoReply && ticket.source === 'dossie') {
      await logAutonomousAction({
        capability: 'ack_support_ticket',
        decision: 'blocked_flag_off',
        action: `acknowledgement composed but NOT sent for ticket ${ticket.id}: ${decision.outcome} (${decision.note || ''})`,
        firedBy: 'cron-support-ticket-triage',
        refTable: 'support_triage_log',
        refId: ledgerId,
        metadata: { ticket_class: cls.ticketClass, ack_outcome: decision.outcome },
      });
    }

    // ── Fix-dispatch leg.
    let fixOutcome = 'none';
    let queueId = null;
    let fixError = null;
    if (cls.ticketClass === 'bug' && cls.mayAutoFix) {
      const ageDays = (Date.now() - new Date(ticket.created_at).getTime()) / 86400000;
      if (ageDays > DISPATCH_MAX_AGE_DAYS) {
        fixOutcome = 'none';
      } else if (dispatchedThisRun >= MAX_DISPATCH_PER_RUN) {
        fixOutcome = 'skipped_capped';
      } else {
        const d = await dispatchFix(ticket, cls, profile);
        if (d.outcome === 'queued') {
          fixOutcome = 'queued'; queueId = d.queueId; dispatchedThisRun++; stats.fixes_queued++;
        } else if (d.outcome === 'deduped') {
          fixOutcome = 'deduped'; queueId = d.queueId;
        } else if (d.outcome === 'dry_run') {
          fixOutcome = 'none';
        } else {
          fixOutcome = 'failed'; fixError = d.error || null;
          stats.errors.push(`dispatch_failed:${ticket.id}`);
        }
      }
    } else if (cls.ticketClass === 'bug' && cls.sensitiveAreas.length > 0) {
      fixOutcome = 'blocked_sensitive';
    } else if (cls.route === 'heath_only') {
      fixOutcome = 'escalated';
    }
    stats.fixes_by_outcome[fixOutcome] = (stats.fixes_by_outcome[fixOutcome] || 0) + 1;

    // ── Heath escalation leg. One Telegram per ticket, ever — the ledger's
    // unique constraint guarantees this block runs at most once per ticket.
    let notifiedAt = null;
    let notifyReason = null;
    const needsHeath = cls.route === 'heath_only'
      || cls.route === 'ack_and_escalate'
      || cls.ticketClass === 'question'
      || cls.ticketClass === 'feature'
      || cls.ticketClass === 'unknown'
      || finalAckOutcome === 'failed';
    if (needsHeath && cls.ticketClass !== 'internal') {
      const r = await tg(buildEscalation(ticket, cls, profile));
      if (r.ok) {
        notifiedAt = new Date().toISOString();
        notifyReason = cls.reasons[0] || cls.ticketClass;
        stats.escalated_to_heath++;
      } else if (r.dryRun) {
        // Composed, deliberately not sent. heath_notified_at stays NULL so the
        // ledger never claims he was told.
        stats.escalation_dry_run = (stats.escalation_dry_run || 0) + 1;
      } else {
        stats.errors.push(`telegram_failed:${ticket.id}:${r.reason || 'unknown'}`);
      }
      if (cls.route === 'heath_only') {
        await logAutonomousAction({
          capability: 'pricing_demo_complaint_conversation',
          decision: 'blocked_always_heath',
          action: `ticket ${ticket.id} classified '${cls.ticketClass}' — routed to Heath, no automated reply`,
          firedBy: 'cron-support-ticket-triage',
          refTable: 'support_triage_log',
          refId: ledgerId,
          metadata: { reasons: cls.reasons },
        });
      }
    }

    await updateLedger(ledgerId, {
      fix_outcome: fixOutcome,
      agent_queue_id: queueId,
      fix_error: fixError,
      heath_notified_at: notifiedAt,
      heath_notify_reason: notifyReason ? String(notifyReason).slice(0, 500) : null,
    });

    stats.decisions.push({
      source: ticket.source,
      ticket_id: ticket.id,
      class: cls.ticketClass,
      route: cls.route,
      ack: finalAckOutcome,
      fix: fixOutcome,
      sensitive: cls.sensitiveAreas.map((a) => a.key),
      overrode_type_hint: cls.overrodeTypeHint,
    });
  }

  return res.status(200).json({
    ok: stats.errors.length === 0,
    status: 'complete',
    stats,
    ms: Date.now() - startedAt,
  });
}

module.exports = withTelemetry('cron-support-ticket-triage', handler);
module.exports.handler = handler;
