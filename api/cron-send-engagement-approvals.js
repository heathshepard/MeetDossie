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

const caps = require('./_lib/engagement-caps');

const MAX_SEND_PER_RUN = 6;
const PLATFORM_LABEL = {
  facebook:  'Facebook',
  instagram: 'Instagram',
  linkedin:  'LinkedIn',
  reddit:    'Reddit',
  twitter:   'Twitter/X',
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

  // Pull a wider candidate window than MAX_SEND_PER_RUN so the cap filter has
  // material to choose from -- some drafted rows will be deferred (author
  // cooldown, platform-cap hit) and we still want to fill the daily budget
  // from other platforms in the same run.
  const drafted = await fetchDrafted(MAX_SEND_PER_RUN * 5);
  if (!drafted.length) {
    return res.status(200).json({ ok: true, sent: 0, message: 'queue empty' });
  }

  // Heath's caps (5/day total, 2/day per platform, 1 author / 7d).
  // Loaded once per run -- "in-flight" approvals from this run mutate the
  // state object as we go so we never over-allocate inside the same loop.
  const [counts, blockedAuthors] = await Promise.all([
    caps.loadDailyCounts(),
    caps.loadAuthorBlocklist(),
  ]);
  const capState = caps.makeCapState(counts, blockedAuthors);

  let sent = 0;
  let skippedMissingDraft = 0;
  const deferred = { total_daily_cap: 0, platform_daily_cap: 0, author_7d_cooldown: 0 };

  for (const row of drafted) {
    if (sent >= MAX_SEND_PER_RUN) break;
    if (capState.totalRemaining <= 0) break;

    // Guard against data-loss bug -- never Telegram a row whose comment_draft
    // isn't actually in the DB. Bounce it back to 'pending' so the drafting
    // cron can re-run on it. Without this guard a status='drafted' row with
    // null comment_draft surfaces as "(empty draft)" in the approval message
    // and Heath approves an empty string, losing the in-flight comment text.
    if (!row.comment_draft || !row.comment_draft.trim()) {
      await patchRow(row.id, {
        status: 'pending',
        last_error: 'sender_found_null_draft_resetting_to_pending',
      });
      skippedMissingDraft++;
      continue;
    }

    const decision = caps.tryConsume(capState, row);
    if (!decision.allow) {
      // Don't telegram-blast -- leave row at status='drafted' so the next
      // cron run (post-midnight UTC, or after the author cooldown lifts)
      // can pick it up. We tag the latest reason so the queue dashboard can
      // explain "why is this row sitting" without a DB dive.
      await patchRow(row.id, {
        last_error: `deferred_by_cap:${decision.reason}`,
      });
      deferred[decision.reason] = (deferred[decision.reason] || 0) + 1;
      continue;
    }

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

  return res.status(200).json({
    ok: true,
    sent,
    queued: drafted.length,
    skippedMissingDraft,
    deferred,
    capState: {
      totalRemaining: capState.totalRemaining,
      perPlatformRemaining: capState.perPlatformRemaining,
    },
  });
};
