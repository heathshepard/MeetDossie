'use strict';

// api/_lib/telegram-webhook-health.js
//
// Consumed by api/_lib/silence-alarm.js's runAllChecks() — same daily
// heartbeat cron, same alert_state dedup, same Telegram path as every other
// silent-failure detector (see api/cron-silence-alarm.js). No new
// standalone Vercel cron needed. Pattern mirrors
// api/_lib/google-token-health.js: self-heal first, alert only on what the
// self-heal could not fix.
//
// THE INCIDENT THIS CLOSES (2026-10-02): Heath tapped Approve on two
// group_posts drafts in the DossieMarketingBot card and nothing happened —
// no row flip, no error, no edited message, nothing. Root cause:
// getWebhookInfo for TELEGRAM_MARKETING_BOT_TOKEN showed url="" — the
// webhook was unregistered, so Telegram had no delivery target for the
// callback_query at all. The tap never reached api/telegram-webhook.js;
// the handler code (api/group5-post-callback.js) was never at fault — it
// already answers every callback with a real success or a real error
// (fixed 2026-09-11, see that file's header). Nothing before this module
// ever checked whether the webhook registration itself was still in place,
// so it could silently drop out at any time (token rotation, a manual
// deleteWebhook call, a Telegram-side reset) with zero signal until Heath
// noticed a tap did nothing — exactly the failure class this repo's
// silence-alarm infra exists to close.
//
// SCOPE: only DossieMarketingBot (TELEGRAM_MARKETING_BOT_TOKEN). This
// deliberately does NOT touch DossieAssistant_bot (TELEGRAM_BOT_TOKEN) —
// that registration is owned solely by api/set-assistant-webhook.js per
// api/reset-telegram-webhook.js's own header (a 2026-xx landmine: resetting
// both bots to the same URL under the marketing token made every
// DossieAssistant_bot reply go out as the wrong bot). Same rule here.
//
// SECURITY: never surface TELEGRAM_WEBHOOK_SECRET or
// TELEGRAM_MARKETING_BOT_TOKEN values — this repo is public and these
// conditions can end up in a Telegram message. Only the webhook URL (not
// secret), error codes, and timestamps are safe to surface.
//
// Owner: Atlas, 2026-10-02.

const EXPECTED_URL = 'https://meetdossie.com/api/telegram-webhook';
const EXPECTED_ALLOWED_UPDATES = ['message', 'callback_query'];
// A webhook can be correctly registered but still actively failing (our
// endpoint 5xx-ing, DNS issue, etc). Only alert on a recent last_error —
// an old one from a prior incident that has since resolved itself (url now
// matches, no new errors) is not actionable.
const RECENT_ERROR_WINDOW_MINUTES = 30;

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function getWebhookInfo(token, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const data = await res.json();
  if (!res.ok || !data || data.ok !== true) {
    const err = new Error(`getWebhookInfo failed: HTTP ${res.status} — ${data && data.description}`);
    err.telegramResponse = data;
    throw err;
  }
  return data.result;
}

async function setWebhook(token, fetchImpl, secret) {
  const f = fetchImpl || fetch;
  const body = {
    url: EXPECTED_URL,
    allowed_updates: EXPECTED_ALLOWED_UPDATES,
  };
  const secretUsable = typeof secret === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(secret);
  if (secretUsable) body.secret_token = secret;

  const res = await f(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok && data && data.ok === true, telegramResponse: data };
}

/**
 * Returns [] when healthy (including self-healed this run), or
 * [{ key, message, ... }] describing exactly one failure the self-heal
 * could not fix — same contract as checkGoogleTokenHealth().
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable for tests; defaults to global fetch
 * @param {object} [opts.env] - injectable env override for tests
 */
async function checkTelegramWebhookHealth(opts = {}) {
  const env = opts.env || process.env;
  const token = env.TELEGRAM_MARKETING_BOT_TOKEN;

  if (!token) {
    return [{
      key: 'telegram_marketing_webhook_misconfigured',
      message: 'TELEGRAM_MARKETING_BOT_TOKEN is not set — cannot check or repair the '
        + 'DossieMarketingBot webhook registration. Approve/Reject/Skip taps on group posts '
        + 'and social posts cannot be received at all while this is unset.',
    }];
  }

  let info;
  try {
    info = await getWebhookInfo(token, opts.fetchImpl);
  } catch (err) {
    return [{
      key: 'telegram_marketing_webhook_check_failed',
      message: `Could not reach Telegram's getWebhookInfo for DossieMarketingBot: ${err.message}. `
        + 'Cannot verify whether Approve/Reject taps can be delivered this run.',
    }];
  }

  const urlMatches = info.url === EXPECTED_URL;
  const updatesMatch = arraysEqual(info.allowed_updates, EXPECTED_ALLOWED_UPDATES);

  if (!urlMatches || !updatesMatch) {
    // Self-heal: this is exactly what api/reset-telegram-webhook.js does on
    // manual trigger — calling it here automatically closes the gap instead
    // of waiting for Heath to notice a tap did nothing and ask someone to
    // investigate (Heath, standing instruction: auto-fix bugs, don't ask).
    const fix = await setWebhook(token, opts.fetchImpl, env.TELEGRAM_WEBHOOK_SECRET);
    if (fix.ok) {
      return [];
    }
    return [{
      key: 'telegram_marketing_webhook_unregistered',
      message: `DossieMarketingBot's webhook was ${info.url ? `pointed at the wrong URL (${info.url})` : 'NOT REGISTERED (url empty)'} `
        + `— Approve/Reject/Skip taps cannot reach our server. Automated re-registration to ${EXPECTED_URL} FAILED: `
        + `${JSON.stringify(fix.telegramResponse && fix.telegramResponse.description)}. `
        + 'Manual fix: GET /api/reset-telegram-webhook with Authorization: Bearer $CRON_SECRET.',
    }];
  }

  // Registered correctly — but check for an actively-failing delivery
  // (our endpoint erroring on Telegram's attempts), which re-registering
  // would not fix.
  if (info.last_error_date) {
    const errorAgeMinutes = (Date.now() / 1000 - info.last_error_date) / 60;
    if (errorAgeMinutes <= RECENT_ERROR_WINDOW_MINUTES) {
      return [{
        key: 'telegram_marketing_webhook_delivery_failing',
        message: `DossieMarketingBot's webhook is registered at the right URL but Telegram's last delivery `
          + `attempt failed ${Math.round(errorAgeMinutes)}m ago: "${info.last_error_message}". `
          + `pending_update_count=${info.pending_update_count}. Our endpoint is reachable but erroring on real `
          + 'updates — check Vercel function logs for api/telegram-webhook.js.',
      }];
    }
  }

  return [];
}

module.exports = { checkTelegramWebhookHealth, EXPECTED_URL, EXPECTED_ALLOWED_UPDATES };
