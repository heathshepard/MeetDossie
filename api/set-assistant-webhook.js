// Registers the DossieAssistant_bot (a.k.a. Claudy) webhook.
//
// TELEGRAM_BOT_TOKEN is @DossieAssistant_bot. It points at /api/claudy-webhook,
// which is the real handler (video/voice transcription + DONE passthrough).
// It deliberately does NOT point at /api/assistant-webhook — that file is only
// the read-only /status /members /health status bot — and it must never point
// at /api/telegram-webhook, which replies using TELEGRAM_MARKETING_BOT_TOKEN
// and would answer as the wrong bot.
//
// allowed_updates MUST include callback_query. Registering with ['message']
// alone silently kills every inline button and caused a week-long outage.
//
// A Telegram bot can hold exactly one webhook, so this endpoint is the single
// owner of TELEGRAM_BOT_TOKEN's registration. Note this puts the bot in webhook
// mode, which is mutually exclusive with getUpdates polling — running
// /api/delete-claudy-webhook reverts it to polling.
//
// POST /api/set-assistant-webhook
// Headers: Authorization: Bearer ${CRON_SECRET}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const CRON_SECRET = process.env.CRON_SECRET;

const WEBHOOK_URL = 'https://meetdossie.com/api/claudy-webhook';
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query'];

module.exports = async function handler(req, res) {
  // Auth restored 2026-06-10 (Atlas) — previously commented out.
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set' });
  }

  try {
    const payload = {
      url: WEBHOOK_URL,
      allowed_updates: ALLOWED_UPDATES,
    };
    // claudy-webhook.js checks X-Telegram-Bot-Api-Secret-Token when this is set.
    // Telegram only accepts 1-256 chars of A-Z a-z 0-9 _ - for secret_token and
    // rejects the whole setWebhook call with 400 otherwise. The current
    // TELEGRAM_WEBHOOK_SECRET does NOT satisfy that, so validate before sending
    // rather than letting one bad character take the registration down.
    const secretUsable =
      typeof TELEGRAM_WEBHOOK_SECRET === 'string' &&
      /^[A-Za-z0-9_-]{1,256}$/.test(TELEGRAM_WEBHOOK_SECRET);
    if (secretUsable) payload.secret_token = TELEGRAM_WEBHOOK_SECRET;

    const setRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const setData = await setRes.json();

    // Read back the live registration so the caller sees actual state, not just
    // what we asked for. Never echo any part of the bot token.
    let info = null;
    try {
      const infoRes = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`
      );
      const infoData = await infoRes.json();
      const r = (infoData && infoData.result) || {};
      info = {
        url: r.url,
        allowed_updates: r.allowed_updates,
        pending_update_count: r.pending_update_count,
        last_error_message: r.last_error_message || null,
      };
    } catch (_) {
      // verification is best-effort; the setWebhook result above is definitive
    }

    const callbackQueryEnabled = Boolean(
      info && Array.isArray(info.allowed_updates)
        && info.allowed_updates.includes('callback_query')
    );

    return res.status(200).json({
      ok: Boolean(setData && setData.ok),
      timestamp: new Date().toISOString(),
      webhookUrl: WEBHOOK_URL,
      secretTokenSent: secretUsable,
      secretTokenSkippedReason:
        !TELEGRAM_WEBHOOK_SECRET
          ? 'TELEGRAM_WEBHOOK_SECRET not set'
          : secretUsable
            ? null
            : 'TELEGRAM_WEBHOOK_SECRET has characters Telegram disallows (A-Za-z0-9_- only)',
      callbackQueryEnabled,
      result: setData,
      verified: info,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
