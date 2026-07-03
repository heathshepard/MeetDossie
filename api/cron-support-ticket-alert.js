// Vercel Serverless Function: /api/cron-support-ticket-alert
//
// Support-ticket monitor. Pings Heath on Telegram when an in-app support ticket
// sits unanswered too long, and re-escalates on the 24h / 72h / 7d marks so
// nothing goes silent for weeks like the Miki incident (16 days, 2026-06-17).
//
// SV-SUPPORT-ALERT-001 (Atlas, 2026-07-02).
//
// Schedule: */30 * * * * (every 30 min) — vercel.json.
//
// Auth: Vercel cron header OR Authorization: Bearer $CRON_SECRET.
//
// Data model: reuses public.support_tickets. Debounce columns added in migration
// support_ticket_alert_debounce:
//   heath_alerted_at       timestamptz — last time a Heath alert was sent
//   heath_alert_count      integer     — total alerts sent for this ticket
//   heath_last_escalation_stage text   — 'first' | '24h' | '72h' | '7d'
//
// We NEVER store the ticket message body in any dedup structure — we reference
// only by ticket id.
//
// Escalation cadence (per ticket):
//   status='open' AND age >= 2h AND heath_alert_count=0                → send 'first'
//   status='open' AND age >= 24h AND stage='first'                     → send '24h'
//   status='open' AND age >= 72h AND stage='24h'                       → send '72h'
//   status='open' AND age >= 7d AND stage='72h'                        → send '7d'
//
// Backfill: on very first run (no ticket in the table has heath_alerted_at
// populated) the cron alerts on ALL currently-open tickets regardless of age,
// capped at 20 to avoid Telegram flood.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   CRON_SECRET
//
// Optional env:
//   SUPPORT_ALERT_DRY_RUN=1   - fetch + classify but do NOT send Telegram or
//                                update rows. For staging APV.
//   SUPPORT_ALERT_TEST_MODE=1 - same as DRY_RUN but ALSO ignores debounce so
//                                a known ticket can be re-simulated.

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DRY_RUN = process.env.SUPPORT_ALERT_DRY_RUN === '1' || process.env.SUPPORT_ALERT_TEST_MODE === '1';
const TEST_MODE = process.env.SUPPORT_ALERT_TEST_MODE === '1';

const BACKFILL_MAX = 20; // hard cap so an empty debounce column can't Telegram-flood

// Escalation thresholds in hours.
const T_FIRST = 2;
const T_24H = 24;
const T_72H = 72;
const T_7D = 24 * 7;

// --------------------------------------------------------------------------
// Supabase REST
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

async function fetchOpenTickets() {
  // Pull every open ticket. Volume is tiny (single digits historically) so
  // no need for pagination.
  const res = await supaFetch(
    'support_tickets?status=eq.open&select=id,agent_email,user_id,ticket_type,message,created_at,heath_alerted_at,heath_alert_count,heath_last_escalation_stage&order=created_at.asc',
    { method: 'GET' }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`supabase_fetch_tickets_failed:${res.status}:${body.slice(0, 200)}`);
  }
  return res.json();
}

async function countEverAlerted() {
  // "Ever alerted" = at least one ticket in the table has heath_alerted_at populated.
  // We use count=exact against a tiny filter so we don't pull rows.
  const res = await supaFetch(
    'support_tickets?heath_alerted_at=not.is.null&select=id&limit=1',
    { method: 'GET', headers: { Prefer: 'count=exact' } }
  );
  if (!res.ok) return 0;
  const range = res.headers.get('content-range') || '';
  const match = range.match(/\/(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

async function markAlerted(ticketId, stage, nextCount) {
  if (DRY_RUN) return { ok: true, skipped: true };
  const res = await supaFetch(
    `support_tickets?id=eq.${encodeURIComponent(ticketId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        heath_alerted_at: new Date().toISOString(),
        heath_alert_count: nextCount,
        heath_last_escalation_stage: stage,
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, body: text.slice(0, 200) };
  }
  return { ok: true };
}

async function fetchCustomerName(userId, agentEmail) {
  // Best-effort. Try profiles by user_id first, then by email.
  try {
    if (userId) {
      const r = await supaFetch(
        `profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,first_name,last_name,email&limit=1`,
        { method: 'GET' }
      );
      if (r.ok) {
        const rows = await r.json().catch(() => []);
        const p = Array.isArray(rows) && rows[0];
        if (p) {
          const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
          if (name) return { name, email: p.email || agentEmail };
        }
      }
    }
    if (agentEmail) {
      const r = await supaFetch(
        `profiles?email=eq.${encodeURIComponent(agentEmail)}&select=full_name,first_name,last_name,email&limit=1`,
        { method: 'GET' }
      );
      if (r.ok) {
        const rows = await r.json().catch(() => []);
        const p = Array.isArray(rows) && rows[0];
        if (p) {
          const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
          if (name) return { name, email: p.email || agentEmail };
        }
      }
    }
  } catch { /* fall through */ }
  return { name: null, email: agentEmail || null };
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

function formatAge(hoursOld) {
  if (hoursOld < 1) return 'under an hour';
  if (hoursOld < 24) return `${Math.floor(hoursOld)}h`;
  const days = Math.floor(hoursOld / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

function buildAlertText({ ticket, customer, stage, hoursOld, backfill }) {
  const isRepeat = stage !== 'first';
  const banner = backfill
    ? '📮 <b>Silent support ticket (backfill)</b>'
    : isRepeat
      ? `🔁 <b>STILL OPEN — ${stage} escalation</b>`
      : '📮 <b>New support ticket</b>';

  const who = customer.name
    ? `${escapeHtml(customer.name)} (${escapeHtml(customer.email || 'no email')})`
    : escapeHtml(customer.email || ticket.agent_email || 'unknown');

  const body = String(ticket.message || '').trim().slice(0, 200);
  const bodyClean = body.replace(/\s+/g, ' ');

  const created = ticket.created_at ? new Date(ticket.created_at).toISOString().slice(0, 16).replace('T', ' ') : 'unknown';

  const parts = [
    `${banner} — ${formatAge(hoursOld)} old`,
    `<b>From:</b> ${who}`,
    `<b>Type:</b> ${escapeHtml(ticket.ticket_type || 'unknown')}`,
    `<b>Filed:</b> ${escapeHtml(created)} UTC`,
    `<i>${escapeHtml(bodyClean || '(no message)')}</i>`,
    `<b>Ticket ID:</b> <code>${escapeHtml(ticket.id)}</code>`,
  ];
  return parts.join('\n');
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

function classify(ticket, hoursOld, hoursSinceLastAlert) {
  // Returns the escalation stage to fire NOW, or null if none.
  // Both the ticket-age threshold AND the time-since-last-alert must be met
  // so an ancient ticket doesn't burst through every escalation on one cron tick.
  const count = ticket.heath_alert_count || 0;
  const last = ticket.heath_last_escalation_stage || null;

  // In TEST_MODE ignore debounce and force a 'first' alert for anything past T_FIRST.
  if (TEST_MODE) {
    if (hoursOld >= T_FIRST) return 'first';
    return null;
  }

  if (count === 0) {
    if (hoursOld >= T_FIRST) return 'first';
    return null;
  }
  // Already alerted at least once. Fire the next escalation window if BOTH
  // ticket age AND time-since-last-alert have reached the next threshold.
  // Time-since-last-alert gaps: first -> 24h needs 22h since 'first'
  //                             24h  -> 72h needs 48h since '24h'
  //                             72h  -> 7d  needs 96h since '72h'
  const since = hoursSinceLastAlert == null ? Infinity : hoursSinceLastAlert;
  if (last === 'first' && hoursOld >= T_24H && since >= (T_24H - T_FIRST)) return '24h';
  if (last === '24h'   && hoursOld >= T_72H && since >= (T_72H - T_24H))  return '72h';
  if (last === '72h'   && hoursOld >= T_7D  && since >= (T_7D  - T_72H))  return '7d';
  return null;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

function authorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  return false;
}

function envSummary() {
  return {
    supabase: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
    dry_run: DRY_RUN,
    test_mode: TEST_MODE,
  };
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const env = envSummary();
  if (!env.supabase || !env.telegram) {
    return res.status(500).json({ ok: false, error: 'core_env_missing', env });
  }

  let tickets;
  try {
    tickets = await fetchOpenTickets();
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: 'fetch_failed',
      error: String(err?.message || err),
      env,
    });
  }

  // Is this the very first invocation of the alerter? If every open ticket
  // has heath_alert_count=0 AND no ticket in the table has ever been alerted,
  // backfill (with a cap).
  let backfill = false;
  try {
    const everAlerted = await countEverAlerted();
    backfill = everAlerted === 0;
  } catch { /* fall through, assume not backfill */ }

  const now = Date.now();
  const stats = {
    total_open: tickets.length,
    backfill,
    considered: 0,
    alerts_sent: 0,
    telegram_failures: 0,
    by_stage: { first: 0, '24h': 0, '72h': 0, '7d': 0 },
    tickets_alerted: [],
    debug: [],
  };

  // Sort oldest-first so the backfill cap prioritizes the longest-silent tickets.
  tickets.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let backfillSent = 0;

  for (const ticket of tickets) {
    stats.considered++;
    const createdAt = new Date(ticket.created_at).getTime();
    const hoursOld = (now - createdAt) / (1000 * 3600);
    const lastAlertAt = ticket.heath_alerted_at ? new Date(ticket.heath_alerted_at).getTime() : null;
    const hoursSinceLastAlert = lastAlertAt == null ? null : (now - lastAlertAt) / (1000 * 3600);

    // On backfill, treat every never-alerted open ticket as a 'first' alert
    // regardless of age, but respect the cap.
    let stage = null;
    if (backfill && (ticket.heath_alert_count || 0) === 0) {
      if (backfillSent >= BACKFILL_MAX) {
        stats.debug.push({ id: ticket.id, skip: 'backfill_cap' });
        continue;
      }
      stage = 'first';
    } else {
      stage = classify(ticket, hoursOld, hoursSinceLastAlert);
    }

    if (!stage) continue;

    const customer = await fetchCustomerName(ticket.user_id, ticket.agent_email);
    const text = buildAlertText({ ticket, customer, stage, hoursOld, backfill });

    const tg = await sendTelegram(text);
    if (!tg.ok) {
      stats.telegram_failures++;
      stats.debug.push({ id: ticket.id, tg_err: tg.status });
      // Do NOT mark alerted — retry next tick.
      continue;
    }

    const nextCount = (ticket.heath_alert_count || 0) + 1;
    const mark = await markAlerted(ticket.id, stage, nextCount);
    if (!mark.ok && !mark.skipped) {
      stats.debug.push({ id: ticket.id, mark_err: mark });
    }

    stats.alerts_sent++;
    stats.by_stage[stage] = (stats.by_stage[stage] || 0) + 1;
    stats.tickets_alerted.push({ id: ticket.id, stage, hours_old: Math.round(hoursOld) });
    if (backfill && stage === 'first') backfillSent++;
  }

  return res.status(200).json({ ok: true, status: 'complete', env, stats });
}

module.exports = withTelemetry('cron-support-ticket-alert', handler);
