// Scheduled-Telegram kill switch. Gates unattended pushes to Heath behind
// TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-outcome-monitor');

'use strict';

// Vercel Serverless Function: /api/cron-outcome-monitor
//
// THE SELF-HEALING OUTCOME MONITOR (Atlas, 2026-09-25)
//
// Heath: "I don't want to have to check everything daily... it needs to catch
// failures but also have a way of fixing it and staying on track."
//
// Every other monitor in this repo asks "did the job run?". Eight failures in
// one week all answered yes. This one asks "did the pipeline PRODUCE what it
// is supposed to produce?", measured against the rows themselves, and then
// tries to fix what it finds before telling anyone.
//
// Per expectation in the outcome_expectations table:
//   measure -> classify cause -> remediate -> RE-MEASURE -> escalate only what
//   survived.
//
// Escalation never uses a flat cooldown. Incidents are keyed on
// (expectation, cause) so a new problem class always speaks, and the resend
// interval shrinks as an incident ages so unresolved problems get LOUDER.
// See api/_lib/outcome-escalation.js for why (both halves of that were real
// bugs: a 96x/day useless summary next to a suppressed real alert, and a
// 34-consecutive-failure credential outage that went quiet for 19 days).
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Query params:
//   ?dry_run=1  -- evaluate and format, write nothing, send nothing
//   ?key=<k>    -- evaluate a single expectation
//
// Schedule: every 6h. Vercel's 20/20 cron cap is full, so this is registered
// on cron-job.org with a Bearer CRON_SECRET header like the other overflow
// jobs.
//
// TELEGRAM: this job is deliberately NOT in telegram-gate's ALWAYS_ALLOW set,
// so with TELEGRAM_CRON_NOTIFICATIONS off every alert it raises is suppressed
// and Heath hears nothing. That is the intended state while the expectation
// set beds in. What changed on 2026-09-25 is that the monitor now KNOWS it was
// suppressed instead of recording the message as delivered: the incident stays
// un-escalated and due, and speaks the moment the gate opens. Response fields
// telegram_delivery + telegram_gate_allows report the real state.
//
// Owner: Atlas, 2026-09-25

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { runAll, classifyDelivery, settleEscalations } = require('./_lib/outcome-monitor.js');
const { isAllowed } = require('./_lib/telegram-gate.js');

const JOB_NAME = 'cron-outcome-monitor';
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * Send, and return WHICH OF THREE THINGS happened — never a bare boolean.
 *
 * The telegram gate answers a suppressed send with a well-formed HTTP 200
 * whose json.ok is true (api/_lib/telegram-gate.js, fakeTelegramOk), so
 * `res.ok` alone cannot tell "Heath read it" from "the gate ate it".
 * classifyDelivery() reads the gate's explicit suppressed marker first.
 * Everything downstream keys off that state, and only 'sent' is allowed to
 * advance the escalation ladder.
 */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { state: 'failed', detail: 'telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)' };
  }
  let res;
  let body = null;
  try {
    res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    return classifyDelivery({ error: `telegram fetch failed: ${e.message}` });
  }
  return classifyDelivery({ ok: res.ok, status: res.status, body });
}

module.exports = withTelemetry('cron-outcome-monitor', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const dryRun = req.query && req.query.dry_run === '1';
  const onlyKeys = req.query && req.query.key ? [String(req.query.key)] : null;

  const summary = await runAll({ dryRun, onlyKeys });

  // Recoveries first -- a loud alert followed by silence reads as "still
  // broken", so a fix always gets its own line.
  const messages = [...summary.recoveries, ...summary.alerts];
  let delivery = { state: 'skipped', detail: 'nothing to say' };
  let settled = null;
  if (messages.length && !dryRun) {
    delivery = await sendTelegram(messages.join('\n\n---\n\n').slice(0, 3900));
    // Settle the ladder against the REAL outcome. A suppressed or failed send
    // leaves every incident un-escalated and still due, so it speaks again on
    // the next run instead of going quiet for 24h on a message nobody got.
    settled = await settleEscalations(summary, delivery);
  }

  // items is what makes this cron's OWN telemetry honest: the number of
  // expectations evaluated, never a bare 200.
  return res.status(200).json({
    ok: true,
    items: summary.expectations,
    expectations: summary.expectations,
    met: summary.met,
    remediated: summary.remediated,
    gaps: summary.gaps,
    errors: summary.errors,
    // alerts RAISED vs escalations actually DELIVERED. They are different
    // numbers whenever the gate is closed, and conflating them is the defect.
    escalated: summary.alerts.length,
    escalations_confirmed: settled && delivery.state === 'sent' ? settled.incidents : 0,
    escalation_write_failures: settled ? settled.write_failures : 0,
    recovered: summary.recoveries.length,
    telegram_delivery: delivery.state,        // sent | suppressed | failed | skipped
    telegram_sent: delivery.state === 'sent',
    telegram_detail: delivery.detail || undefined,
    // The gate's own verdict, computed without sending anything — so a dry run
    // can answer "would Heath actually hear this?" truthfully.
    telegram_gate_allows: isAllowed(JOB_NAME),
    dry_run: !!dryRun,
    preview: dryRun ? messages : undefined,
    results: summary.results.map((r) => ({
      key: r.key, status: r.status, expected: r.expected, actual: r.actual,
      cause: r.cause && r.cause.cause,
      remediation: r.remediation && r.remediation.runs
        ? r.remediation.runs.map((x) => `${x.remediation}:${x.attempted ? (x.ok ? 'ok' : 'fail') : 'skip'}`)
        : undefined,
      alert_raised: !!r.alert,
      alert_delivery: r.alert ? delivery.state : undefined,
    })),
  });
});
