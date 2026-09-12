'use strict';

// api/_lib/telegram-send-retry.js
//
// Shared bounded-retry + send-failure-log contract for Telegram approval
// cards across group_posts and social_posts.
//
// THE GAP THIS CLOSES (Carter, 2026-09-12): a draft whose approval-card send
// failed (or was simply never attempted -- a crashed run, a transient
// network error) was left at status='draft', telegram_sent_at=null forever.
// Nothing re-attempted it. Confirmed 3 real stranded group_posts rows
// (pipeline='listing-groups': Windcrest, Hill Country BST, Buy Buy Boerne)
// sitting since 2026-09-11 with zero retry attempts logged anywhere.
//
// CONTRACT for any pipeline wiring this in:
//   1. Select candidate rows with telegram_sent_at IS NULL AND
//      telegram_send_attempts < MAX_ATTEMPTS AND created_at older than
//      RETRY_AFTER_MINUTES.
//   2. Call recordAttempt() after EVERY send attempt (success or failure) --
//      this both logs to telegram_send_log (so a failure can be diagnosed
//      from what Telegram actually returned, not guessed) and increments
//      the row's telegram_send_attempts counter.
//   3. On success (and not suppressed), stamp telegram_sent_at +
//      telegram_message_id as before -- unchanged from existing behavior.
//   4. On the attempt that reaches MAX_ATTEMPTS, call alertFinalFailure()
//      to push a NAMED, loud alert to Heath ("could not deliver X for
//      approval") instead of retrying forever. This alert bypasses the
//      normal per-pipeline keyboard-building code entirely (it's plain
//      text, no callback buttons) so it can't itself get stuck the same
//      way, and it goes out even if TELEGRAM_CRON_NOTIFICATIONS would
//      otherwise gate it (approval-delivery failure is an outage-class
//      alert, not digest noise -- same doctrine as the ALWAYS_ALLOW list
//      in telegram-gate.js).
//
// Owner: Carter, 2026-09-12

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MINUTES = 30;

function olderThanCutoffIso() {
  return new Date(Date.now() - RETRY_AFTER_MINUTES * 60 * 1000).toISOString();
}

/**
 * Log one send attempt to telegram_send_log and bump the row's own
 * telegram_send_attempts/telegram_last_error/telegram_last_attempt_at.
 * Never throws -- a logging failure must not block the actual retry logic.
 */
async function recordAttempt(sbFetch, { table, rowId, identifier, attemptNumber, sendRes, suppressed }) {
  const ok = !!(sendRes && sendRes.ok);
  const errorText = ok ? null : summarizeError(sendRes);

  try {
    await sbFetch('/rest/v1/telegram_send_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        table_name: table,
        row_id: rowId,
        identifier: identifier || null,
        attempt_number: attemptNumber,
        ok,
        suppressed: !!suppressed,
        http_status: (sendRes && sendRes.status) || null,
        telegram_response: (sendRes && sendRes.data) || null,
        error: errorText,
      }),
    });
  } catch (err) {
    console.error('[telegram-send-retry] telegram_send_log insert failed (non-fatal):', err && err.message);
  }

  try {
    await sbFetch(`/rest/v1/${table}?id=eq.${encodeURIComponent(rowId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        telegram_send_attempts: attemptNumber,
        telegram_last_attempt_at: new Date().toISOString(),
        telegram_last_error: errorText,
      }),
    });
  } catch (err) {
    console.error(`[telegram-send-retry] failed to stamp attempt counter on ${table}.${rowId} (non-fatal):`, err && err.message);
  }

  return { ok, errorText };
}

function summarizeError(sendRes) {
  if (!sendRes) return 'no_response';
  if (sendRes.reason) return String(sendRes.reason).slice(0, 500);
  const d = sendRes.data;
  if (d && d.description) return String(d.description).slice(0, 500);
  if (sendRes.status) return `http_${sendRes.status}`;
  return 'unknown_send_failure';
}

/**
 * Final-failure alert -- plain text, no keyboard, bypasses telegram-gate's
 * normal suppression the same way the outage-class ALWAYS_ALLOW jobs do,
 * since a silently-undelivered approval request IS the outage.
 */
async function alertFinalFailure({ telegramToken, telegramChatId, label, groupOrPlatform, lastError }) {
  if (!telegramToken || !telegramChatId) {
    console.error('[telegram-send-retry] cannot alert final failure -- Telegram env missing:', label);
    return { ok: false, reason: 'telegram_env_missing' };
  }
  const text = `TELEGRAM DELIVERY FAILED (3/3 attempts)\n${label}\nVenue/platform: ${groupOrPlatform}\nLast error: ${lastError || 'unknown'}\n\nThis draft could not be sent for your approval. Check telegram_send_log for the full response, then resend manually or clear telegram_send_attempts to retry.`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramChatId, text, disable_web_page_preview: true }),
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    return { ok: res.ok && data?.ok === true, data };
  } catch (err) {
    console.error('[telegram-send-retry] final-failure alert itself failed to send:', err && err.message);
    return { ok: false, reason: err && err.message };
  }
}

module.exports = {
  MAX_ATTEMPTS,
  RETRY_AFTER_MINUTES,
  olderThanCutoffIso,
  recordAttempt,
  alertFinalFailure,
  summarizeError,
};
