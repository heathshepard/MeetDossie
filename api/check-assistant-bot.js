// Check DossieAssistant_bot configuration
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)
// Previously public — leaked first 10 chars of bot tokens AND webhook URLs
// that include the full bot token after the `/bot` segment.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // NOT the marketing one
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const diagnostics = {
    timestamp: new Date().toISOString(),
    tokens: {
      TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN ? `set (${TELEGRAM_BOT_TOKEN.substring(0, 10)}...)` : 'NOT SET',
      TELEGRAM_MARKETING_BOT_TOKEN: TELEGRAM_MARKETING_BOT_TOKEN ? `set (${TELEGRAM_MARKETING_BOT_TOKEN.substring(0, 10)}...)` : 'NOT SET',
      different: TELEGRAM_BOT_TOKEN !== TELEGRAM_MARKETING_BOT_TOKEN
    }
  };

  // Check assistant bot webhook
  if (TELEGRAM_BOT_TOKEN) {
    try {
      const webhookUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`;
      const webhookRes = await fetch(webhookUrl);
      const webhookData = await webhookRes.json();
      diagnostics.assistantBot = {
        webhookInfo: webhookData,
      };

      // Get bot info
      const getMeUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`;
      const getMeRes = await fetch(getMeUrl);
      const getMeData = await getMeRes.json();
      diagnostics.assistantBot.botInfo = getMeData;
    } catch (err) {
      diagnostics.assistantBot = { error: err.message };
    }
  }

  // Check marketing bot webhook
  if (TELEGRAM_MARKETING_BOT_TOKEN) {
    try {
      const webhookUrl = `https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/getWebhookInfo`;
      const webhookRes = await fetch(webhookUrl);
      const webhookData = await webhookRes.json();
      diagnostics.marketingBot = {
        webhookInfo: webhookData,
      };

      // Get bot info
      const getMeUrl = `https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/getMe`;
      const getMeRes = await fetch(getMeUrl);
      const getMeData = await getMeRes.json();
      diagnostics.marketingBot.botInfo = getMeData;
    } catch (err) {
      diagnostics.marketingBot = { error: err.message };
    }
  }

  return res.status(200).json(diagnostics);
};
