// Vercel Serverless Function: /api/reset-telegram-webhook
//
// Resets the DossieMarketingBot webhook to /api/telegram-webhook (the social
// post approve/reject flow).
//
// SCOPE IS DELIBERATELY LIMITED TO TELEGRAM_MARKETING_BOT_TOKEN.
//
// This endpoint used to also reset TELEGRAM_BOT_TOKEN (@DossieAssistant_bot)
// to the same /api/telegram-webhook URL. That was a landmine: telegram-webhook.js
// resolves its send token as
//     TELEGRAM_MARKETING_BOT_TOKEN || TELEGRAM_BOT_TOKEN
// so with the marketing token set, DossieAssistant_bot's messages were handled
// there but every reply went out as DossieMarketingBot — the wrong bot. It also
// silently stole the registration from /api/claudy-webhook, which is
// DossieAssistant_bot's real handler.
//
// DossieAssistant_bot's registration is owned solely by
// /api/set-assistant-webhook. Do not add TELEGRAM_BOT_TOKEN back here.
//
// GET /api/reset-telegram-webhook
// Headers: Authorization: Bearer ${CRON_SECRET}
// Returns: { ok, bots: { marketing: {...} } }

const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

const MARKETING_WEBHOOK_URL = 'https://meetdossie.com/api/telegram-webhook';
// telegram-webhook.js handles inline approve/reject buttons, so callback_query
// is required. Omitting allowed_updates lets Telegram fall back to defaults —
// be explicit so an accidental reset can never drop it.
const MARKETING_ALLOWED_UPDATES = ['message', 'callback_query'];

async function setMarketingWebhook(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: MARKETING_WEBHOOK_URL,
        allowed_updates: MARKETING_ALLOWED_UPDATES,
      }),
    });
    const data = await res.json();
    return { name: 'DossieMarketingBot', ok: res.ok && data.ok, result: data };
  } catch (error) {
    return { name: 'DossieMarketingBot', ok: false, error: error.message };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Auth added 2026-06-10 (Atlas) — endpoint resets webhook URLs; without
  // auth, an attacker could deregister/redirect Heath's Telegram bots.
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!TELEGRAM_MARKETING_BOT_TOKEN) {
    return res
      .status(500)
      .json({ ok: false, error: 'TELEGRAM_MARKETING_BOT_TOKEN not set' });
  }

  const marketing = await setMarketingWebhook(TELEGRAM_MARKETING_BOT_TOKEN);

  return res.status(200).json({
    ok: marketing.ok,
    timestamp: new Date().toISOString(),
    note: 'DossieAssistant_bot is not touched here — see /api/set-assistant-webhook',
    bots: { marketing },
  });
};
