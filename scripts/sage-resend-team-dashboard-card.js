// One-off: correct the wrong-image Telegram approval card for
// social_posts.id=82a4511a-c4c1-4e8b-8553-a63391bc799b (team_dashboard_launch FB post).
// Deletes the old (wrong-image) card messages, then resends using the exact
// same format cron-send-for-approval.js uses, pointed at the corrected
// media_url. Updates telegram_sent_at/telegram_message_id in place.
const fs = require('fs');
const envPath = require('path').join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m) continue;
  let val = m[2];
  if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
  if (!process.env[m[1]] || process.env[m[1]] === '[SENSITIVE]') process.env[m[1]] = val;
}

const { gateBeforeApprovalSend } = require('../api/_lib/verify-image-match.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pgwoitbdiyubjugwufhk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = '7874782923'; // Heath's chat id (docs/ENV.md)

const POST_ID = '82a4511a-c4c1-4e8b-8553-a63391bc799b';
const OLD_TEXT_MSG_ID = 1410; // known from Telegram card sent 2026-08-18T14:12:13Z

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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok && data && data.ok === true, data };
}

function inlineKeyboard(postId) {
  return {
    inline_keyboard: [[
      { text: '❌ Reject', callback_data: `reject_${postId}` },
      { text: '✏️ Edit', callback_data: `edit_${postId}` },
    ]],
  };
}

(async () => {
  if (!SUPABASE_SERVICE_ROLE_KEY || !TELEGRAM_BOT_TOKEN) {
    console.error('Missing SUPABASE_SERVICE_ROLE_KEY or TELEGRAM_MARKETING_BOT_TOKEN');
    process.exit(1);
  }

  const { data: rows } = await supabaseFetch(`/rest/v1/social_posts?id=eq.${POST_ID}&select=*`);
  const post = Array.isArray(rows) ? rows[0] : null;
  if (!post) { console.error('post not found'); process.exit(1); }
  console.log('media_url now:', post.media_url);

  // Vision claim-match gate — same shared check as cron-send-for-approval.js
  // and telegram-webhook.js. Applies here too so a one-off/manual resend
  // can't bypass it.
  const gateOk = await gateBeforeApprovalSend(post);
  if (!gateOk) {
    console.error('held on image mismatch — not resending. See Telegram alert.');
    process.exit(1);
  }

  // 1. Delete the old (wrong-image) buttons message so it's no longer a live decision point.
  const delText = await tg('deleteMessage', { chat_id: TELEGRAM_CHAT_ID, message_id: OLD_TEXT_MSG_ID });
  console.log('deleted old text/buttons msg', OLD_TEXT_MSG_ID, delText.ok, delText.data && delText.data.description);
  // Best-effort: the photo message immediately preceded it in the same run.
  const delPhoto = await tg('deleteMessage', { chat_id: TELEGRAM_CHAT_ID, message_id: OLD_TEXT_MSG_ID - 1 });
  console.log('deleted old photo msg', OLD_TEXT_MSG_ID - 1, delPhoto.ok, delPhoto.data && delPhoto.data.description);

  // 2. Send corrected photo message.
  const shortCaption = `facebook (${post.persona}) - image\n\n🔧 CORRECTED IMAGE (was showing single-agent Pipeline view, not team dashboard)\n\n${post.hook || ''}`.slice(0, 1020);
  const photoRes = await tg('sendPhoto', { chat_id: TELEGRAM_CHAT_ID, photo: post.media_url, caption: shortCaption });
  console.log('sent corrected photo:', photoRes.ok, photoRes.data && photoRes.data.result && photoRes.data.result.message_id);
  if (!photoRes.ok) { console.error('photo send failed', JSON.stringify(photoRes.data)); process.exit(1); }

  // 3. Send full content + Reject/Edit buttons (same format as cron-send-for-approval.js).
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags.map(h => `#${h}`).join(' ') : '';
  const fullContent = `📝 Full caption for facebook (${post.persona}, topic: ${post.topic})\n\n${post.content}\n\nHashtags: ${hashtags}\n\n📐 Algorithm: Pain-point/question hook, 200-500 words, short paragraphs, comment-driving CTA, 2-3 hashtags`;
  const prefix = '⏱ Auto-posting in 30 min — tap Reject to cancel\n\n';
  const textRes = await tg('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text: prefix + fullContent,
    reply_markup: inlineKeyboard(post.id),
    disable_web_page_preview: true,
  });
  console.log('sent corrected text/buttons:', textRes.ok, textRes.data && textRes.data.result && textRes.data.result.message_id);
  if (!textRes.ok) { console.error('text send failed', JSON.stringify(textRes.data)); process.exit(1); }

  const newMessageId = textRes.data.result.message_id;
  const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${POST_ID}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ telegram_sent_at: new Date().toISOString(), telegram_message_id: newMessageId }),
  });
  console.log('DB patched:', patch.ok, patch.status);
})();
