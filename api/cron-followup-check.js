// Vercel Serverless Function: /api/cron-followup-check
//
// Purpose: cloud-native durable follow-up firing loop. Runs every 15 minutes,
// finds pending followups whose due_at has passed, sends a Telegram alert to
// Heath, and flips the row to status='fired' so it never re-fires.
//
// Auth: Vercel cron header OR Authorization: Bearer ${CRON_SECRET}.
//
// Schedule: */15 * * * * — every 15 minutes (vercel.json).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatAlert(row) {
  const parts = [];
  parts.push(`<b>Follow-up due</b> — ${escapeHtml(row.title)}`);
  if (row.context) {
    parts.push('');
    parts.push(escapeHtml(row.context));
  }
  if (row.escalation_contact) {
    parts.push('');
    parts.push(`<b>Escalation:</b> ${escapeHtml(row.escalation_contact)}`);
  }
  parts.push('');
  parts.push(`<i>id: ${escapeHtml(row.id)}</i>`);
  return parts.join('\n');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'Telegram env not configured' };
  }
  try {
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
    const bodyText = await res.text();
    return { ok: res.ok, status: res.status, body: bodyText };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'send failed' };
  }
}

module.exports = withTelemetry('cron-followup-check', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase env not configured' });
  }

  const now = new Date().toISOString();
  const query = `/rest/v1/followups?status=eq.pending&due_at=lte.${encodeURIComponent(now)}&order=due_at.asc&limit=50`;
  const listing = await supabaseFetch(query);
  if (!listing.ok) {
    return res.status(500).json({ ok: false, error: 'Supabase list failed', status: listing.status, detail: listing.data });
  }

  const due = Array.isArray(listing.data) ? listing.data : [];
  const fired = [];
  const errors = [];

  for (const row of due) {
    // Debounce: atomic status flip so parallel/retry invocations never re-fire.
    // We PATCH with a filter that requires the row to still be status=pending.
    const patchRes = await supabaseFetch(
      `/rest/v1/followups?id=eq.${encodeURIComponent(row.id)}&status=eq.pending`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'fired', fired_at: new Date().toISOString() }),
      }
    );

    if (!patchRes.ok) {
      errors.push({ id: row.id, stage: 'claim', status: patchRes.status, detail: patchRes.data });
      continue;
    }
    const claimed = Array.isArray(patchRes.data) ? patchRes.data : [];
    if (claimed.length === 0) {
      // Another invocation claimed it first — skip silently.
      continue;
    }

    const alert = formatAlert(row);
    const send = await sendTelegram(alert);
    if (!send.ok) {
      // Revert to pending so we retry next tick.
      await supabaseFetch(`/rest/v1/followups?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'pending', fired_at: null }),
      });
      errors.push({ id: row.id, stage: 'telegram', error: send.error || send.body || null });
      continue;
    }
    fired.push({ id: row.id, title: row.title });
  }

  return res.status(200).json({
    ok: true,
    now,
    dueCount: due.length,
    firedCount: fired.length,
    errorCount: errors.length,
    fired,
    errors,
  });
});
