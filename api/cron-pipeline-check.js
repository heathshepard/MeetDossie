// Vercel Serverless Function: /api/cron-pipeline-check
// Pre-send pipeline status check. Runs at 11:00 UTC (6:00am CST) daily,
// 30 minutes before cron-send-for-approval fires. Sends a Telegram summary
// of today's post counts by status so Heath knows what's in the queue.
//
// Auth: Authorization: Bearer ${CRON_SECRET} or Vercel cron header
// Schedule: vercel.json — 0 11 * * * (same minute as cron-generate-posts;
// Vercel queues them so both fire at 11:00 UTC without conflict)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const body = await res.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = null; }
  if (!res.ok || data?.ok !== true) {
    console.error('[cron-pipeline-check] Telegram sendMessage failed:', res.status, body.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true };
}

module.exports = async function handler(req, res) {
  // Auth: accept Vercel built-in cron header OR manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID || '7874782923';

  if (!tgToken) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  // Query today's posts — use UTC date to stay consistent with cron-generate-posts.
  const today = new Date().toISOString().slice(0, 10);
  const startTime = `${today}T00:00:00`;
  const endTime = `${today}T23:59:59`;

  let counts = { draft: 0, approved: 0, rejected: 0, failed: 0, pending_card: 0 };
  let queryError = null;

  try {
    const { ok, data } = await supabaseFetch(
      `/rest/v1/social_posts?created_at=gte.${encodeURIComponent(startTime)}&created_at=lte.${encodeURIComponent(endTime)}&select=status`,
    );

    if (ok && Array.isArray(data)) {
      for (const row of data) {
        const s = String(row.status || '');
        if (s in counts) counts[s]++;
        // bucket any unrecognised status under failed for the summary
      }
    } else {
      queryError = `Supabase query returned status ${ok ? 'ok but non-array' : 'error'}`;
      console.warn('[cron-pipeline-check] query issue:', queryError);
    }
  } catch (err) {
    queryError = String(err && err.message || err).slice(0, 200);
    console.error('[cron-pipeline-check] Supabase fetch threw:', queryError);
  }

  const droppedCount = counts.rejected + counts.failed;

  let message = `Pipeline check - 6am\nReady for approval: ${counts.draft}\nAlready approved: ${counts.approved}\nRejected/failed overnight: ${droppedCount}\nWaiting on image: ${counts.pending_card}`;

  if (droppedCount > 0) {
    message += `\n\nWarning: ${droppedCount} post${droppedCount === 1 ? '' : 's'} dropped overnight - check DossieMarketingBot for details`;
  }

  if (queryError) {
    message += `\n\n(DB query error: ${queryError})`;
  }

  console.log('[cron-pipeline-check] sending pipeline summary:', { counts, droppedCount, today });

  const tgResult = await sendTelegram(tgToken, tgChatId, message);

  return res.status(200).json({
    ok: true,
    date: today,
    counts,
    dropped: droppedCount,
    telegram_sent: tgResult.ok,
  });
};
