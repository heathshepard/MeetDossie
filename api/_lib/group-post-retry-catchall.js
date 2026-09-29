'use strict';

// api/_lib/group-post-retry-catchall.js
//
// THE GAP THIS CLOSES (Carter, 2026-09-16, silence-alarm first-firing
// investigation): api/cron-retry-unsent-approvals.js's two retry paths
// (retryPendingNotifications for pipeline='daily5',
// retryPendingListingGroupNotifications for pipeline='listing-groups') only
// ever match those two exact pipeline values. Any group_posts draft row
// whose `pipeline` column is NULL or something else entirely falls outside
// BOTH queries and is retried by nothing, forever. Confirmed live: 10
// group_posts drafts sitting since as far back as 2026-07-09 (Keller
// Williams REALTORs), all with pipeline NULL or not in the two known
// values, telegram_sent_at still null. These predate the pipeline='daily5'/
// 'listing-groups' convention (and, in some cases, predate
// api/_lib/group-post-generator.js's current pending_sage_review flow) --
// grep confirms nothing in the current codebase still BUILDS a
// `group_approve_<id>` keyboard, even though api/telegram-webhook.js still
// PARSES that exact callback shape (routes to
// api/group-post-callback.js's handleGroupPostCallback, which is pipeline-
// agnostic -- works on any group_posts row by id). This file re-sends
// through that still-supported shape rather than resurrecting dead
// generator code.
//
// Scope: only rows NOT already covered by the two named-pipeline retries
// (the cron calls all three every run; this one explicitly excludes
// pipeline IN ('daily5','listing-groups') so nothing double-sends).
//
// Same bounded-attempt + log + final-alert contract as its two siblings --
// see api/_lib/telegram-send-retry.js.
//
// Owner: Carter, 2026-09-16

const KNOWN_PIPELINES = new Set(['daily5', 'listing-groups']);

function makeSupabaseFetch(url, key) {
  return async function supabaseFetch(urlPath, init = {}) {
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers || {}),
    };
    const res = await fetch(`${url}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  };
}

function legacyKeyboard(rowId) {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `group_approve_${rowId}` },
      { text: 'Reject', callback_data: `group_reject_${rowId}` },
    ]],
  };
}

function buildMessage(row) {
  return [
    `GROUP POST DRAFT (retry) — ${row.group_name}`,
    row.category ? `Category: ${row.category}` : null,
    '',
    row.post_body,
  ].filter((l) => l !== null).join('\n').slice(0, 4090);
}

async function defaultTelegramSend(token, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data, raw };
}

async function retryPendingLegacyGroupPostNotifications(opts) {
  const { telegramToken, telegramChatId, log = console.log, now = () => new Date() } = opts;
  const sbFetch = opts.sbFetch || makeSupabaseFetch(opts.supabaseUrl, opts.supabaseKey);
  const send = opts.send || ((text, kb) => defaultTelegramSend(telegramToken, telegramChatId, text, kb));
  const { wasSuppressed } = require('./telegram-gate');
  const { MAX_ATTEMPTS, RETRY_AFTER_MINUTES, recordAttempt, alertFinalFailure, summarizeError } = require('./telegram-send-retry');

  const cutoff = new Date(Date.now() - RETRY_AFTER_MINUTES * 60 * 1000).toISOString();
  const { ok, data } = await sbFetch(
    '/rest/v1/group_posts?status=eq.draft&telegram_sent_at=is.null'
    + `&telegram_send_attempts=lt.${MAX_ATTEMPTS}&created_at=lt.${encodeURIComponent(cutoff)}`
    + '&select=id,group_name,category,post_body,pipeline,telegram_send_attempts',
  );
  if (!ok || !Array.isArray(data)) return { retried: 0, notified: 0 };

  // Only rows NOT already owned by the two named-pipeline retries above --
  // this function is the catch-all for everything else (NULL pipeline,
  // future pipeline values nobody's wired a specific retry for yet).
  const rows = data.filter((row) => !KNOWN_PIPELINES.has(row.pipeline));

  let notified = 0;
  for (const row of rows) {
    const sendRes = await send(buildMessage(row), legacyKeyboard(row.id));
    const suppressed = wasSuppressed(sendRes.data);
    const delivered = sendRes.ok && !suppressed;
    const attemptNumber = (row.telegram_send_attempts || 0) + 1;
    await recordAttempt(sbFetch, {
      table: 'group_posts',
      rowId: row.id,
      identifier: `${row.group_name} (pipeline=${row.pipeline || 'null'})`,
      attemptNumber,
      sendRes,
      suppressed,
    });

    if (delivered) {
      const nowIso = now().toISOString();
      await sbFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          telegram_sent_at: nowIso,
          telegram_message_id: sendRes.data?.result?.message_id != null ? String(sendRes.data.result.message_id) : null,
        }),
      });
      notified++;
    } else {
      log(`[group-post-retry-catchall] Retry send still failing for post ${row.id} (${row.group_name}), attempt ${attemptNumber}/${MAX_ATTEMPTS}`);
      if (attemptNumber >= MAX_ATTEMPTS) {
        await alertFinalFailure({
          telegramToken,
          telegramChatId,
          label: `legacy group post could not be delivered for approval: "${(row.post_body || '').slice(0, 80)}..."`,
          groupOrPlatform: row.group_name,
          lastError: suppressed ? 'suppressed by telegram-gate (TELEGRAM_CRON_NOTIFICATIONS)' : summarizeError(sendRes),
        });
      }
    }
  }
  return { retried: rows.length, notified };
}

module.exports = { retryPendingLegacyGroupPostNotifications, KNOWN_PIPELINES };
