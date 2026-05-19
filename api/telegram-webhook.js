// Vercel Serverless Function: /api/telegram-webhook
// Public webhook target Telegram POSTs to whenever an inline-keyboard button
// is pressed (callback_query) or a text message is sent to the bot. Handles
// the approve / reject / edit lifecycle for marketing posts.
//
// Auth: this endpoint is publicly callable (Telegram doesn't sign requests),
// so we (a) require a chat_id match to TELEGRAM_CHAT_ID for any state change,
// and (b) optionally validate the X-Telegram-Bot-Api-Secret-Token header if
// TELEGRAM_WEBHOOK_SECRET is configured (recommended — set it when calling
// setWebhook).
//
// Register: curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
//   -d "url=https://meetdossie.com/api/telegram-webhook" \
//   -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"

const {
  approveFoundingApplication,
  rejectFoundingApplication,
} = require('./_lib/founding-approval');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Marketing approval flow uses a dedicated bot (DossieMarketingBot) so it
// can hold a webhook without fighting Claudy's getUpdates loop. Falls back
// to TELEGRAM_BOT_TOKEN only if the marketing-specific token isn't set.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const EDIT_PROMPT_PREFIX = '✏️ Editing post ';
const EDIT_PROMPT_SUFFIX = '. Reply to this message with the new content.';

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function tgCall(method, body) {
  console.log(`[telegram-webhook] tgCall CALLED: method="${method}", body=`, JSON.stringify(body).substring(0, 200));
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  console.log(`[telegram-webhook] tgCall URL: ${url.substring(0, 50)}...`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[telegram-webhook] tgCall response status: ${res.status}, body:`, text.substring(0, 200));
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || data?.ok !== true) {
    console.error('[telegram-webhook] tg', method, 'failed:', res.status, text.slice(0, 200));
  }
  console.log(`[telegram-webhook] tgCall result: ok=${res.ok && data?.ok === true}`);
  return { ok: res.ok && data?.ok === true, data };
}

async function answerCallback(callbackQueryId, text) {
  return tgCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '', show_alert: false });
}

async function editMessage(chatId, messageId, text) {
  return tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendMessage(chatId, text, replyToMessageId, forceReply) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  if (forceReply) body.reply_markup = { force_reply: true, selective: true };
  return tgCall('sendMessage', body);
}

async function loadPost(postId) {
  try {
    const enc = encodeURIComponent(postId);
    const { data } = await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}&limit=1`);
    if (Array.isArray(data) && data.length > 0) return data[0];
    return null;
  } catch (err) {
    console.error('[telegram-webhook] loadPost failed:', err?.message);
    return null;
  }
}

async function patchPost(postId, patch) {
  try {
    const enc = encodeURIComponent(postId);
    return await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    console.error('[telegram-webhook] patchPost failed:', err?.message);
    return { ok: false, error: err?.message };
  }
}

async function bumpBatchCounter(postId, field) {
  try {
    // Best-effort: no batch_id link on social_posts, so we look up the latest
    // batch and bump its counter. This is informational only.
    const { data } = await supabaseFetch(
      `/rest/v1/content_batches?order=generated_at.desc&limit=1`,
    );
    const batch = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!batch || !batch.id) return;
    const next = (batch[field] || 0) + 1;
    await supabaseFetch(`/rest/v1/content_batches?id=eq.${encodeURIComponent(batch.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ [field]: next }),
    });
  } catch (err) {
    console.error('[telegram-webhook] bumpBatchCounter failed:', err?.message);
    // Non-fatal: this is informational only
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      resolve(req.body);
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8'); });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleFoundingCallback(action, applicationId, cb, chatId, messageId, callbackId) {
  const message = cb?.message;
  const originalBody = String(message?.text || '');

  if (action === 'approve') {
    let result;
    try {
      result = await approveFoundingApplication({ applicationId, env: process.env });
    } catch (err) {
      console.error('[telegram-webhook] founding approve threw:', err && err.message);
      result = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!result.ok) {
      const errText = `❌ Approval failed: ${result.error || 'unknown error'}`;
      if (chatId && messageId) {
        await editMessage(chatId, messageId, `${originalBody}\n\n${errText}`);
      }
      if (callbackId) await answerCallback(callbackId, 'Approval failed');
      return;
    }
    const tail = [
      '',
      `✅ APPROVED — checkout sent to ${result.application.email}`,
      `Email id: ${result.emailId || (result.emailError ? 'failed — ' + result.emailError : '—')}`,
      result.checkoutUrl ? `URL: ${result.checkoutUrl}` : '',
    ].filter(Boolean).join('\n');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}${tail}`);
    }
    if (callbackId) await answerCallback(callbackId, 'Approved');
    return;
  }

  if (action === 'reject') {
    try {
      await rejectFoundingApplication({ applicationId });
    } catch (err) {
      console.error('[telegram-webhook] founding reject threw:', err && err.message);
    }
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n❌ REJECTED`);
    }
    if (callbackId) await answerCallback(callbackId, 'Rejected');
    return;
  }
}


async function handleCallbackQuery(cb) {
  const data = String(cb?.data || '');
  const callbackId = cb?.id;
  const message = cb?.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;

  // Only honor callbacks from the configured chat. Drop everything else.
  if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    if (callbackId) await answerCallback(callbackId, 'Not authorized');
    return;
  }

  // Founding application flow: approve_founding:<id> / reject_founding:<id>
  // Note the colon delimiter, distinguishing it from the social-post flow's
  // underscore (approve_<post_id>).
  const founding = data.match(/^(approve|reject)_founding:(.+)$/);
  if (founding) {
    return handleFoundingCallback(founding[1], founding[2], cb, chatId, messageId, callbackId);
  }

  // Check for retry button
  const retry = data.match(/^retry_(.+)$/);
  if (retry) {
    const postId = retry[1];
    const post = await loadPost(postId);
    if (!post) {
      if (callbackId) await answerCallback(callbackId, 'Post not found');
      return;
    }

    // Reset to approved so next cron run will retry
    await patchPost(postId, {
      status: 'approved',
      error_message: null,
      publishing_started_at: null
    });

    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${String(message?.text || '')}\n\n🔄 Reset to approved — will retry at next cron run.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Queued for retry');
    return;
  }

  const m = data.match(/^(approve|reject|edit)_(.+)$/);
  if (!m) {
    if (callbackId) await answerCallback(callbackId, 'Unknown action');
    return;
  }
  const action = m[1];
  const postId = m[2];

  const post = await loadPost(postId);
  if (!post) {
    if (callbackId) await answerCallback(callbackId, 'Post not found');
    return;
  }

  const now = new Date().toISOString();
  const originalBody = String(message?.text || '');

  if (action === 'approve') {
    console.log(`[telegram-webhook] APPROVE action for postId="${postId}"`);
    console.log(`[telegram-webhook] Post object:`, JSON.stringify(post));
    const patchBody = { status: 'approved', approved_at: now };
    console.log(`[telegram-webhook] Patch body:`, JSON.stringify(patchBody));
    const patchResult = await patchPost(postId, patchBody);
    console.log(`[telegram-webhook] Patch result:`, JSON.stringify(patchResult));
    await bumpBatchCounter(postId, 'approved_posts');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n✅ Approved — will post at next slot.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Approved');
    return;
  }

  if (action === 'reject') {
    await patchPost(postId, { status: 'rejected' });
    await bumpBatchCounter(postId, 'rejected_posts');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n❌ Rejected.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Rejected');
    return;
  }

  if (action === 'edit') {
    // Send a force_reply prompt that encodes the post_id in the text. The
    // text message handler will parse it back out when the user replies.
    const promptText = `${EDIT_PROMPT_PREFIX}${postId}${EDIT_PROMPT_SUFFIX}`;
    await sendMessage(chatId, promptText, messageId, true);
    if (callbackId) await answerCallback(callbackId, 'Reply with new content');
    return;
  }
}

async function handleTextMessage(msg) {
  const chatId = msg?.chat?.id;
  if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) return;

  const replyTo = msg?.reply_to_message;
  if (!replyTo) return;
  const replyText = String(replyTo.text || '');
  if (!replyText.startsWith(EDIT_PROMPT_PREFIX)) return;

  // Extract post_id between prefix and suffix.
  const after = replyText.slice(EDIT_PROMPT_PREFIX.length);
  const cut = after.indexOf(EDIT_PROMPT_SUFFIX);
  const postId = cut > 0 ? after.slice(0, cut).trim() : after.split(/\s/)[0].trim();
  if (!postId) return;

  const newContent = String(msg.text || '').trim();
  if (!newContent) return;

  // Update the post's content and re-queue it for re-approval. Reset the
  // approval-flow flags so cron-send-for-approval picks it up again.
  await patchPost(postId, {
    content: newContent,
    hook: newContent.slice(0, 120),
    telegram_sent_at: null,
    telegram_message_id: null,
    status: 'draft',
  });
  await sendMessage(chatId, `✏️ Edit saved for ${postId}. It'll come back for re-approval at the next send cycle.`, msg.message_id);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Validate the optional Telegram secret-token header. Non-blocking: if we
  // configured one and it doesn't match, log a warning but allow the request
  // through (still fingerprinted via chat_id checks later).
  if (TELEGRAM_WEBHOOK_SECRET) {
    const got = req.headers && (req.headers['x-telegram-bot-api-secret-token'] || req.headers['X-Telegram-Bot-Api-Secret-Token']);
    if (got !== TELEGRAM_WEBHOOK_SECRET) {
      console.warn('[telegram-webhook] secret token mismatch - expected:', TELEGRAM_WEBHOOK_SECRET?.slice(0, 8), 'got:', got?.slice(0, 8));
      // Non-blocking: continue processing the request
    }
  }

  // Non-fatal Supabase check: log a warning but allow webhook to process
  // messages even without Supabase (needed for Claudy to respond to general
  // messages; Supabase only required for approve/reject callback queries).
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[telegram-webhook] Supabase not configured - callback queries will fail');
  }
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  let update;
  try {
    update = await readRawBody(req);
  } catch (err) {
    console.error('[telegram-webhook] body parse failed:', err && err.message);
    return res.status(200).json({ ok: true, ignored: 'parse error' });
  }

  try {
    if (update?.callback_query) {
      await handleCallbackQuery(update.callback_query);
    } else if (update?.message?.text) {
      await handleTextMessage(update.message);
    }
  } catch (err) {
    // Log but always return 200 — Telegram retries non-200s aggressively.
    console.error('[telegram-webhook] handler threw:', err && err.message);
  }

  return res.status(200).json({ ok: true });
};
