#!/usr/bin/env node
'use strict';

// scripts/check-video-notify-debt.js
//
// NOTIFY DEBT: a video that passed the quality gate, is waiting on Heath, and
// has never actually been put in front of him.
//
// ---------------------------------------------------------------------------
// THE FAILURE THIS EXISTS FOR (measured, not hypothetical)
// ---------------------------------------------------------------------------
// 2026-09-18, 20:45 UTC. Three videos, all quality_status='passed', queued at
// 00:29-00:30 the same morning:
//
//   dossie-d1-ask-deadline-mobile-2026-09-16   pending_heath_review  msg_id NULL
//   dossie-d1-cap7-2026-09-17                  pending_heath_review  msg_id NULL
//   realtor-r1-23-nopalito-shortform-2026-09-16 pending_heath_review msg_id NULL
//
// and `telegram_send_log` had ZERO rows in the preceding 30 hours. Twenty hours
// of finished, gate-passed work that nobody could approve because nobody was
// told it existed. Nothing errored. Every dashboard said the pipeline was
// healthy — this is feedback_silent-failure-is-the-enemy.md exactly.
//
// How it happens without anything breaking: ops_flags.batch_routine_approvals
// is ON, so api/cron-post-videos.js advances a row to pending_heath_review
// WITHOUT sending an individual Telegram card, on the understanding that
// api/_lib/silence-alarm.js's morning brief will carry its Approve/Reject
// buttons instead. If the brief does not run, is suppressed by the
// TELEGRAM_CRON_NOTIFICATIONS kill switch, or simply does not pick that row
// among its top decisions, the video is invisible. The row looks perfectly
// normal; only the ABSENCE of a notification is the defect, and absence is what
// monitoring never catches on its own.
//
// ---------------------------------------------------------------------------
// WHAT COUNTS AS "NOTIFIED"
// ---------------------------------------------------------------------------
// Deliberately generous, so this alarms on real debt and not on bookkeeping:
//
//   * video_library.telegram_message_id is set          -> an individual card
//     was delivered (cron-post-videos records the real message id).
//   * a telegram_send_log row for this video with ok=true and suppressed=false
//     -> a send genuinely went out. A suppressed send is NOT a delivery; that
//     is the same lesson api/cron-video-approval.js already encodes after five
//     videos sat invisible for three weeks off the gate's fake success.
//
// Anything else, for longer than the threshold, is debt.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   node scripts/check-video-notify-debt.js            # check + alarm
//   node scripts/check-video-notify-debt.js --hours 6  # threshold (default 6)
//   node scripts/check-video-notify-debt.js --quiet    # report, never send
//   node scripts/check-video-notify-debt.js --repair   # re-arm for notification
//
// --repair is opt-in and never automatic. It moves a stranded row BACK to the
// pre-notification status so the next cron-post-videos run picks it up and
// re-sends. It is a status change only: it does not publish, does not approve,
// and does not touch the media. It is opt-in because video_library statuses
// were being consolidated by another change on the same day and silently
// rewriting rows underneath that work would be the wrong kind of helpful.

const path = require('path');

const REPO = path.join(__dirname, '..');
try { require('./_lib/load-env-local.js').loadEnvLocal(REPO); } catch { /* optional */ }

const {
  STATUS_AWAITING_NOTIFY,
  STATUS_AWAITING_HEATH,
  ALL_PRE_APPROVAL_STATUSES,
} = require('./_lib/video-queue-status.js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const THRESHOLD_HOURS = Number(opt('hours', '6'));
const QUIET = flag('quiet');
const REPAIR = flag('repair');
const ALERT_KEY = 'video_notify_debt';
const ALERT_COOLDOWN_HOURS = 6;

function log(m) { console.log('[notify-debt] ' + m); }

async function sb(p, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available — cannot check notify debt. '
      + 'This fails LOUD rather than reporting "0 stranded": an unreadable database is not evidence '
      + 'that nothing is stranded.');
  }
  const res = await fetch(`${SUPABASE_URL}${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

async function findDebt() {
  const statuses = ALL_PRE_APPROVAL_STATUSES.join(',');
  const r = await sb(
    `/rest/v1/video_library?status=in.(${statuses})&quality_status=eq.passed`
    + '&select=id,status,target_owner,platforms,telegram_message_id,created_at,topic'
    + '&order=created_at.asc',
  );
  if (!r.ok || !Array.isArray(r.data)) {
    throw new Error(`could not read video_library (HTTP ${r.status}) — failing loud, not reporting zero`);
  }

  // Which of these had a genuinely delivered Telegram send? One query, not one
  // per row — telegram_send_log keys deliveries by (table_name, row_id).
  const ids = r.data.map((v) => v.id);
  const delivered = new Set();
  if (ids.length) {
    const inList = ids.map((i) => `"${i.replace(/"/g, '')}"`).join(',');
    const s = await sb(
      `/rest/v1/telegram_send_log?table_name=eq.video_library&row_id=in.(${encodeURIComponent(inList)})`
      + '&ok=is.true&suppressed=is.false&select=row_id',
    );
    if (s.ok && Array.isArray(s.data)) for (const row of s.data) delivered.add(row.row_id);
  }

  const stranded = [];
  for (const v of r.data) {
    const age = hoursSince(v.created_at);
    const notified = !!v.telegram_message_id || delivered.has(v.id);
    if (!notified && age >= THRESHOLD_HOURS) {
      stranded.push({ ...v, age_hours: Math.round(age * 10) / 10 });
    }
  }
  return { all: r.data, stranded };
}

async function alertOnce(text) {
  if (QUIET) { log('ALERT (suppressed by --quiet):\n' + text); return false; }
  const r = await sb(`/rest/v1/alert_state?key=eq.${ALERT_KEY}&select=*`);
  const row = r.ok && Array.isArray(r.data) ? r.data[0] : null;
  if (row && row.last_fired_at && hoursSince(row.last_fired_at) < ALERT_COOLDOWN_HOURS) {
    log(`alert suppressed (fired ${hoursSince(row.last_fired_at).toFixed(1)}h ago, cooldown ${ALERT_COOLDOWN_HOURS}h)`);
    return false;
  }
  let sent = false;
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      });
      sent = res.ok;
      if (!res.ok) console.warn('[notify-debt] telegram send returned HTTP ' + res.status);
    } catch (e) {
      console.warn('[notify-debt] telegram send failed: ' + e.message);
    }
  } else {
    console.warn('[notify-debt] no TELEGRAM token/chat id — cannot alert. '
      + 'THE ALARM ITSELF IS UNARMED, which is worse than the debt it watches for.');
  }
  await sb('/rest/v1/alert_state?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      key: ALERT_KEY,
      metadata: { text, sent },
      last_fired_at: new Date().toISOString(),
      last_reason: text.slice(0, 200),
      updated_at: new Date().toISOString(),
    }),
  });
  return sent;
}

(async function main() {
  const { all, stranded } = await findDebt();
  log(`${all.length} gate-passed row(s) awaiting Heath; threshold ${THRESHOLD_HOURS}h`);
  for (const v of all) {
    const notified = !!v.telegram_message_id;
    log(`  ${v.id}  status=${v.status}  owner=${v.target_owner}  `
      + `age=${hoursSince(v.created_at).toFixed(1)}h  telegram_message_id=${notified ? v.telegram_message_id : 'NULL'}`);
  }

  if (stranded.length === 0) {
    log('no notify debt — every waiting video has actually been put in front of Heath.');
    process.exit(0);
  }

  const lines = stranded.map((v) => `- ${v.id} (${v.target_owner}, ${v.status}, ${v.age_hours}h, `
    + `-> ${(v.platforms || []).join('/')})`);
  const text = `VIDEO NOTIFY DEBT: ${stranded.length} gate-passed video(s) have been waiting `
    + `over ${THRESHOLD_HOURS}h with NO notification ever delivered.\n\n${lines.join('\n')}\n\n`
    + 'They passed the quality gate and cannot post until you approve them, but nothing ever '
    + 'reached you — no individual card, no delivered send in telegram_send_log. Finished work '
    + 'is sitting idle.\n\n'
    + 'Re-arm them for notification with:\n'
    + '  cd /mnt/c/Users/Heath/Projects/MeetDossie && node scripts/check-video-notify-debt.js --repair';

  console.error('\n' + text + '\n');

  if (REPAIR) {
    log(`--repair: moving ${stranded.length} row(s) back to '${STATUS_AWAITING_NOTIFY}' so the next `
      + 'cron-post-videos run re-sends. Status only — nothing is published or approved.');
    for (const v of stranded) {
      const r = await sb(`/rest/v1/video_library?id=eq.${encodeURIComponent(v.id)}&status=eq.${v.status}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: STATUS_AWAITING_NOTIFY }),
      });
      log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${v.id}: ${v.status} -> ${STATUS_AWAITING_NOTIFY}`);
    }
    log('Now trigger a re-send: curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-post-videos');
  } else {
    await alertOnce(text);
  }

  // Non-zero so the scheduled caller treats notify debt as a failed tick and it
  // shows up in the drift/health checks rather than scrolling past in a log.
  process.exit(2);
})().catch((e) => {
  console.error('[notify-debt] ' + ((e && e.message) || e));
  process.exit(1);
});
