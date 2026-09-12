'use strict';

// One-off: deliver the 2 stranded pipeline='listing-groups' 104 Wild Cherry
// "just sold" drafts (Tx Hill Country Buy-Sell-Trade-Barter, Buy Buy Boerne)
// with the correct video attached.
//
// Why a dedicated endpoint instead of the generic retry
// (scripts/listing-marketing-generator.js's retryPendingListingGroupNotifications):
// that function matches media by scanning LISTINGS (listing-marketing-facts.js)
// for a listing whose .address string appears in the stored post_body. 104
// Wild Cherry already sold and was never added to LISTINGS (it's not part of
// the active rotation config), and the "just_sold" template text never
// includes the literal street address ("Just closed another one in Boerne,
// Cherry Ridge, 2+ acres...") -- so the generic matcher can't find it. These
// 2 specific rows are a one-time hand-inserted placement (Heath's call,
// 2026-09-11), not part of the normal Tier-2 rotation, so a hardcoded
// one-off is the honest fix rather than teaching the generic matcher a
// special case for a listing that's no longer active.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-deliver-wildcherry-listing-groups
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-12

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const WILDCHERRY_VIDEO = `${SUPABASE_URL}/storage/v1/object/public/videos/listing-marketing/wildcherry/104-wild-cherry-square.mp4`;

const ROW_IDS = [
  'a0d79d1a-d799-49a0-9c14-71c74977c6b8', // Tx Hill Country Buy-Sell-Trade-Barter
  '7443b60f-416a-4891-baaa-a0304b0a1da3', // Buy Buy Boerne
];

async function sbFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function telegramSendVideo(caption) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, video: WILDCHERRY_VIDEO, caption: caption.slice(0, 1020) }),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data };
}

async function telegramSendMessage(text, rowId) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `lst_approve:${rowId}` },
          { text: 'Edit', callback_data: `lst_edit:${rowId}` },
          { text: 'Skip', callback_data: `lst_skip:${rowId}` },
        ]],
      },
    }),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({ ok: false, error: 'missing_env' });
  }

  const { recordAttempt } = require('./_lib/telegram-send-retry.js');
  const results = [];

  const { ok, data } = await sbFetch(
    `/rest/v1/group_posts?id=in.(${ROW_IDS.join(',')})&select=id,group_name,post_body,status,telegram_sent_at,telegram_send_attempts`,
  );
  if (!ok || !Array.isArray(data)) {
    return res.status(502).json({ ok: false, error: 'failed to load rows' });
  }

  for (const rowId of ROW_IDS) {
    const row = data.find((r) => r.id === rowId);
    if (!row) { results.push({ rowId, ok: false, reason: 'not_found' }); continue; }
    if (row.status !== 'draft' || row.telegram_sent_at) {
      results.push({ rowId, ok: false, reason: 'already_handled', status: row.status, telegram_sent_at: row.telegram_sent_at });
      continue;
    }

    const mediaRes = await telegramSendVideo(`104 Wild Cherry -> ${row.group_name}`);
    const msg = `LISTING GROUP POST DRAFT\n104 Wild Cherry -> ${row.group_name}\n${mediaRes.ok ? '(video above)' : '(video send failed -- text only)'}\n\n${row.post_body}`;
    const sendRes = await telegramSendMessage(msg, row.id);

    const attemptNumber = (row.telegram_send_attempts || 0) + 1;
    await recordAttempt(sbFetch, {
      table: 'group_posts', rowId: row.id, identifier: `${row.group_name} (listing-groups, wildcherry manual delivery)`,
      attemptNumber, sendRes,
    });

    if (sendRes.ok) {
      const messageId = sendRes.data?.result?.message_id != null ? String(sendRes.data.result.message_id) : null;
      await sbFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ telegram_sent_at: new Date().toISOString(), telegram_message_id: messageId }),
      });
      results.push({ rowId, ok: true, messageId, mediaOk: mediaRes.ok });
    } else {
      results.push({ rowId, ok: false, telegramResponse: sendRes.data });
    }
  }

  return res.status(200).json({ ok: true, results });
};
