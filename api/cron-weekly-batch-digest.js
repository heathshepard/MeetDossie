'use strict';

// Vercel Serverless Function: /api/cron-weekly-batch-digest
//
// Weekly batch-approval digest (Heath, 2026-09-12, verbatim: "lets prepare
// a week's worth of posts that I can approve at a time. Im a bottle neck
// here and I dont like it").
//
// Rolls up every unresolved (status='draft') social_posts + group_posts row
// from the past week into ONE Telegram message instead of the daily
// tap-by-tap approval flow, grouped by day/platform with a one-line preview
// + score, plus a media-preview follow-up for any row that already has a
// media_url. Two ways to act:
//   - Tap "Approve all" (single explicit button, never a timeout) — flips
//     every listed row that is STILL status='draft' to 'approved'.
//   - Reply "approve post N" / "reject post N" / "edit post N" to handle one
//     individually (api/telegram-webhook.js resolves N against the same
//     items array stored on this digest's weekly_digest_surfaces row).
//
// Runs Sunday evening (0 23 * * 0 UTC = 6pm CDT / 5pm CST) so the week ahead
// (Monday-start) is a single pass, not seven.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json — 0 23 * * 0
//
// Owner: Carter, 2026-09-12

require('./_lib/telegram-gate').install('cron-weekly-batch-digest');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const {
  fetchPendingSocialPosts,
  fetchPendingGroupPosts,
  buildDigest,
  chunkMessage,
  nextMondayLabel,
  saveSurface,
} = require('./_lib/weekly-batch-digest');

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramMessage(text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function sendMediaGroup(urls) {
  // Telegram caps sendMediaGroup at 10 items per call — chunk defensively.
  const results = [];
  for (let i = 0; i < urls.length; i += 10) {
    const chunk = urls.slice(i, i + 10);
    const media = chunk.map((url, idx) => ({
      type: /\.mp4($|\?)/i.test(url) ? 'video' : 'photo',
      media: url,
      caption: idx === 0 && i === 0 ? 'Media previews for this week\'s batch' : undefined,
    }));
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, media }),
      });
      results.push({ ok: res.ok, status: res.status });
    } catch (err) {
      results.push({ ok: false, error: err && err.message });
    }
  }
  return results;
}

module.exports = withTelemetry('cron-weekly-batch-digest', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'Telegram not configured' });
  }

  const [socialRows, groupRows] = await Promise.all([
    fetchPendingSocialPosts(),
    fetchPendingGroupPosts(),
  ]);

  if (socialRows.length === 0 && groupRows.length === 0) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'nothing pending — no digest sent' });
  }

  const { items, lines, mediaUrls, socialCount, groupCount } = buildDigest(socialRows, groupRows);
  const weekStart = nextMondayLabel();

  const header = [
    `WEEKLY BATCH — week of ${weekStart}`,
    `${items.length} posts waiting (${socialCount} social, ${groupCount} FB group)`,
  ].join('\n');
  const footer = [
    '',
    'Tap "Approve all" below to approve everything above.',
    'To handle one yourself, reply: approve post N / reject post N / edit post N',
  ].join('\n');

  const fullText = [header, ...lines, footer].join('\n');
  const chunks = chunkMessage(fullText, 3800);

  // Send overview chunks first (no buttons on multi-part overflow — button
  // goes on the LAST chunk so it's the thing Heath sees right after reading).
  let lastMessageId = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const sendRes = await sendTelegramMessage(
      chunks[i],
      isLast ? { inline_keyboard: [[{ text: `Approve all (${items.length})`, callback_data: 'wdigest_approve_all' }]] } : undefined,
    );
    if (!sendRes.ok) {
      console.error('[cron-weekly-batch-digest] Telegram send failed:', JSON.stringify(sendRes.data).slice(0, 300));
      return res.status(200).json({ ok: false, error: 'Telegram send failed', detail: sendRes.data });
    }
    if (isLast) lastMessageId = sendRes.data?.result?.message_id || null;
  }

  if (mediaUrls.length) {
    await sendMediaGroup(mediaUrls);
  }

  const surface = await saveSurface({
    chatId: TELEGRAM_CHAT_ID,
    messageId: lastMessageId,
    weekStart,
    items,
  });

  return res.status(200).json({
    ok: true,
    week_start: weekStart,
    item_count: items.length,
    social_count: socialCount,
    group_count: groupCount,
    media_previews: mediaUrls.length,
    surface_id: surface?.id || null,
  });
});
