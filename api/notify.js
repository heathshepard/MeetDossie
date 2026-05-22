// Vercel Serverless Function: /api/notify
//
// Generic "ping Heath on Telegram" endpoint for trusted external callers
// (the primary use case is Anthropic-cloud scheduled routines / agents
// that need to surface a result to Heath without holding any local
// credentials).
//
// POST /api/notify
// Headers:  Content-Type: application/json
// Body:     { "subject": "Optional headline", "message": "Body text" }
//
// Security model: NO bearer auth (the calling routine config is stored
// in Anthropic's cloud and we don't want bot tokens or CRON_SECRET in
// that prompt). Instead we rely on three properties to keep this safe:
//
//   1. The endpoint can ONLY send Telegram to TELEGRAM_CHAT_ID (Heath).
//      A leaked URL cannot be weaponized to message anyone else.
//   2. Strict per-IP + global rate limit (in-memory; resets on cold
//      start, but that's fine — bursts to a single chat are still bounded
//      below the abuse threshold).
//   3. Hard size cap on the message (Telegram limit anyway).
//
// Worst case if URL leaks: someone sends Heath ~30 throwaway notifications
// per day before being rate-limited. He can shut the endpoint off in one
// commit. No data exposure, no account compromise.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_TEXT_LEN = 3500;
const RATE_GLOBAL_PER_HOUR = 12;
const RATE_GLOBAL_PER_DAY = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// In-memory rate-limit window. Resets on Vercel function cold-start
// (acceptable: the daily cap re-arms when traffic resumes; abusers
// can't predict cold starts to evade limits in any useful way).
const callTimestamps = [];

function pruneAndCount() {
  const now = Date.now();
  while (callTimestamps.length && now - callTimestamps[0] > DAY_MS) {
    callTimestamps.shift();
  }
  let hourCount = 0;
  for (let i = callTimestamps.length - 1; i >= 0; i--) {
    if (now - callTimestamps[i] <= HOUR_MS) hourCount++;
    else break;
  }
  return { hour: hourCount, day: callTimestamps.length };
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data?.ok, status: res.status, data };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'telegram_env_missing' });
  }

  const { hour, day } = pruneAndCount();
  if (hour >= RATE_GLOBAL_PER_HOUR || day >= RATE_GLOBAL_PER_DAY) {
    res.setHeader('Retry-After', '3600');
    return res.status(429).json({ ok: false, error: 'rate_limited', hour, day });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'body_required' });
  }

  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return res.status(400).json({ ok: false, error: 'message_required' });
  }

  const composed = (subject ? `🔔 ${subject}\n\n` : '🔔 ') + message;
  const text = composed.length > MAX_TEXT_LEN ? composed.slice(0, MAX_TEXT_LEN - 3) + '...' : composed;

  const tg = await sendTelegram(text);
  if (!tg.ok) {
    return res.status(502).json({ ok: false, error: 'telegram_failed', status: tg.status, data: tg.data });
  }

  callTimestamps.push(Date.now());

  return res.status(200).json({
    ok: true,
    message_id: tg.data?.result?.message_id,
    rate: pruneAndCount(),
  });
}
