// Vercel Serverless Function: /api/cron-send-for-approval
// Sends draft social posts to Heath via Telegram with approve/reject/edit
// inline-keyboard buttons. Updates each row with telegram_sent_at and
// telegram_message_id once the message has been delivered.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 30 11 * * * (11:30 UTC, ~30 min after generation).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_PER_RUN = 12;

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

function formatPostMessage(post) {
  const platform = post.platform || 'unknown';
  const persona = post.persona || 'unknown';
  const topic = post.topic || 'unknown';
  const content = String(post.content || '').slice(0, 3500);
  const hashtags = Array.isArray(post.hashtags) && post.hashtags.length
    ? post.hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '(none)';
  // Plain text — Telegram parse_mode left unset to avoid escaping headaches.
  return `📝 Post for ${platform} (${persona} voice)\nTopic: ${topic}\n— — —\n${content}\n— — —\nHashtags: ${hashtags}`;
}

function inlineKeyboard(postId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve_${postId}` },
      { text: '❌ Reject', callback_data: `reject_${postId}` },
      { text: '✏️ Edit', callback_data: `edit_${postId}` },
    ]],
  };
}

async function telegramSend(chatId, text, replyMarkup) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const respText = await res.text();
  let data = null;
  try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data, raw: respText };
}

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) {
    console.error('[cron-send-for-approval] CRON_SECRET not configured — refusing to run.');
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[cron-send-for-approval] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }

  // Find drafts that haven't been pushed to Telegram yet.
  const { data: drafts, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&telegram_sent_at=is.null&order=created_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load drafts' });
  }
  const items = Array.isArray(drafts) ? drafts : [];
  console.log('[cron-send-for-approval] drafts to send:', items.length);

  let sent = 0;
  const sendErrors = [];
  for (const post of items) {
    if (!post || !post.id) continue;
    const text = formatPostMessage(post);
    const result = await telegramSend(TELEGRAM_CHAT_ID, text, inlineKeyboard(post.id));
    if (!result.ok) {
      console.error('[cron-send-for-approval] telegram send failed for', post.id, 'status', result.status, 'body', result.raw?.slice(0, 200));
      sendErrors.push({ id: post.id, status: result.status, body: result.raw?.slice(0, 200) });
      continue;
    }
    const messageId = result.data?.result?.message_id || null;
    const now = new Date().toISOString();
    const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ telegram_sent_at: now, telegram_message_id: messageId }),
    });
    if (patch.ok) sent++;
    else sendErrors.push({ id: post.id, error: 'patch failed', status: patch.status });
  }

  console.log('[cron-send-for-approval] done — sent', sent, 'errors:', sendErrors.length);
  return res.status(200).json({ ok: true, sent, total: items.length, errors: sendErrors });
};
