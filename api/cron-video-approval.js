// Vercel Serverless Function: /api/cron-video-approval
// Runs at 10:00 UTC (5am CST) daily.
//
// video_library PART RETIRED (Carter, 2026-09-18 — activation-forensics
// review found 4 gate-passed videos never reached Heath).
// This used to pick the oldest 'ready' video from video_library, mark it
// pending_approval, and send an individual Telegram Approve/Reject message.
// That made TWO code paths write/read video_library approval state:
// this one ('ready' -> 'pending_approval', always an individual ping) and
// api/cron-post-videos.js Step 1 ('approved' -> 'pending_heath_review',
// batched into the morning brief per Heath's 2026-09-17 "batch the routine
// approvals, don't ping per item" call). Four gate-passed videos sat
// unnotified for two days as a direct result of producers disagreeing on
// which of the two statuses to write.
//
// 'approved' -> api/cron-post-videos.js is now the ONE canonical entry
// point (see that file's "REVIEW GATE FLOW" comment for the full chain,
// and scripts/regression-video-library-status-consumed.js for the
// structural guard that fails the build if a producer writes a status no
// consumer selects). Nothing writes 'ready' or 'pending_approval' into
// video_library anymore, so this file no longer queries it — the Part 1
// block below is deleted, not merely disabled, to avoid a second cron
// racing api/cron-post-videos.js over the same rows. skit_queue (Part 2,
// below) is untouched — a separate table, separate flow, out of scope for
// this fix.
//
// Auth: Vercel cron header OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 10 * * *"

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-video-approval');
const { wasSuppressed } = telegramGate;

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

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

async function tgSend(body) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, data };
}

module.exports = withTelemetry('cron-video-approval', async function handler(req, res) {
  // Auth check
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  // --- PART 2: skit_queue video_rendered skits ---
  const { data: skitRows, ok: skitOk } = await supabaseFetch(
    '/rest/v1/skit_queue?status=eq.video_rendered&order=created_at.asc&limit=2',
  );

  if (!skitOk) {
    console.error('[cron-video-approval] Failed to query skit_queue for video_rendered rows');
  }

  const renderedSkits = Array.isArray(skitRows) ? skitRows : [];
  console.log(`[cron-video-approval] ${renderedSkits.length} rendered skits to send for approval`);

  const skitResults = [];

  for (const skit of renderedSkits) {
    const skitId = skit.id;
    const topic = skit.topic || skitId;
    const videoUrl = skit.video_url;
    const caption = skit.caption || `Reel: ${topic} - meetdossie.com/signup`;

    if (!videoUrl) {
      console.warn(`[cron-video-approval] Skit ${skitId} has no video_url — skipping`);
      continue;
    }

    // Mark as pending so next run doesn't re-send
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'video_pending_approval' }),
    });

    const messageText = [
      `Reel ready for final approval`,
      `Topic: ${topic}`,
      ``,
      `Caption: ${caption.slice(0, 150)}`,
      ``,
      `Watch it: ${videoUrl}`,
    ].join('\n');

    const { ok: tgOk, data: tgData } = await tgSend({
      chat_id: TELEGRAM_CHAT_ID,
      text: messageText,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve - Post It', callback_data: `skit_video_approve_${skitId}` },
          { text: 'Reject', callback_data: `skit_video_reject_${skitId}` },
        ]],
      },
      disable_web_page_preview: false,
    });

    const skitSuppressed = wasSuppressed(tgData);
    if (skitSuppressed) {
      console.warn(`[cron-video-approval] approval message for skit ${skitId} was SUPPRESSED by telegram-gate — reverting to 'video_rendered', NOT marking video_pending_approval`);
    }
    if (!tgOk || skitSuppressed) {
      if (!tgOk) console.error(`[cron-video-approval] Telegram send failed for skit ${skitId}:`, JSON.stringify(tgData).slice(0, 200));
      // Revert so next run retries
      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'video_rendered' }),
      });
    } else {
      const messageId = tgData?.result?.message_id || null;
      console.log(`[cron-video-approval] Skit ${skitId} sent to Telegram, message_id=${messageId}`);
      skitResults.push({ skit_id: skitId, telegram_message_id: messageId });
    }
  }

  return res.status(200).json({
    ok: true,
    library: null, // retired 2026-09-18 -- video_library is handled by api/cron-post-videos.js now
    skits_sent_for_approval: skitResults,
  });
});
