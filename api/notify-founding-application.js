// Vercel Serverless Function: /api/notify-founding-application
// Sends a Telegram notification for a freshly-inserted founding_applications
// row. The browser POSTs the applicant's email; the server looks up the most
// recent matching row (within RECENT_WINDOW_MS) via the service role and uses
// the DB's authoritative content for the message — so callers cannot spoof
// message bodies, and a Telegram ping cannot fire without an actual DB row.
//
// POST { email }   (no auth — public from /founding, CORS-restricted)
//
// Why email not id: anon RLS allows INSERT only (no SELECT), so the browser
// inserts with Prefer: return=minimal and never sees the row id. Looking up
// by email + recency is the next-best correlation key.
//
// Environment:
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (server-side only)
//   TELEGRAM_BOT_TOKEN        — bot token
//   TELEGRAM_CHAT_ID          — chat id to deliver the notification to

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RECENT_WINDOW_MS = 5 * 60 * 1000;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      VERCEL_PREVIEW_ORIGIN_RE.test(origin)
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return Boolean(allowOrigin) || !origin;
}

function escTelegram(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildMessage(app) {
  const sidesPretty = (function (s) {
    var v = String(s || '').toLowerCase();
    if (v === 'buyer') return 'Buyer side';
    if (v === 'listing') return 'Listing side';
    if (v === 'both') return 'Both sides';
    return s || '—';
  })(app.sides);

  const lines = [
    '📝 <b>New Founding Member Application</b>',
    '',
    `<b>Name:</b> ${escTelegram(app.name)}`,
    `<b>Email:</b> ${escTelegram(app.email)}`,
    `<b>Brokerage:</b> ${escTelegram(app.brokerage)}`,
    `<b>Market:</b> ${escTelegram(app.market)}`,
    `<b>Transactions (last 12mo):</b> ${escTelegram(String(app.transactions_12mo))}`,
    `<b>Sides:</b> ${escTelegram(sidesPretty)}`,
    '',
    '<b>Why Dossie:</b>',
    escTelegram(app.why),
    '',
    `<i>Application id: ${escTelegram(app.id)}</i>`,
  ];
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured (supabase).' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[notify-founding-application] TELEGRAM_BOT_TOKEN/CHAT_ID not set — skipping notification.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram not configured' });
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return res.status(400).json({ ok: false, error: 'Invalid email.' });
  }

  const sinceIso = new Date(Date.now() - RECENT_WINDOW_MS).toISOString();
  let app;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/founding_applications` +
      `?email=eq.${encodeURIComponent(email)}` +
      `&created_at=gte.${encodeURIComponent(sinceIso)}` +
      `&select=*&order=created_at.desc&limit=1`;
    const r = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[notify-founding-application] supabase lookup failed', r.status, text.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'Application lookup failed.' });
    }
    const rows = await r.json().catch(() => []);
    app = Array.isArray(rows) ? rows[0] : null;
  } catch (err) {
    console.error('[notify-founding-application] supabase fetch threw', err && err.message);
    return res.status(502).json({ ok: false, error: 'Application lookup failed.' });
  }

  if (!app || !app.id) {
    return res.status(404).json({ ok: false, error: 'No recent application matches that email.' });
  }

  const text = buildMessage(app);

  try {
    const tg = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const tgText = await tg.text();
    let tgData = null;
    try { tgData = tgText ? JSON.parse(tgText) : null; } catch { tgData = null; }
    if (!tg.ok || tgData?.ok !== true) {
      console.error('[notify-founding-application] telegram send failed', tg.status, tgText.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'Notification failed.' });
    }
    return res.status(200).json({ ok: true, message_id: tgData.result?.message_id || null });
  } catch (err) {
    console.error('[notify-founding-application] telegram threw', err && err.message);
    return res.status(502).json({ ok: false, error: 'Notification failed.' });
  }
};
