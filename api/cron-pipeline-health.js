// Vercel Serverless Function: /api/cron-pipeline-health
// Daily morning health check at 7AM CST (13:00 UTC).
// Sends a Telegram message to Heath showing today's scheduled posts,
// their status, and flags anything that looks wrong before publish cron runs.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR Vercel cron header
// Schedule: vercel.json — 0 13 * * * (7AM CST)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
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
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[pipeline-health] TELEGRAM_BOT_TOKEN not set');
    return false;
  }
  if (!TELEGRAM_CHAT_ID) {
    console.error('[pipeline-health] TELEGRAM_CHAT_ID not set');
    return false;
  }

  try {
    console.log('[pipeline-health] Sending Telegram message...');
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
    const respText = await res.text();
    if (!res.ok) {
      console.error('[pipeline-health] Telegram send failed:', res.status, respText.slice(0, 200));
      return false;
    }
    console.log('[pipeline-health] Telegram message sent successfully');
    return true;
  } catch (err) {
    console.error('[pipeline-health] Telegram error:', err && err.message);
    return false;
  }
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
  const now = new Date();

  // Draft posts stuck waiting for approval (sent >2 hours ago)
  if (post.status === 'draft' && post.telegram_sent_at) {
    const sentAt = new Date(post.telegram_sent_at);
    const hoursWaiting = (now - sentAt) / (1000 * 60 * 60);
    if (hoursWaiting > 2) {
      issues.push(`🚨 STUCK in draft for ${Math.floor(hoursWaiting)}h — needs approval`);
    }
  }

  // Draft posts never sent for approval (orphaned)
  if (post.status === 'draft' && !post.telegram_sent_at) {
    const createdAt = new Date(post.created_at);
    const hoursOld = (now - createdAt) / (1000 * 60 * 60);
    if (hoursOld > 1) {
      issues.push(`🚨 MISSED — draft ${Math.floor(hoursOld)}h old, never sent for approval`);
    }
  }

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

module.exports = withTelemetry('cron-pipeline-health', async function handler(req, res) {
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

  // ─── Dead Letter Queue + Aging Alert (Improvement 4) ─────────────────────
  // Run three staleness queries and send a single Telegram alert if anything
  // is stuck. Only sends when there's actual work to flag — no noise on clean days.
  const dlqLines = [];

  // 1. Drafts aging out (>36 hours, still draft)
  const { data: agingDrafts } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&created_at=lt.${new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()}&select=post_id,platform,created_at&order=created_at.asc&limit=20`,
  );
  if (Array.isArray(agingDrafts) && agingDrafts.length > 0) {
    const platforms = agingDrafts.map((p) => p.platform).join(', ');
    dlqLines.push(`- ${agingDrafts.length} draft${agingDrafts.length === 1 ? '' : 's'} aging out (>36h): ${platforms}`);
  }

  // 2. Failed posts in the last 48 hours (not yet retried)
  const { data: failedPosts } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.failed&created_at=gt.${new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()}&select=post_id,platform,posted_at&order=created_at.desc&limit=20`,
  );
  if (Array.isArray(failedPosts) && failedPosts.length > 0) {
    const platforms = failedPosts.map((p) => p.platform).join(', ');
    dlqLines.push(`- ${failedPosts.length} failed post${failedPosts.length === 1 ? '' : 's'} need retry: ${platforms}`);
  }

  // 3. Videos stuck in pending_heath_review for >24 hours
  const { data: stuckVideos } = await supabaseFetch(
    `/rest/v1/video_library?status=eq.pending_heath_review&created_at=lt.${new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}&select=id,topic,created_at&order=created_at.asc&limit=10`,
  );
  if (Array.isArray(stuckVideos) && stuckVideos.length > 0) {
    const ids = stuckVideos.map((v) => v.topic || v.id).join(', ');
    dlqLines.push(`- ${stuckVideos.length} video${stuckVideos.length === 1 ? '' : 's'} awaiting your review: ${ids}`);
  }

  if (dlqLines.length > 0) {
    const dlqMessage = `Pipeline health check:\n${dlqLines.join('\n')}`;
    await sendTelegram(dlqMessage);
    console.log('[pipeline-health] DLQ alert sent:', dlqLines.join(' | '));
  } else {
    console.log('[pipeline-health] DLQ check clean — no aging/failed/stuck items');
  }

  return res.status(200).json({
    ok: true,
    posts: posts.length,
    issues: totalIssues,
    telegram_sent: sent,
    dlq: {
      aging_drafts: Array.isArray(agingDrafts) ? agingDrafts.length : 0,
      failed_posts: Array.isArray(failedPosts) ? failedPosts.length : 0,
      stuck_videos: Array.isArray(stuckVideos) ? stuckVideos.length : 0,
    },
  });
});
