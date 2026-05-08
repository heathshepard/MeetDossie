// Vercel Serverless Function: /api/reset-telegram-webhook
// Reset Telegram webhook without secret token
//
// GET /api/reset-telegram-webhook
// Returns: { ok: true, claudy: {...}, marketing: {...} }

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;

async function setWebhook(token, name) {
  try {
    const url = `https://api.telegram.org/bot${token}/setWebhook?url=https://meetdossie.com/api/telegram-webhook`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      name,
      ok: res.ok && data.ok,
      result: data
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: error.message
    };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const claudy = await setWebhook(TELEGRAM_BOT_TOKEN, 'Claudy');
  const marketing = await setWebhook(TELEGRAM_MARKETING_BOT_TOKEN, 'DossieMarketingBot');

  return res.status(200).json({
    ok: claudy.ok && marketing.ok,
    timestamp: new Date().toISOString(),
    bots: {
      claudy,
      marketing
    }
  });
};
