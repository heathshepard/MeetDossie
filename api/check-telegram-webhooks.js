// Vercel Serverless Function: /api/check-telegram-webhooks
// Check webhook configuration for both Telegram bots
//
// GET /api/check-telegram-webhooks
// Returns: { ok: true, claudy: {...}, marketing: {...} }

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;

async function getWebhookInfo(token, name) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await res.json();
    return {
      name,
      ok: res.ok && data.ok,
      configured: !!token,
      webhookInfo: data.result || null
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

  const claudy = await getWebhookInfo(TELEGRAM_BOT_TOKEN, 'Claudy');
  const marketing = await getWebhookInfo(TELEGRAM_MARKETING_BOT_TOKEN, 'DossieMarketingBot');

  return res.status(200).json({
    ok: true,
    timestamp: new Date().toISOString(),
    bots: {
      claudy,
      marketing
    }
  });
};
