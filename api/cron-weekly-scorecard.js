// Vercel Serverless Function: /api/cron-weekly-scorecard
// Runs every Monday at 9AM CST (14:00 UTC). Pulls key growth and activity metrics
// from Supabase and sends a plain-English weekly scorecard to Heath via Claudy.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: 0 14 * * 1  (Monday 9AM CST / 14:00 UTC)
//
// Environment:
//   SUPABASE_URL                 — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY    — service-role JWT
//   TELEGRAM_BOT_TOKEN           — Claudy bot token for Heath alerts
//   TELEGRAM_CHAT_ID             — Heath's Telegram chat ID
//   CRON_SECRET                  — bearer token for manual auth

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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

async function fetchMetrics() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Founding member count (active founding subscriptions)
  const foundingRes = await supabaseFetch(
    '/rest/v1/subscriptions?status=eq.active&plan=eq.founding&select=id,created_at'
  );
  const foundingRows = (foundingRes.ok && Array.isArray(foundingRes.data)) ? foundingRes.data : [];
  const founding_count = foundingRows.length;
  const new_this_week = foundingRows.filter(r => r.created_at >= sevenDaysAgo).length;

  // Friend-tier count for MRR calc
  const friendRes = await supabaseFetch(
    '/rest/v1/subscriptions?status=eq.active&plan=neq.founding&select=id'
  );
  const friend_count = (friendRes.ok && Array.isArray(friendRes.data)) ? friendRes.data.length : 0;

  const mrr = (founding_count * 29) + (friend_count * 1);

  // Social posts published this week
  const socialRes = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id`
  );
  const social_posted = (socialRes.ok && Array.isArray(socialRes.data)) ? socialRes.data.length : 0;

  // FB group posts published this week
  const groupRes = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id`
  );
  const fb_group_posted = (groupRes.ok && Array.isArray(groupRes.data)) ? groupRes.data.length : 0;

  // Twitter engagements sent this week
  const twitterRes = await supabaseFetch(
    `/rest/v1/twitter_engagements?status=eq.posted&posted_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id`
  );
  const twitter_engagements = (twitterRes.ok && Array.isArray(twitterRes.data)) ? twitterRes.data.length : 0;

  return {
    founding_count,
    new_this_week,
    mrr,
    social_posted,
    fb_group_posted,
    twitter_engagements,
  };
}

function buildSummaryLine(founding_count, new_this_week) {
  const spots_left = 50 - founding_count;

  if (new_this_week > 0) {
    const weeks_to_fill = Math.ceil(spots_left / new_this_week);
    return `On track to fill founding spots in ~${weeks_to_fill} week${weeks_to_fill === 1 ? '' : 's'} at current pace.`;
  }

  return `No new members this week - check FB group posts and referral email.`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cron-weekly-scorecard] Telegram not configured');
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[cron-weekly-scorecard] Telegram failed:', res.status, t.slice(0, 200));
    }
  } catch (err) {
    console.error('[cron-weekly-scorecard] Telegram threw:', err && err.message);
  }
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

  console.log('[cron-weekly-scorecard] starting at', new Date().toISOString());

  let metrics;
  try {
    metrics = await fetchMetrics();
  } catch (err) {
    console.error('[cron-weekly-scorecard] fetchMetrics failed:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Failed to fetch metrics: ' + String(err && err.message || err) });
  }

  console.log('[cron-weekly-scorecard] metrics:', metrics);

  const {
    founding_count,
    new_this_week,
    mrr,
    social_posted,
    fb_group_posted,
    twitter_engagements,
  } = metrics;

  const spots_left = 50 - founding_count;
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/Chicago',
  });

  const summaryLine = buildSummaryLine(founding_count, new_this_week);

  const message = [
    `<b>WEEKLY SCORECARD - ${dateStr}</b>`,
    '',
    `Founding members: ${founding_count} / 50 (${spots_left} spot${spots_left === 1 ? '' : 's'} left)`,
    `MRR: $${mrr}`,
    `New this week: ${new_this_week} member${new_this_week === 1 ? '' : 's'}`,
    '',
    `Social posts published: ${social_posted}`,
    `FB group posts: ${fb_group_posted}`,
    `Twitter engagements sent: ${twitter_engagements}`,
    '',
    summaryLine,
  ].join('\n');

  await sendTelegram(message);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    metrics,
    message_sent: true,
  });
};
