// Vercel Serverless Function: /api/cron-video-approval
// Runs at 10:00 UTC (5am CST) daily.
// Picks the oldest 'ready' video from video_library, marks it
// pending_approval, and sends a Telegram message with Approve/Reject buttons.
//
// Auth: Vercel cron header OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 10 * * *"

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

module.exports = async function handler(req, res) {
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

  // Query for the oldest ready video
  const { data: rows, ok: loadOk } = await supabaseFetch(
    '/rest/v1/video_library?status=eq.ready&order=created_at.asc&limit=1',
  );

  if (!loadOk) {
    console.error('[cron-video-approval] Failed to query video_library');
    return res.status(502).json({ ok: false, error: 'Failed to query video_library' });
  }

  const video = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

  if (!video) {
    console.log('[cron-video-approval] No ready videos — nothing to do');
    return res.status(200).json({ ok: true, message: 'no videos ready' });
  }

  console.log(`[cron-video-approval] Found ready video: ${video.id}`);

  // Mark pending_approval
  const { ok: patchOk } = await supabaseFetch(
    `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'pending_approval' }),
    },
  );

  if (!patchOk) {
    console.error('[cron-video-approval] Failed to patch status to pending_approval');
    return res.status(502).json({ ok: false, error: 'Failed to update status' });
  }

  // Build Telegram message
  const platformList = Array.isArray(video.platforms) ? video.platforms.join(', ') : 'unknown';
  const messageText = [
    'New video ready for review',
    '',
    `Type: ${video.type || 'unknown'}`,
    `Topic: ${video.topic || 'unknown'}`,
    `Platforms: ${platformList}`,
    `Caption: ${video.caption || '(none)'}`,
    '',
    `ID: ${video.id}`,
    video.supabase_url ? `URL: ${video.supabase_url}` : '(not yet uploaded to Supabase — run upload-video.py first)',
  ].join('\n');

  const tgBody = {
    chat_id: TELEGRAM_CHAT_ID,
    text: messageText,
    reply_markup: {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `video_approve_${video.id}` },
        { text: 'Reject', callback_data: `video_reject_${video.id}` },
      ]],
    },
    disable_web_page_preview: true,
  };

  const { ok: tgOk, data: tgData } = await tgSend(tgBody);

  if (!tgOk) {
    console.error('[cron-video-approval] Telegram send failed:', JSON.stringify(tgData).slice(0, 200));
    // Revert status so next run can retry
    await supabaseFetch(
      `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'ready' }),
      },
    );
    return res.status(502).json({ ok: false, error: 'Telegram send failed' });
  }

  const messageId = tgData?.result?.message_id || null;
  console.log(`[cron-video-approval] Telegram message_id=${messageId}`);

  // Save telegram_message_id
  if (messageId) {
    await supabaseFetch(
      `/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ telegram_message_id: messageId }),
      },
    );
  }

  return res.status(200).json({
    ok: true,
    video_id: video.id,
    telegram_message_id: messageId,
  });
};
