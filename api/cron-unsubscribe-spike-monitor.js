// Vercel Serverless Function: /api/cron-unsubscribe-spike-monitor
//
// Fires hourly. Counts unsubscribes in the last 24h. If > 2, sends a Telegram
// alert to Heath with the 3 most-recent unsubscribed emails and a 24h-avg vs
// prior-baseline snapshot.
//
// Idempotency: won't ping twice within 6h. Stored in public.unsubscribe_alert_log.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 * * * * (hourly on the hour)

const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;

const SPIKE_THRESHOLD_24H = 2;   // strictly > 2 triggers alert
const DEDUP_WINDOW_HOURS  = 6;   // don't re-ping within this window

function sbHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function sb(pathAndQuery, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: { ...sbHeaders(), ...(init.headers || {}) },
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: r.ok, status: r.status, data };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, skipped: 'no_env' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return { ok: r.ok };
  } catch (err) {
    console.warn('[unsub-spike] tg error', err && err.message);
    return { ok: false };
  }
}

async function countSince(sinceIso) {
  const url = `email_suppression_list?unsubscribed_at=gte.${encodeURIComponent(sinceIso)}&select=email,unsubscribed_at&order=unsubscribed_at.desc`;
  const r = await sb(url);
  if (!r.ok) return { count: 0, latest: [] };
  const rows = Array.isArray(r.data) ? r.data : [];
  return {
    count: rows.length,
    latest: rows.slice(0, 3).map(x => x.email),
  };
}

async function priorBaselineAvgPerDay(daysBack = 14) {
  // Simple baseline: total unsubs / days, over the trailing 14d ending 24h ago.
  const now = Date.now();
  const start = new Date(now - (daysBack + 1) * 24 * 3600 * 1000).toISOString();
  const end   = new Date(now -                     24 * 3600 * 1000).toISOString();
  const url = `email_suppression_list?unsubscribed_at=gte.${encodeURIComponent(start)}&unsubscribed_at=lt.${encodeURIComponent(end)}&select=email`;
  const r = await sb(url);
  if (!r.ok) return 0;
  const rows = Array.isArray(r.data) ? r.data : [];
  return +(rows.length / daysBack).toFixed(2);
}

async function recentAlertExists(windowHours) {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const url = `unsubscribe_alert_log?fired_at=gte.${encodeURIComponent(since)}&select=id&limit=1`;
  const r = await sb(url);
  if (!r.ok) return false;
  return Array.isArray(r.data) && r.data.length > 0;
}

async function logAlert(unsubCount, latestEmails, messageSent) {
  await sb('unsubscribe_alert_log', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      unsub_count: unsubCount,
      window_hours: 24,
      latest_emails: latestEmails || [],
      message_sent: messageSent || null,
    }),
  });
}

async function handler(req, res) {
  const forceRun    = req.query && (req.query.force === '1' || req.query.force === 'true');
  const forceIgnore = req.query && (req.query.ignore_dedup === '1');

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
  }

  const startedAt = Date.now();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  try {
    const { count, latest } = await countSince(dayAgo);
    const baseline = await priorBaselineAvgPerDay(14);

    const result = {
      unsub_24h: count,
      threshold: SPIKE_THRESHOLD_24H,
      baseline_per_day: baseline,
      latest: latest,
      pinged: false,
      skipped: null,
    };

    if (!forceRun && count <= SPIKE_THRESHOLD_24H) {
      result.skipped = 'below_threshold';
      recordCronRun('cron-unsubscribe-spike-monitor', 'ok', result).catch(() => {});
      return res.status(200).json({ ok: true, ...result });
    }

    if (!forceIgnore && await recentAlertExists(DEDUP_WINDOW_HOURS)) {
      result.skipped = 'dedup_recent_alert';
      recordCronRun('cron-unsubscribe-spike-monitor', 'ok', result).catch(() => {});
      return res.status(200).json({ ok: true, ...result });
    }

    const avgPerDay = (count).toFixed(1);
    const msg = [
      `<b>Unsubscribe spike — ${count} in last 24h</b>`,
      '',
      'Latest emails:',
      ...(latest.length ? latest.map(e => `- ${e}`) : ['(none)']),
      '',
      `24h count: ${avgPerDay}/day. Prior 14d baseline: ${baseline}/day.`,
      '',
      'Investigate: batch quality, subject line, list source.',
    ].join('\n');

    const sendResult = await tg(msg);
    result.pinged = !!sendResult.ok;

    await logAlert(count, latest, msg).catch(() => {});

    const duration_ms = Date.now() - startedAt;
    recordCronRun('cron-unsubscribe-spike-monitor', 'ok', { duration_ms, ...result }).catch(() => {});
    return res.status(200).json({ ok: true, duration_ms, ...result });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const msg = (err && err.message) ? err.message.slice(0, 500) : 'crash';
    recordCronRun('cron-unsubscribe-spike-monitor', 'error', { duration_ms, error: msg }).catch(() => {});
    return res.status(500).json({ ok: false, error: msg, duration_ms });
  }
}

module.exports = handler;
module.exports.default = handler;
