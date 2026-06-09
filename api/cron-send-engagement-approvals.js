'use strict';

// api/cron-send-engagement-approvals.js
//
// Pulls engagement_candidates with status='drafted', sends each to
// DossieMarketingBot with Approve / Reject buttons, then marks
// status='sent_for_approval' with telegram_message_id captured.
//
// Schedule: every 15 minutes via cron-job.org. We'd run more often but
// Heath wants pacing -- if Sage drafts 30 things at once, blasting them
// to Telegram in one minute trains him to ignore the bot. 15-min pacing
// at ~6 candidates per run = comfortable read tempo.
//
// Auth: Bearer ${CRON_SECRET}.
//
// Callback contract (handled in api/telegram-webhook.js):
//   approve callback_data = `eng_approve:<id>`
//   reject  callback_data = `eng_reject:<id>`

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_SEND_PER_RUN = 6;
const PLATFORM_LABEL = {
  facebook:  'Facebook',
  instagram: 'Instagram',
  linkedin:  'LinkedIn',
  reddit:    'Reddit',
};

// ─── Supabase ────────────────────────────────────────────────────────────────

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
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function fetchDrafted(limit) {
  const path = `/rest/v1/engagement_candidates?status=eq.drafted&order=relevance_score.desc.nullslast,created_at.asc&limit=${limit}`;
  const { ok, data } = await sbFetch(path);
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function patchRow(id, fields) {
  await sbFetch(`/rest/v1/engagement_candidates?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
}

// ─── Telegram ────────────────────────────────────────────────────────────────

async function tgSend(text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        disable_web_page_preview: true,
        reply_markup: replyMarkup || undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    return data?.result?.message_id || null;
  } catch {
    return null;
  }
}

function buildContextMessage(row) {
  const plat = PLATFORM_LABEL[row.platform] || row.platform;
  const author = row.author_handle ? `\nAuthor: ${row.author_handle}` : '';
  const matched = (row.matched_keywords || []).filter(Boolean).slice(0, 4).join(', ');
  const score = row.relevance_score != null ? ` (score ${row.relevance_score})` : '';
  const snippet = (row.post_text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
  return [
    `${plat} engagement candidate${score}`,
    matched ? `Matched: ${matched}` : null,
    author || null,
    '',
    `"${snippet}"`,
    '',
    row.post_url,
  ].filter(Boolean).join('\n');
}

function buildDraftMessage(row) {
  return [
    'Draft comment:',
    '',
    row.comment_draft || '(empty draft)',
    '',
    'Approve = post via real Chrome on next poster run.',
  ].join('\n');
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({ error: 'Telegram env not configured' });
  }

  const drafted = await fetchDrafted(MAX_SEND_PER_RUN);
  if (!drafted.length) {
    return res.status(200).json({ ok: true, sent: 0, message: 'queue empty' });
  }

  let sent = 0;
  for (const row of drafted) {
    // Two-message pattern -- context first (no buttons), draft second (with buttons).
    await tgSend(buildContextMessage(row), null);
    await new Promise((r) => setTimeout(r, 700));

    const keyboard = {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `eng_approve:${row.id}` },
        { text: 'Reject',  callback_data: `eng_reject:${row.id}` },
      ]],
    };
    const messageId = await tgSend(buildDraftMessage(row), keyboard);

    await patchRow(row.id, {
      status: 'sent_for_approval',
      telegram_sent_at: new Date().toISOString(),
      telegram_message_id: messageId || null,
    });
    sent++;
    await new Promise((r) => setTimeout(r, 1500));
  }

  return res.status(200).json({ ok: true, sent, queued: drafted.length });
};
