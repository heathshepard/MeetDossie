// Test if bot can send messages directly
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ error: 'No bot token' });
  }

  try {
    // Try to send a simple message
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: '🔧 Test message from diagnostic endpoint'
      })
    });

    const data = await response.json();

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      botToken: TELEGRAM_BOT_TOKEN ? `${TELEGRAM_BOT_TOKEN.substring(0, 10)}...` : 'not set',
      chatId: TELEGRAM_CHAT_ID,
      apiResponse: data,
      httpStatus: response.status,
      success: data.ok === true
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message,
      stack: err.stack
    });
  }
};
