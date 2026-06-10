'use strict';

// api/cron-desktop-summary.js
//
// Daily 7AM CDT digest of Cole's desktop-control activity.
// Schedule: 0 12 * * * (12:00 UTC = 7AM CDT during summer; in winter it lands
// at 6AM CST, which is fine).
//
// Registered as cron-job.org JOB-009 (Vercel is at cron cap, see INDEX.md).
//
// Auth: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
//
// Pulls last 24 hours of desktop_actions, groups by:
//   - autonomous (approved_by IS NULL, result like 'success%')
//   - confirmed (approved_by = 'heath', result like 'success%')
//   - blocked (result like 'blocked%' OR confirmation_denied)
//   - aborted (result like '%failsafe%' OR aborted)
//   - failures (result = 'failure')
// Sends a plain-text Telegram summary to Heath.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';
const CRON_SECRET = process.env.CRON_SECRET;

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function fetchActions(sinceISO) {
  const path = `/rest/v1/desktop_actions?created_at=gte.${encodeURIComponent(sinceISO)}&select=action_type,target,approved_by,result,created_at&order=created_at.asc`;
  const { ok, data } = await supabaseFetch(path);
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

function categorize(rows) {
  const buckets = {
    autonomous: [],
    confirmed: [],
    blocked: [],
    aborted: [],
    failures: [],
    confirmation_events: [],
  };
  for (const r of rows) {
    const result = (r.result || '').toLowerCase();
    const at = r.action_type || '';
    if (at.startsWith('confirmation_')) {
      buckets.confirmation_events.push(r);
      continue;
    }
    if (result.startsWith('blocked')) {
      buckets.blocked.push(r);
    } else if (result.includes('failsafe') || result.includes('aborted')) {
      buckets.aborted.push(r);
    } else if (result === 'failure') {
      buckets.failures.push(r);
    } else if (r.approved_by === 'heath') {
      buckets.confirmed.push(r);
    } else {
      buckets.autonomous.push(r);
    }
  }
  return buckets;
}

function topN(rows, n = 5) {
  // Group by action_type for a compact summary
  const counts = {};
  for (const r of rows) {
    const k = r.action_type;
    counts[k] = (counts[k] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
  return sorted.map(([k, c]) => `${k} x${c}`).join(', ') || '(none)';
}

function buildMessage(buckets, sinceISO) {
  const lines = [];
  const since = new Date(sinceISO);
  lines.push(`Cole desktop summary - last 24h (since ${since.toISOString().slice(0, 16)})`);
  lines.push('');
  lines.push(`Autonomous: ${buckets.autonomous.length} (${topN(buckets.autonomous)})`);
  lines.push(`Confirmed by Heath: ${buckets.confirmed.length} (${topN(buckets.confirmed)})`);
  lines.push(`Blocked at guard: ${buckets.blocked.length} (${topN(buckets.blocked)})`);
  lines.push(`Aborted (failsafe/kill): ${buckets.aborted.length}`);
  lines.push(`Failures: ${buckets.failures.length}`);

  const denied = buckets.confirmation_events.filter(r => r.action_type === 'confirmation_denied').length;
  const confirmedCount = buckets.confirmation_events.filter(r => r.action_type === 'confirmation_confirmed').length;
  lines.push('');
  lines.push(`Confirm prompts: ${confirmedCount} confirmed, ${denied} denied`);

  if (buckets.failures.length > 0) {
    lines.push('');
    lines.push('Recent failures:');
    for (const r of buckets.failures.slice(-3)) {
      lines.push(`- ${r.action_type} ${r.target || ''} (${r.result})`);
    }
  }

  return lines.join('\n');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[cron-desktop-summary] TELEGRAM_BOT_TOKEN not set');
    return;
  }
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('[cron-desktop-summary] Telegram failed:', res.status, t.slice(0, 200));
  }
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const sinceISO = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  console.log('[cron-desktop-summary] fetching actions since', sinceISO);

  let rows = [];
  try {
    rows = await fetchActions(sinceISO);
  } catch (err) {
    console.error('[cron-desktop-summary] fetchActions failed:', err && err.message);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }

  // If there's no activity, send a "nothing happened" note so Heath knows it's alive.
  if (rows.length === 0) {
    const msg = `Cole desktop summary - last 24h\n\nNo desktop activity. (System is alive - just nothing happened.)`;
    await sendTelegram(msg);
    return res.status(200).json({ ok: true, total: 0, message: msg });
  }

  const buckets = categorize(rows);
  const message = buildMessage(buckets, sinceISO);
  console.log('[cron-desktop-summary] message:\n', message);
  await sendTelegram(message);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    total_rows: rows.length,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    message,
  });
};
