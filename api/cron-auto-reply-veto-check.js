'use strict';

// Vercel Serverless Function: /api/cron-auto-reply-veto-check
//
// Two jobs for the auto-reply-with-veto feature (Heath's explicit approval,
// 2026-09-16 — see supabase/migrations/20260916_auto_reply_veto.sql):
//
//   1. VETO-WINDOW RESOLUTION. tc_discovery_responses rows sitting in
//      reply_status='pending_veto' past their veto_deadline_at (set by
//      api/cron-tc-reply-approval.js, 10 minutes after the STOP-button
//      message was delivered) with no STOP tap: auto-approve them
//      (reply_status='approved', auto_approved=true) so the existing
//      scripts/fb-group-commenter.js --tc-reply-queue poster picks them up
//      exactly like a manual Approve — same facebook_reply cap, same
//      min-gap, same verify-by-re-render. If the kill switch
//      (scripts/_lib/auto-reply-kill-switch.js) has been flipped OFF since
//      the row entered pending_veto, this does NOT auto-approve — it falls
//      back to 'notified' so Heath's original draft is still there for a
//      manual Approve/Edit/Skip.
//
//   2. SLA ALERT. Any row still unanswered (reply_status in
//      new/flagged/notified/pending_veto) more than 60 minutes after
//      harvested_at gets exactly ONE Telegram alert (sla_alerted_at gates
//      the repeat).
//
// A STOP tap (api/telegram-webhook.js, autoreply_stop:<id>) races this cron
// via an atomic status-guarded PATCH (reply_status=eq.pending_veto) — same
// double-claim pattern as the existing approved->posting claim in
// scripts/fb-group-commenter.js. Whichever write lands first wins; the
// loser's PATCH matches zero rows and is a no-op.
//
// Auth: x-vercel-cron header or Bearer ${CRON_SECRET}.
// Schedule: vercel.json — every 5 minutes (tight enough that a 10-minute
// veto window is meaningfully enforced, loose enough not to hammer Supabase).
//
// Owner: Carter, 2026-09-16

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-auto-reply-veto-check');
const { wasSuppressed } = telegramGate;

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const autoReplyKillSwitch = require('../scripts/_lib/auto-reply-kill-switch.js');
const { logAutonomousAction } = require('./_lib/ops-policy.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SLA_MINUTES = 60;
const MAX_PER_RUN = 25;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function telegramSend(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data, raw };
}

/**
 * Resolve every pending_veto row past its deadline: auto-approve (kill
 * switch on) or fall back to notified (kill switch off).
 *
 * @param {object} deps { sbFetch, send, isSuppressed, isAutoReplyEnabled, log }
 * @returns {Promise<{autoApproved:number, fellBackToManual:number, errors:Array}>}
 */
async function processVetoDeadlines(deps) {
  const {
    sbFetch = supabaseFetch,
    send = telegramSend,
    isSuppressed = wasSuppressed,
    isAutoReplyEnabled = autoReplyKillSwitch.isAutoReplyEnabled,
    log = console,
  } = deps || {};

  const out = { autoApproved: 0, fellBackToManual: 0, errors: [] };
  const nowIso = new Date().toISOString();

  const { ok, data } = await sbFetch(
    '/rest/v1/tc_discovery_responses'
    + '?reply_status=eq.pending_veto&veto_deadline_at=lte.' + encodeURIComponent(nowIso)
    + `&select=id,commenter_name,reply_draft&order=veto_deadline_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!ok) { out.errors.push({ step: 'load' }); return out; }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  const switchOn = await isAutoReplyEnabled();

  for (const row of rows) {
    try {
      if (switchOn) {
        // Atomic claim: only succeeds if a STOP tap hasn't already moved
        // this row off pending_veto.
        const patch = await sbFetch(
          `/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(row.id)}&reply_status=eq.pending_veto`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              reply_status: 'approved',
              reply_final: row.reply_draft,
              reply_approved_at: nowIso,
              auto_approved: true,
              updated_at: nowIso,
            }),
          },
        );
        const won = patch.ok && Array.isArray(patch.data) && patch.data.length > 0;
        if (won) {
          out.autoApproved++;
          // Standing-authority audit trail (api/_lib/ops-policy.js,
          // capability 'reply_low_risk_comments' -> ops_flags.auto_reply).
          // Fire-and-forget; the approval already happened.
          await logAutonomousAction({
            capability: 'reply_low_risk_comments',
            decision: 'autonomous',
            action: `auto-approved reply to ${row.commenter_name} after 10-min veto window (no STOP)`,
            firedBy: 'cron-auto-reply-veto-check',
            gatesPassed: ['risk_classifier_low_risk_high_confidence', 'content_gates', 'veto_window_10min_no_stop'],
            refTable: 'tc_discovery_responses',
            refId: row.id,
          }).catch(() => {});
          const sendRes = await send(
            `Auto-approved (no STOP in 10 min) — reply to ${row.commenter_name} posts on the next local poster run.`,
          );
          if (sendRes.ok && !isSuppressed(sendRes.data)) {
            // best-effort confirmation only; not a state-changing send
          }
        }
        // If not won, a STOP tap beat this cron to it — nothing to do.
      } else {
        // Kill switch flipped off mid-flight: never auto-post. Fall back to
        // the pre-existing manual flow — the draft is already there.
        const patch = await sbFetch(
          `/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(row.id)}&reply_status=eq.pending_veto`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ reply_status: 'notified', updated_at: nowIso }),
          },
        );
        const won = patch.ok && Array.isArray(patch.data) && patch.data.length > 0;
        if (won) {
          out.fellBackToManual++;
          await send(
            `Auto-reply is switched off — the reply to ${row.commenter_name} needs your manual Approve/Edit/Skip (see the earlier message).`,
          );
        }
      }
    } catch (err) {
      log.error(`[cron-auto-reply-veto-check] row ${row.id} failed: ${err.message}`);
      out.errors.push({ id: row.id, error: err.message });
    }
  }

  return out;
}

/**
 * Alert Heath once per row that has sat unanswered past the 60-minute SLA.
 *
 * @param {object} deps { sbFetch, send, isSuppressed, log }
 * @returns {Promise<{alerted:number, errors:Array}>}
 */
async function sweepSlaAlerts(deps) {
  const {
    sbFetch = supabaseFetch,
    send = telegramSend,
    isSuppressed = wasSuppressed,
    log = console,
  } = deps || {};

  const out = { alerted: 0, errors: [] };
  const cutoffIso = new Date(Date.now() - SLA_MINUTES * 60 * 1000).toISOString();

  const { ok, data } = await sbFetch(
    '/rest/v1/tc_discovery_responses'
    + '?reply_status=in.(new,flagged,notified,pending_veto)'
    + '&sla_alerted_at=is.null'
    + '&harvested_at=lt.' + encodeURIComponent(cutoffIso)
    + `&select=id,commenter_name,source_group,comment_permalink,post_url,harvested_at,reply_status&order=harvested_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!ok) { out.errors.push({ step: 'load' }); return out; }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  for (const row of rows) {
    try {
      const ageMin = Math.round((Date.now() - new Date(row.harvested_at).getTime()) / 60000);
      const text = `SLA BREACH: comment from ${row.commenter_name} in ${row.source_group || 'a group'} has sat unanswered ${ageMin} min (status: ${row.reply_status}).\n${row.comment_permalink || row.post_url || ''}`;
      const sendRes = await send(text);
      if (!sendRes.ok) { out.errors.push({ id: row.id, step: 'send' }); continue; }
      if (isSuppressed(sendRes.data)) {
        out.errors.push({ id: row.id, step: 'send', error: 'suppressed_by_telegram_gate' });
        continue;
      }
      await sbFetch(`/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ sla_alerted_at: new Date().toISOString() }),
      });
      out.alerted++;
    } catch (err) {
      log.error(`[cron-auto-reply-veto-check] sla row ${row.id} failed: ${err.message}`);
      out.errors.push({ id: row.id, error: err.message });
    }
  }

  return out;
}

module.exports = withTelemetry('cron-auto-reply-veto-check', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }

  const vetoResult = await processVetoDeadlines({});
  const slaResult = await sweepSlaAlerts({});
  console.log('[cron-auto-reply-veto-check]', JSON.stringify({ vetoResult, slaResult }));
  return res.status(200).json({ ok: true, veto: vetoResult, sla: slaResult });
});

module.exports.processVetoDeadlines = processVetoDeadlines;
module.exports.sweepSlaAlerts = sweepSlaAlerts;
module.exports.SLA_MINUTES = SLA_MINUTES;
