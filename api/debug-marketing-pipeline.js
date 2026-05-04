// Vercel Serverless Function: /api/debug-marketing-pipeline
// One-shot diagnostic for the marketing approval flow.
//   - GETs https://api.telegram.org/bot${TOKEN}/getWebhookInfo (proves the
//     webhook is registered and TELEGRAM_BOT_TOKEN is valid).
//   - Picks the newest draft for `platform` (default: twitter), re-sends it
//     to Telegram with fresh Approve/Reject/Edit buttons, updates
//     telegram_sent_at + telegram_message_id.
// Returns both results so Heath can verify in one curl.
//
// Auth: Authorization: Bearer ${CRON_SECRET}.
// Use:
//   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     "https://meetdossie.com/api/debug-marketing-pipeline?platform=twitter"

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
  return `📝 [DEBUG RESEND] Post for ${platform} (${persona} voice)\nTopic: ${topic}\n— — —\n${content}\n— — —\nHashtags: ${hashtags}`;
}

function inlineKeyboard(postId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve_${postId}` },
      { text: '❌ Reject',  callback_data: `reject_${postId}` },
      { text: '✏️ Edit',    callback_data: `edit_${postId}` },
    ]],
  };
}

async function tgGet(method) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data };
}

async function tgPost(method, body) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data, raw: text };
}

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured' });
  }

  // Resolve target platform from ?platform=, default twitter. Block linkedin
  // since there's no zernio_account for it.
  const url = new URL(req.url, 'https://meetdossie.com');
  const platform = (url.searchParams.get('platform') || 'twitter').toLowerCase();
  if (platform === 'linkedin') {
    return res.status(400).json({ ok: false, error: 'linkedin has no zernio_account; pick another platform' });
  }

  // 1. getWebhookInfo
  const webhook = await tgGet('getWebhookInfo');

  // 2. Pick the newest draft for that platform.
  const filter = `status=eq.draft&platform=eq.${encodeURIComponent(platform)}&order=created_at.desc&limit=1`;
  const { data: rows, ok: loadOk } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to query social_posts', webhook_info: webhook.data });
  }
  const post = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!post) {
    return res.status(404).json({ ok: false, error: `no draft found for platform=${platform}`, webhook_info: webhook.data });
  }

  // 3. Send to Telegram.
  const text = formatPostMessage(post);
  const send = await tgPost('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard(post.id),
  });

  // 4. Update telegram_sent_at + message_id (so cron-send-for-approval doesn't re-send).
  let patchOk = false;
  if (send.ok) {
    const messageId = send.data?.result?.message_id || null;
    const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        telegram_sent_at: new Date().toISOString(),
        telegram_message_id: messageId,
      }),
    });
    patchOk = patch.ok;
  }

  return res.status(200).json({
    ok: true,
    webhook_info: webhook.data,
    post: {
      id: post.id,
      post_id: post.post_id,
      platform: post.platform,
      persona: post.persona,
      topic: post.topic,
      content_preview: String(post.content || '').slice(0, 240),
    },
    telegram_send: {
      ok: send.ok,
      status: send.status,
      message_id: send.data?.result?.message_id || null,
      raw: send.ok ? null : send.raw?.slice(0, 300),
    },
    db_patched: patchOk,
  });
};
