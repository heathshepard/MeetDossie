// Vercel Serverless Function: /api/cron-pipeline-health
// Daily morning health check at 7AM CST (13:00 UTC).
// Sends a Telegram message to Heath showing today's scheduled posts,
// their status, and flags anything that looks wrong before publish cron runs.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR Vercel cron header
// Schedule: vercel.json — 0 13 * * * (7AM CST)

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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function sendTelegram(text) {
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
  return res.ok;
}

function formatTime(isoString) {
  if (!isoString) return 'not set';
  const d = new Date(isoString);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Chicago' });
}

function statusEmoji(status) {
  if (status === 'draft') return '📝';
  if (status === 'approved') return '✅';
  if (status === 'posted') return '🟢';
  if (status === 'failed') return '❌';
  if (status === 'rejected') return '🚫';
  if (status === 'pending_video') return '⏸️';
  return '❓';
}

function flagIssues(post) {
  const issues = [];

  // Approved but no telegram_sent_at means it was never sent for approval
  if (post.status === 'approved' && !post.telegram_sent_at) {
    issues.push('⚠️ Approved without approval message sent');
  }

  // Failed with no error_message
  if (post.status === 'failed' && !post.error_message) {
    issues.push('🚨 Failed but error_message is NULL');
  }

  // Has media_url but it's not a valid URL
  if (post.media_url && !post.media_url.startsWith('http')) {
    issues.push('⚠️ Invalid media_url');
  }

  // TikTok not in pending_video
  if (post.platform === 'tiktok' && post.status === 'approved') {
    issues.push('⚠️ TikTok should be pending_video');
  }

  return issues;
}

module.exports = async function handler(req, res) {
  // Auth: accept EITHER Vercel's built-in cron header OR manual Bearer token
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
    return res.status(500).json({ ok: false, error: 'Telegram not configured' });
  }

  const today = new Date().toISOString().split('T')[0];

  // Get all today's posts
  const { data: posts, ok } = await supabaseFetch(
    `/rest/v1/social_posts?created_at=gte.${today}T00:00:00Z&created_at=lt.${today}T23:59:59Z&order=platform.asc,created_at.asc`
  );

  if (!ok || !Array.isArray(posts)) {
    return res.status(502).json({ ok: false, error: 'Failed to load posts' });
  }

  if (posts.length === 0) {
    await sendTelegram('🌅 <b>DAILY PIPELINE HEALTH CHECK</b>\n\nℹ️ No posts scheduled for today.');
    return res.status(200).json({ ok: true, posts: 0 });
  }

  // Group by platform
  const byPlatform = {};
  let totalIssues = 0;

  posts.forEach(post => {
    if (!byPlatform[post.platform]) byPlatform[post.platform] = [];
    const issues = flagIssues(post);
    totalIssues += issues.length;
    byPlatform[post.platform].push({ post, issues });
  });

  // Build message
  const lines = ['🌅 <b>DAILY PIPELINE HEALTH CHECK</b>', ''];

  const summary = [
    `📊 <b>${posts.length} posts scheduled for today</b>`,
    `Status breakdown:`,
  ];

  const statusCounts = {};
  posts.forEach(p => {
    statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
  });

  Object.entries(statusCounts).forEach(([status, count]) => {
    summary.push(`  ${statusEmoji(status)} ${status}: ${count}`);
  });

  if (totalIssues > 0) {
    summary.push(`\n🚨 <b>${totalIssues} ISSUES FLAGGED</b>`);
  } else {
    summary.push(`\n✅ <b>All posts look healthy</b>`);
  }

  lines.push(...summary, '');

  // Platform details
  Object.entries(byPlatform).forEach(([platform, items]) => {
    lines.push(`<b>${platform.toUpperCase()}</b> (${items.length})`);
    items.forEach(({ post, issues }) => {
      const preview = (post.content || '').substring(0, 40).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      lines.push(`  ${statusEmoji(post.status)} ${post.persona || '?'}: "${preview}..."`);
      if (post.approved_at) {
        lines.push(`     Approved: ${formatTime(post.approved_at)}`);
      }
      if (post.posted_at) {
        lines.push(`     Posted: ${formatTime(post.posted_at)}`);
      }
      if (issues.length > 0) {
        issues.forEach(issue => lines.push(`     ${issue}`));
      }
    });
    lines.push('');
  });

  const message = lines.join('\n');
  const sent = await sendTelegram(message);

  return res.status(200).json({
    ok: true,
    posts: posts.length,
    issues: totalIssues,
    telegram_sent: sent
  });
};
