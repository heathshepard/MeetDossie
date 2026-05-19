// One-time endpoint to set DossieAssistant_bot webhook
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  // Temporarily skip auth for one-time setup
  // const authHeader = req.headers.authorization;
  // if (authHeader !== `Bearer ${CRON_SECRET}`) {
  //   return res.status(401).json({ error: 'Unauthorized' });
  // }

  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  }

  try {
    const webhookUrl = 'https://meetdossie.com/api/assistant-webhook';
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message']
      })
    });

    const data = await response.json();

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      botToken: TELEGRAM_BOT_TOKEN.substring(0, 10) + '...',
      webhookUrl,
      result: data
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      stack: err.stack
    });
  }
};
