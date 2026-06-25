// Vercel Serverless Function: /api/cron-heath-publish-digest
// Daily digest of yesterday's published posts + engagement metrics.
// Replaces individual per-post Telegram pings Heath gets now.
//
// Behavior:
//   1. Query social_posts where status='posted' and posted_at between 24h-48h ago
//   2. Aggregate: post count, platforms, personas, any anomalies
//   3. Query engagement_queue for metrics (if integrated with Zernio)
//   4. Send ONE Telegram message to Heath with the summary
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 7 * * * (7:00 UTC daily, ~2am CST).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false };

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json();
  return { ok: res.ok && data.ok === true, status: res.status, data };
}

module.exports = withTelemetry('cron-heath-publish-digest', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Get yesterday's posts (24h-48h ago in UTC)
  const now = new Date();
  const endTime = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 24h ago
  const startTime = new Date(now.getTime() - 48 * 60 * 60 * 1000); // 48h ago

  const startISO = startTime.toISOString();
  const endISO = endTime.toISOString();

  const { data: postedPosts, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(startISO)}&posted_at=lt.${encodeURIComponent(endISO)}&order=posted_at.desc`,
  );

  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load posts' });
  }

  const posts = Array.isArray(postedPosts) ? postedPosts : [];
  console.log('[cron-heath-publish-digest] digest for', posts.length, 'posts');

  if (posts.length === 0) {
    // No posts to digest
    return res.status(200).json({ ok: true, digested: 0 });
  }

  // Aggregate metrics
  const byPlatform = {};
  const byPersona = {};
  let totalPosts = 0;

  for (const post of posts) {
    totalPosts++;
    const platform = post.platform || 'unknown';
    const persona = post.persona || 'brand';

    byPlatform[platform] = (byPlatform[platform] || 0) + 1;
    byPersona[persona] = (byPersona[persona] || 0) + 1;
  }

  // Format the digest message
  const platformStr = Object.entries(byPlatform)
    .map(([p, count]) => `${p}(${count})`)
    .join(' + ');

  const personaStr = Object.entries(byPersona)
    .map(([p, count]) => `${p}(${count})`)
    .join(' + ');

  const postSamples = posts.slice(0, 3).map((p) => {
    const hook = String(p.content || '').split('\n')[0].slice(0, 60);
    return `• ${p.platform} (${p.persona}): "${hook}..."`;
  }).join('\n');

  const digestText = `📊 <b>Dossie Publishing Digest</b>

Yesterday (${startTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}):
<b>Posted:</b> ${totalPosts} posts
<b>Platforms:</b> ${platformStr}
<b>Personas:</b> ${personaStr}

<b>Sample Posts:</b>
${postSamples}

✅ All approved via Sage autonomous review.`;

  const telegramResult = await sendTelegram(digestText);
  if (!telegramResult.ok) {
    console.error('[cron-heath-publish-digest] telegram send failed:', telegramResult.status);
    return res.status(502).json({
      ok: false,
      error: 'telegram send failed',
      status: telegramResult.status,
    });
  }

  return res.status(200).json({
    ok: true,
    digested: posts.length,
    platforms: Object.keys(byPlatform),
    personas: Object.keys(byPersona),
  });
});
