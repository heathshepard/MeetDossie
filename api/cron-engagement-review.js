'use strict';

// Vercel Serverless Function: /api/cron-engagement-review
//
// Human-approval gate for FB-group engagement drafts (Sage, 2026-08-17;
// posting flow reworked to a manual handoff by Atlas 2026-08-18).
// scripts/fb-engagement-scraper.js finds a real, relevant comment/post in a
// target group and drafts a genuine reply in Heath's voice -- this cron
// surfaces each pending_review row from engagement_queue to Heath via
// Telegram with Approve/Reject buttons. Nothing here ever posts a comment as
// Heath; Approve triggers api/telegram-webhook.js to send a follow-up
// message with the thread permalink + reply text for Heath to paste and
// post himself -- no script ever drives the post.
//
// Mirrors api/cron-content-pipeline-review.js's per-row pattern (one item ->
// one Telegram card -> Approve/Reject -> telegram-webhook.js callback).
// There is no inline-edit button (matches cpage's own pattern) -- if Heath
// wants a different reply, he replies in the Telegram thread and the draft
// gets hand-revised, same as content-pipeline review.
//
// Auth:     Authorization: Bearer ${CRON_SECRET} (or Vercel's own cron header)
// Schedule: vercel.json -- every 20 min, matches cron-content-pipeline-review.

require('./_lib/telegram-gate').install('cron-engagement-review');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MAX_ROWS_PER_RUN = 5; // don't flood Telegram in one pass

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function tgSend(text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const respText = await res.text();
  let data = null;
  try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, data, raw: respText };
}

function inlineKeyboard(rowId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `engage_approve_${rowId}` },
      { text: '❌ Reject', callback_data: `engage_reject_${rowId}` },
    ]],
  };
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '...' : str;
}

function formatMessage(row) {
  return [
    'ENGAGEMENT OPPORTUNITY -- REVIEW REQUIRED',
    '',
    `Group: ${row.group_name}`,
    `Type: ${row.content_type}`,
    `Author: ${row.author_name || 'unknown'}`,
    row.permalink ? `Link: ${row.permalink}` : '(no permalink captured)',
    '',
    '--- Their post/comment ---',
    truncate(row.original_text, 500),
    '',
    '--- Drafted reply (your voice) ---',
    truncate(row.drafted_reply, 500),
    '',
    'Approve = you get a follow-up message with the thread link + text to paste and post yourself. Nothing posts automatically.',
    'Reject = discarded, this thread will not be resurfaced.',
    'Want it different? Reply here in Telegram with the edit and it gets hand-applied.',
  ].join('\n');
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[cron-engagement-review] Telegram env not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }

  const { data: rows, ok: loadOk } = await sb(
    `engagement_queue?status=eq.pending_review&telegram_sent_at=is.null&order=created_at.asc&limit=${MAX_ROWS_PER_RUN}`,
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load engagement_queue' });
  }
  const items = Array.isArray(rows) ? rows : [];

  let sent = 0;
  const errors = [];
  for (const row of items) {
    const text = formatMessage(row);
    const result = await tgSend(text, inlineKeyboard(row.id));
    if (!result.ok) {
      console.error('[cron-engagement-review] send failed for row', row.id, result.raw?.slice(0, 200));
      errors.push({ id: row.id, error: result.raw?.slice(0, 200) });
      continue;
    }
    const messageId = result.data?.result?.message_id || null;
    const patch = await sb(`engagement_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        telegram_sent_at: new Date().toISOString(),
        telegram_message_id: messageId,
      }),
    });
    if (!patch.ok) {
      errors.push({ id: row.id, error: 'failed to stamp telegram_sent_at' });
    } else {
      sent += 1;
    }
  }

  console.log('[cron-engagement-review] done — sent', sent, 'of', items.length, 'errors:', errors.length);
  return res.status(200).json({ ok: true, sent, found: items.length, errors });
};
