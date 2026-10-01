'use strict';

// api/_lib/sms-import-health.js
//
// Consumed by api/_lib/silence-alarm.js's runAllChecks() -- same daily
// heartbeat cron, same alert_state dedup, same Telegram path as every other
// silent-failure detector (see api/cron-silence-alarm.js and the sibling
// api/_lib/google-token-health.js, same shape). No new standalone Vercel
// cron needed.
//
// THE INCIDENT THIS CLOSES (2026-10-01): the Windows "SmsPoller" Scheduled
// Task (scripts/sms-poller-hidden.vbs -> scripts/run-sms-poller.sh ->
// scripts/import-phone-link.py) ran every 12 min for 7 straight days
// (2026-09-24 -> 2026-10-01) with Last Task Result 0 the entire time, while
// Phone Link on the Windows PC had silently lost its connection to the
// phone and sms_messages received ZERO new rows. "Last Result 0" only
// proves wscript.exe launched the script and it exited cleanly -- the
// script itself treats "found the same already-imported rows again" as a
// success, by design (it's meant to be safe to run back-to-back). Nobody
// noticed until Heath asked why he couldn't see client texts mid-deal.
//
// Unlike google-token-health.js's refresh ladder, there is nothing this
// code can self-heal: Phone Link's phone-side connection can only be
// restored by a human on the Windows machine / the phone itself. This file
// is therefore read-only -- it only detects and names the fix.
//
// Phone Link's own on-disk cache is a rolling ~30-day window (see
// scripts/import-phone-link.py header), so every day this sits broken is a
// day closer to permanently losing whatever the phone hasn't synced yet.
// SMS_IMPORT_STALE_HOURS is deliberately tight (24h, not days) for that
// reason, and because the poller ticks every 12 min -- 24h of zero new
// rows is already ~120 confirmed no-op runs, not a blip.
//
// Owner: Atlas, 2026-10-01.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SMS_IMPORT_STALE_HOURS = 24;

async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Returns [] when a new sms_messages row has landed within the last
 * `staleHours`, or exactly one condition object (same shape as every other
 * api/_lib/silence-alarm.js check*() function) naming the gap and the fix.
 * Only alarms if the table has ever held a row at all, so an environment
 * where this was never set up doesn't alarm forever (same gate shape as
 * checkPlatformSilence's hasRecentActivity).
 */
async function checkSmsImportStale(staleHours = SMS_IMPORT_STALE_HOURS) {
  const everImported = await supabaseFetch('/rest/v1/sms_messages?select=id&limit=1');
  if (!everImported.ok || !Array.isArray(everImported.data) || everImported.data.length === 0) return [];

  const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000).toISOString();
  const recent = await supabaseFetch(
    `/rest/v1/sms_messages?created_at=gte.${encodeURIComponent(cutoff)}&select=id&limit=1`,
  );
  if (recent.ok && Array.isArray(recent.data) && recent.data.length > 0) return []; // healthy

  const last = await supabaseFetch('/rest/v1/sms_messages?select=sent_at&order=sent_at.desc&limit=1');
  const lastSentAt = last.ok && Array.isArray(last.data) && last.data[0] ? last.data[0].sent_at : null;

  return [{
    key: 'sms_import_silent',
    lastSentAt,
    message: `No new sms_messages row imported in >${staleHours}h`
      + `${lastSentAt ? ` (newest message on file is from ${lastSentAt})` : ''}. The SmsPoller Windows Task showing `
      + "Last Result 0 only means the task launched -- it doesn't mean Phone Link had anything new to give it. "
      + 'On the Windows PC: open Phone Link (or Settings > Bluetooth & devices > Phone Link) and confirm it shows '
      + 'the phone as actually connected, not just "installed." Reconnect if it does not. Do NOT uninstall/re-pair '
      + 'from scratch unless reconnecting fails -- a fresh pair resets the ~30-day rolling sync window. '
      + 'See scripts/import-phone-link.py header.',
  }];
}

module.exports = { checkSmsImportStale, SMS_IMPORT_STALE_HOURS };
