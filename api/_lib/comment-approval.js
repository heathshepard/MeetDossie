'use strict';

// Unified comment approval flow for FB / IG / LinkedIn / Reddit.
//
// Engager scripts insert a draft into the relevant *_comment_drafts table (or
// reddit_engagements for Reddit), then call queueCommentForApproval() which
// sends the draft to DossieMarketingBot with Approve/Reject inline buttons.
//
// 10-minute veto window: cron-auto-approve flips any 'pending' comment with
// telegram_sent_at older than 10 minutes to 'approved' automatically.
//
// The marketing-bot callback handler (telegram-webhook.js / dossie-marketing
// callbacks) routes approve/reject by parsing callback_data shape:
//   "comment_approve:<platform>:<id>"
//   "comment_reject:<platform>:<id>"

const PLATFORM_TABLES = {
  facebook:  'facebook_comment_drafts',
  instagram: 'instagram_comment_drafts',
  linkedin:  'linkedin_comment_drafts',
  reddit:    'reddit_engagements', // has its own status column + workflow
};

const PLATFORM_LABELS = {
  facebook:  'FB',
  instagram: 'IG',
  linkedin:  'LI',
  reddit:    'Reddit',
};

async function supaPatch({ supabaseUrl, supabaseKey }, table, idColumn, idValue, payload) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/${table}?${idColumn}=eq.${encodeURIComponent(idValue)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    },
  );
  return res.ok;
}

async function sendApprovalMessage(opts) {
  const { platform, draftId, commentText, targetPostUrl, persona, telegramToken, chatId } = opts;
  const platformLabel = PLATFORM_LABELS[platform] || platform;

  const lines = [
    `<b>${platformLabel} comment draft</b>`,
    '',
    `<b>Target:</b> ${targetPostUrl}`,
  ];
  if (persona) lines.push(`<b>Persona:</b> ${persona}`);
  lines.push('', `<b>Comment:</b>`, commentText);
  lines.push('', '<i>Auto-approves in 10 min if no veto.</i>');

  const body = {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `comment_approve:${platform}:${draftId}` },
        { text: 'Reject',  callback_data: `comment_reject:${platform}:${draftId}` },
      ]],
    },
  };

  const res = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('[comment-approval] telegram send failed:', text.slice(0, 200));
    return { ok: false, error: text.slice(0, 200) };
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return { ok: true, message_id: parsed?.result?.message_id };
}

async function queueCommentForApproval(opts) {
  // opts: { platform, draftId, commentText, targetPostUrl, persona,
  //         supabaseUrl, supabaseKey, telegramToken, chatId }
  const { platform, draftId } = opts;
  const table = PLATFORM_TABLES[platform];
  if (!table) return { ok: false, error: `unknown platform '${platform}'` };

  const send = await sendApprovalMessage(opts);
  if (!send.ok) return send;

  const idColumn = platform === 'reddit' ? 'id' : 'id';
  const patched = await supaPatch(
    { supabaseUrl: opts.supabaseUrl, supabaseKey: opts.supabaseKey },
    table,
    idColumn,
    draftId,
    {
      telegram_message_id: send.message_id ? String(send.message_id) : null,
      telegram_sent_at: new Date().toISOString(),
    },
  );
  return { ok: true, patched, message_id: send.message_id };
}

module.exports = {
  PLATFORM_TABLES,
  PLATFORM_LABELS,
  queueCommentForApproval,
};
