// Vercel Serverless Function: /api/cron-elevenlabs-monitor
// Checks ElevenLabs credit balance and sends a Telegram alert when low.
//   - CRITICAL: < 3,000 credits remaining
//   - WARNING:  < 8,000 credits remaining
//   - OK:       no alert
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 14 * * * (2:00 PM UTC daily, ~9am CDT)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const CRON_SECRET = process.env.CRON_SECRET;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = '7874782923';

module.exports = withTelemetry('cron-elevenlabs-monitor', async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const subRes = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY }
  });

  if (!subRes.ok) {
    const text = await subRes.text();
    return res.status(502).json({ error: 'ElevenLabs API error', status: subRes.status, body: text });
  }

  const data = await subRes.json();
  const used = data.character_count ?? 0;
  const limit = data.character_limit ?? 0;
  const remaining = limit - used;
  const pctLeft = limit > 0 ? Math.round((remaining / limit) * 100) : 0;

  let message = null;

  if (remaining < 3000) {
    message = `ElevenLabs CRITICAL: Only ${remaining} credits left (${limit} monthly cap). Voice generation will fail. Top up at elevenlabs.io`;
  } else if (remaining < 8000) {
    message = `ElevenLabs LOW: ${remaining} credits remaining this month (${pctLeft}% left). Consider topping up at elevenlabs.io`;
  }

  if (!message) {
    return res.status(200).json({ ok: true, remaining, pctLeft, alert: 'none' });
  }

  const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    })
  });

  const tgData = await tgRes.json();

  return res.status(200).json({
    ok: true,
    remaining,
    pctLeft,
    alert: remaining < 3000 ? 'critical' : 'warning',
    telegram: tgData.ok
  });
})
