// Check Telegram webhook registration status
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async function handler(req, res) {
  const effectiveToken = TELEGRAM_MARKETING_BOT_TOKEN || TELEGRAM_BOT_TOKEN;

  if (!effectiveToken) {
    return res.status(500).json({ error: 'No bot token configured' });
  }

  try {
    const url = `https://api.telegram.org/bot${effectiveToken}/getWebhookInfo`;
    const response = await fetch(url);
    const data = await response.json();

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      webhookInfo: data,
      usingToken: TELEGRAM_MARKETING_BOT_TOKEN ? 'TELEGRAM_MARKETING_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN'
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      stack: err.stack
    });
  }
};
