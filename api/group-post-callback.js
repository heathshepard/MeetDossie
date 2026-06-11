'use strict';

// api/group-post-callback.js
//
// Vercel serverless function — handles DossieMarketingBot inline keyboard
// callbacks for group_posts approval flow.
//
// Actions: group_approve, group_reject, group_skip
//
// This function is NOT a Telegram webhook endpoint on its own. It is called
// from telegram-webhook.js which already handles all DossieMarketingBot
// callbacks. This module exports a single handler function that
// telegram-webhook.js calls when it detects a group_ prefixed callback.
//
// On approve: updates status='approved', sends Heath the exact node command
//             to run fb-group-poster.js (Playwright can't run in Vercel).
// On reject:  updates status='rejected'.
// On skip:    updates status='skipped'.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function tgCall(method, body) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, data };
}

async function answerCallback(callbackQueryId, text) {
  return tgCall('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || '',
    show_alert: false,
  });
}

async function editMessage(chatId, messageId, text) {
  return tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendPersonalNotification(text) {
  if (!TELEGRAM_CHAT_ID || !TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  }).catch((err) => {
    console.warn('[group-post-callback] personal notification failed:', err.message);
  });
}

async function fetchGroupPost(postId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function patchGroupPost(postId, patch) {
  return supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// handleGroupPostCallback is exported so telegram-webhook.js can call it.
// Parameters match the pattern used in that file's callback handler.
async function handleGroupPostCallback(action, postId, callbackQueryId, chatId, messageId, originalMessageText) {
  const post = await fetchGroupPost(postId);

  if (!post) {
    if (callbackQueryId) await answerCallback(callbackQueryId, 'Post not found');
    return;
  }

  const now = new Date().toISOString();
  const originalBody = originalMessageText || '';

  if (action === 'group_approve') {
    // Validator: first_comment_body must mention Dossie or meetdossie if it exists
    if (post.first_comment_body && !post.first_comment_body.includes('Dossie') && !post.first_comment_body.includes('meetdossie')) {
      const errorMsg = `Post ${postId} approval BLOCKED: first_comment_body does not mention Dossie.\n\nComment:\n"${post.first_comment_body}"`;

      if (chatId && messageId) {
        await editMessage(chatId, messageId, `${originalBody}\n\nREJECTED: first_comment_body must mention "Dossie".`);
      }

      if (callbackQueryId) {
        await answerCallback(callbackQueryId, 'Error: first comment must mention Dossie');
      }

      await sendPersonalNotification(errorMsg);
      console.log(`[group-post-callback] ${errorMsg}`);
      return;
    }

    await patchGroupPost(postId, {
      status: 'approved',
      approved_at: now,
      auto_post_at: now,
    });

    // Edit the approval message to show it's approved and queued
    if (chatId && messageId) {
      const updatedText = [
        originalBody,
        '',
        '✅ Approved — queued for auto-post via DossieBot.',
        'You\'ll see ✅ POSTED when it lands.',
      ].join('\n').slice(0, 4096);

      await editMessage(chatId, messageId, updatedText);
    }

    if (callbackQueryId) await answerCallback(callbackQueryId, 'Approved');
    console.log(`[group-post-callback] Approved post ${postId} for "${post.group_name}" — queued for autonomous posting`);
    return;
  }

  if (action === 'group_reject') {
    await patchGroupPost(postId, { status: 'rejected' });

    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nRejected.`);
    }

    if (callbackQueryId) await answerCallback(callbackQueryId, 'Rejected');
    console.log(`[group-post-callback] Rejected post ${postId} for "${post.group_name}"`);
    return;
  }

  if (action === 'group_skip') {
    await patchGroupPost(postId, { status: 'skipped' });

    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nSkipped.`);
    }

    if (callbackQueryId) await answerCallback(callbackQueryId, 'Skipped');
    console.log(`[group-post-callback] Skipped post ${postId} for "${post.group_name}"`);
    return;
  }

  if (callbackQueryId) await answerCallback(callbackQueryId, 'Unknown action');
}

module.exports = { handleGroupPostCallback };
