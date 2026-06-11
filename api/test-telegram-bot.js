// Vercel Serverless Function: /api/test-telegram-bot
// Test that DossieMarketingBot can send messages
//
// GET /api/test-telegram-bot
// Returns: { ok: true, message: {...} }

const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Auth added 2026-06-10 (Atlas) — endpoint sends Telegram messages.
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!TELEGRAM_MARKETING_BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_MARKETING_BOT_TOKEN not configured' });
  }

  if (!TELEGRAM_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_CHAT_ID not configured' });
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: '✅ DossieMarketingBot webhook test successful\n\nTimestamp: ' + new Date().toISOString()
      })
    });
    const data = await response.json();

    return res.status(200).json({
      ok: response.ok && data.ok,
      tokenConfigured: !!TELEGRAM_MARKETING_BOT_TOKEN,
      chatIdConfigured: !!TELEGRAM_CHAT_ID,
      result: data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
