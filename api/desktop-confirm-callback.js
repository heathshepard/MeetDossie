'use strict';

// api/desktop-confirm-callback.js
//
// Vercel serverless function — handles Claudy inline-keyboard callbacks for
// Cole's desktop-control confirmation flow.
//
// Callbacks: desktop_confirm:<pending_id> / desktop_deny:<pending_id>
//
// Not a standalone Telegram webhook — called from telegram-webhook.js after it
// detects a `desktop_confirm` or `desktop_deny` callback_data prefix.
//
// On confirm: updates desktop_pending_confirmations.status='confirmed'.
//             The Python guard layer polls this row and unblocks.
// On deny:    sets status='denied'. Guard unblocks with DENY result.
//
// Side effect: also writes a row to desktop_actions so the daily summary cron
// can show how many decisions Heath made.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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
  if (!TELEGRAM_BOT_TOKEN) return { ok: false };
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

async function fetchPending(pendingId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/desktop_pending_confirmations?id=eq.${encodeURIComponent(pendingId)}&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function patchPending(pendingId, patch) {
  return supabaseFetch(`/rest/v1/desktop_pending_confirmations?id=eq.${encodeURIComponent(pendingId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function logDecision(pending, decision) {
  // Audit-trail row so daily summary can count confirms / denies.
  return supabaseFetch('/rest/v1/desktop_actions', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      action_type: `confirmation_${decision}`,
      target: pending.question ? pending.question.slice(0, 200) : null,
      screenshot_before_url: pending.screenshot_url || null,
      requested_by: 'cole',
      approved_by: decision === 'confirmed' ? 'heath' : null,
      result: decision,
    }),
  });
}

// handleDesktopConfirmCallback is exported so telegram-webhook.js can call it.
async function handleDesktopConfirmCallback(action, pendingId, callbackQueryId,
                                            chatId, messageId, originalMessageText) {
  const pending = await fetchPending(pendingId);
  if (!pending) {
    if (callbackQueryId) await answerCallback(callbackQueryId, 'Request expired or not found');
    return;
  }

  if (pending.status !== 'pending') {
    if (callbackQueryId) await answerCallback(callbackQueryId, `Already ${pending.status}`);
    return;
  }

  const decision = action === 'desktop_confirm' ? 'confirmed' : 'denied';
  const now = new Date().toISOString();

  await patchPending(pendingId, { status: decision, resolved_at: now });
  await logDecision(pending, decision);

  if (chatId && messageId) {
    const tag = decision === 'confirmed' ? 'CONFIRMED' : 'DENIED';
    const updated = `${originalMessageText || pending.question}\n\n[${tag} by Heath at ${now}]`;
    await editMessage(chatId, messageId, updated.slice(0, 4096));
  }

  if (callbackQueryId) {
    await answerCallback(callbackQueryId, decision === 'confirmed' ? 'Confirmed' : 'Denied');
  }
  console.log(`[desktop-confirm-callback] pending ${pendingId} ${decision}`);
}

// Also expose a direct HTTP handler in case Cole or an agent wants to confirm
// programmatically (e.g. CLI tool). Auth: Bearer CRON_SECRET.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { pending_id, decision } = body;
  if (!pending_id || !['confirmed', 'denied'].includes(decision)) {
    return res.status(400).json({ ok: false, error: 'pending_id + decision (confirmed|denied) required' });
  }
  const pending = await fetchPending(pending_id);
  if (!pending) return res.status(404).json({ ok: false, error: 'pending not found' });
  if (pending.status !== 'pending') {
    return res.status(409).json({ ok: false, error: `already ${pending.status}` });
  }
  await patchPending(pending_id, { status: decision, resolved_at: new Date().toISOString() });
  await logDecision(pending, decision);
  return res.status(200).json({ ok: true, pending_id, decision });
};

module.exports.handleDesktopConfirmCallback = handleDesktopConfirmCallback;
