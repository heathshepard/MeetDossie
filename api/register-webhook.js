// API endpoint to register DossieMarketingBot webhook with Telegram
// GET /api/register-webhook?secret=CRON_SECRET

const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  // Auth check
  const secret = req.query.secret;
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!TELEGRAM_MARKETING_BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_MARKETING_BOT_TOKEN not configured' });
  }

  const webhookUrl = 'https://meetdossie.com/api/telegram-webhook';

  try {
    // Register webhook
    const url = `https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/setWebhook`;
    const params = new URLSearchParams({
      url: webhookUrl,
    });

    if (TELEGRAM_WEBHOOK_SECRET) {
      params.append('secret_token', TELEGRAM_WEBHOOK_SECRET);
    }

    const response = await fetch(url, {
      method: 'POST',
      body: params,
    });

    const data = await response.json();

    if (!data.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Webhook registration failed',
        telegram_response: data,
      });
    }

    // Verify registration
    const verifyUrl = `https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/getWebhookInfo`;
    const verifyResponse = await fetch(verifyUrl);
    const verifyData = await verifyResponse.json();

    return res.status(200).json({
      ok: true,
      message: 'Webhook registered successfully',
      webhook_url: webhookUrl,
      webhook_info: verifyData.result,
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
