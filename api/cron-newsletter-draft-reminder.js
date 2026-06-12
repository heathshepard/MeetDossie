// Vercel Serverless Function: /api/cron-newsletter-draft-reminder
//
// Thursday 4 PM CDT (21:00 UTC). Pings Heath via Telegram if the current week's
// newsletter draft is still in pending_review status. Reminder is a courtesy to
// ensure he doesn't forget to review before Friday's auto-send.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 21 * * 4" (21:00 UTC Thursday = 4:00 PM CDT).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

// ─── Supabase REST helper ────────────────────────────────────────────────

async function supabaseFetch(p, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// ─── Date helpers ───────────────────────────────────────────────────────

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ─── Telegram ─────────────────────────────────────────────────────────────

async function sendTelegram(chat_id, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// ─── Handler ─────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-newsletter-draft-reminder', async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
    }

    const now = new Date();
    const weekKey = isoWeekKey(now);

    // Query for draft in pending_review status
    const draftRes = await supabaseFetch(
      `/rest/v1/newsletter_drafts?week_iso=eq.${encodeURIComponent(weekKey)}&status=eq.pending_review&select=id,status`,
    );
    if (!draftRes.ok) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'draft query failed', status: draftRes.status });
    }

    const drafts = draftRes.data || [];
    if (drafts.length === 0) {
      // No pending draft — silent skip (either approved, sent, or doesn't exist)
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'no pending draft for this week',
        week_key: weekKey,
      });
    }

    // Draft is still pending — send reminder
    const reminderText = `🔔 Friendly reminder — Thursday newsletter draft still awaiting your review. <code>APPROVE</code> to lock it in, or edit/regen if needed.`;
    await sendTelegram(TELEGRAM_CHAT_ID, reminderText);

    return res.status(200).json({
      ok: true,
      week_key: weekKey,
      reminder_sent: true,
    });
  } catch (err) {
    console.error('[cron-newsletter-draft-reminder] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
