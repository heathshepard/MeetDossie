// Register DossieMarketingBot webhook with Telegram
// Usage: node scripts/register-marketing-webhook.js

const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!TELEGRAM_MARKETING_BOT_TOKEN) {
  console.error('TELEGRAM_MARKETING_BOT_TOKEN not set');
  process.exit(1);
}

const webhookUrl = 'https://meetdossie.com/api/telegram-webhook';

async function registerWebhook() {
  const url = `https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/setWebhook`;
  const params = new URLSearchParams({
    url: webhookUrl,
  });

  if (TELEGRAM_WEBHOOK_SECRET) {
    params.append('secret_token', TELEGRAM_WEBHOOK_SECRET);
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: params,
    });

    const data = await response.json();
    console.log('Webhook registration response:', JSON.stringify(data, null, 2));

    if (data.ok) {
      console.log('✅ Webhook registered successfully');
      console.log('   URL:', webhookUrl);
    } else {
      console.error('❌ Webhook registration failed:', data.description);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error registering webhook:', error.message);
    process.exit(1);
  }

  // Verify registration
  try {
    const verifyUrl = `https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/getWebhookInfo`;
    const response = await fetch(verifyUrl);
    const data = await response.json();

    console.log('\nWebhook info:');
    console.log('  URL:', data.result.url);
    console.log('  Has custom cert:', data.result.has_custom_certificate);
    console.log('  Pending update count:', data.result.pending_update_count);
    if (data.result.last_error_message) {
      console.log('  Last error:', data.result.last_error_message);
      console.log('  Last error date:', new Date(data.result.last_error_date * 1000).toISOString());
    }
  } catch (error) {
    console.error('Error verifying webhook:', error.message);
  }
}

registerWebhook();
