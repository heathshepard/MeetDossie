// Vercel Serverless Function: /api/cron-daily-platform-health
// Daily platform health check — runs at 3:00 AM UTC (10 PM CDT (checks previous day's posting cycle)).
// Queries social_posts for each platform to detect missed posting days,
// diagnose root causes, and report queue depth for the next day.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 3 * * *

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Health alerts route through Claudy bot (TELEGRAM_BOT_TOKEN) so Cole's plugin sees them.
// Approve/reject callbacks for individual posts still use TELEGRAM_MARKETING_BOT_TOKEN elsewhere.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const PLATFORMS = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok'];

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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  // Label the message so Heath (and Cole) recognize that the alert originates
  // from the marketing-bot health system even though it's delivered via Claudy.
  const labeled = `📊 <b>DossieMarketingBot — Platform Health</b>\n\n${text}`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: labeled,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[cron-daily-platform-health] telegram send failed:', err && err.message);
  }
}

// Returns yesterday's UTC date range as ISO strings — start and end of UTC day.
function todayUtcRange() {
  const now = new Date();
  // Health check runs at 3 AM UTC — check the previous UTC day's posting cycle.
  const checkDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start = new Date(Date.UTC(checkDay.getUTCFullYear(), checkDay.getUTCMonth(), checkDay.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Returns today's date in CDT (UTC-5 standard / UTC-6 standard — use UTC-5 for CDT).
function todayCdtLabel() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
  });
}

async function countPostsByStatus(platform, statuses, start, end) {
  const filter = `platform=eq.${encodeURIComponent(platform)}` +
    `&status=in.(${statuses.join(',')})` +
    `&created_at=gte.${encodeURIComponent(start)}` +
    `&created_at=lte.${encodeURIComponent(end)}` +
    `&select=id`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data.length : 0;
}

async function countPostedToday(platform, start, end) {
  const filter = `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.posted` +
    `&posted_at=gte.${encodeURIComponent(start)}` +
    `&posted_at=lte.${encodeURIComponent(end)}` +
    `&select=id`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data.length : 0;
}

// Count all approved posts across all platforms (queue for next publish window).
async function countTotalApproved() {
  const { data, ok } = await supabaseFetch('/rest/v1/social_posts?status=eq.approved&select=id,platform');
  if (!ok || !Array.isArray(data)) return { total: 0, byPlatform: {} };
  const byPlatform = {};
  for (const row of data) {
    byPlatform[row.platform] = (byPlatform[row.platform] || 0) + 1;
  }
  return { total: data.length, byPlatform };
}

// Check if today's content_batches row exists (indicates generate cron ran).
async function didBatchRun(start) {
  const { data, ok } = await supabaseFetch(
    `/rest/v1/content_batches?generated_at=gte.${encodeURIComponent(start)}&select=id,post_count&limit=1`,
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return { ran: false, postCount: 0 };
  return { ran: true, postCount: data[0].post_count || 0 };
}

module.exports = withTelemetry('cron-daily-platform-health', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const { start, end } = todayUtcRange();
  const dateLabel = todayCdtLabel();

  // Check batch run status
  const batch = await didBatchRun(start);

  // Per-platform health check
  const platformResults = [];
  for (const platform of PLATFORMS) {
    const posted = await countPostedToday(platform, start, end);
    let cause = null;
    if (posted === 0) {
      const rejected = await countPostsByStatus(platform, ['rejected'], start, end);
      const pendingVideo = await countPostsByStatus(platform, ['pending_video'], start, end);
      const failed = await countPostsByStatus(platform, ['failed'], start, end);
      const draft = await countPostsByStatus(platform, ['draft', 'approved'], start, end);

      if (!batch.ran) {
        cause = 'generate cron did not run today';
      } else if (rejected > 0 && pendingVideo === 0 && failed === 0 && draft === 0) {
        cause = `${rejected} posts auto-rejected, none passed to queue`;
      } else if (pendingVideo > 0) {
        cause = `${pendingVideo} posts waiting for video (DONE pipeline)`;
      } else if (failed > 0) {
        cause = `${failed} posts failed to publish (Zernio error)`;
      } else if (draft > 0) {
        cause = `${draft} posts in draft/approved — not yet published (schedule gate?)`;
      } else {
        cause = '0 posts generated for this platform today';
      }
    }
    platformResults.push({ platform, posted, cause });
  }

  // Approved queue depth
  const { total: totalApproved, byPlatform: approvedByPlatform } = await countTotalApproved();

  // Build report
  const missed = platformResults.filter(p => p.posted === 0);
  const posted = platformResults.filter(p => p.posted > 0);

  // All healthy short-circuit
  if (missed.length === 0 && totalApproved >= 4) {
    const lines = [
      `PLATFORM HEALTH ${dateLabel} CDT`,
      '',
      'All platforms posted today.',
      '',
      `QUEUED FOR TOMORROW: ${totalApproved} approved posts`,
    ];
    await sendTelegram(lines.join('\n'));
    return res.status(200).json({ ok: true, allHealthy: true, totalApproved });
  }

  const lines = [`<b>PLATFORM HEALTH ${dateLabel} CDT</b>`, ''];

  if (missed.length > 0) {
    lines.push('<b>MISSED TODAY:</b>');
    for (const p of missed) {
      lines.push(`- ${p.platform}: 0 posts published`);
      lines.push(`  Cause: ${p.cause}`);
    }
    lines.push('');
  }

  if (posted.length > 0) {
    lines.push('<b>POSTED TODAY:</b>');
    for (const p of posted) {
      lines.push(`- ${p.platform}: ${p.posted}`);
    }
    lines.push('');
  }

  lines.push(`<b>QUEUED FOR TOMORROW:</b> ${totalApproved} approved posts`);

  if (missed.length > 0) {
    lines.push('');
    lines.push('<b>ACTION NEEDED:</b>');
    for (const p of missed) {
      if (!batch.ran) {
        lines.push(`- ${p.platform}: trigger /api/cron-generate-posts manually`);
      } else if (p.cause && p.cause.includes('auto-rejected')) {
        lines.push(`- ${p.platform}: check verifier — posts being rejected. Review cron-generate-posts logs.`);
      } else if (p.cause && p.cause.includes('video')) {
        lines.push(`- ${p.platform}: send DONE after recording to attach video and publish`);
      } else if (p.cause && p.cause.includes('failed')) {
        lines.push(`- ${p.platform}: Zernio error — check cron-publish-approved logs`);
      } else {
        lines.push(`- ${p.platform}: ${p.cause}`);
      }
    }
  }

  await sendTelegram(lines.join('\n'));

  // Queue warning — separate message if queue is critically low
  if (totalApproved < 4) {
    const emptyPlatforms = PLATFORMS.filter(p => !approvedByPlatform[p]);
    const warnLines = [
      `<b>QUEUE WARNING:</b> Only ${totalApproved} posts approved for tomorrow.`,
      `Platforms empty: ${emptyPlatforms.join(', ') || 'none'}`,
      'Generate cron fires 6 AM CDT.',
    ];
    await sendTelegram(warnLines.join('\n'));
  }

  return res.status(200).json({
    ok: true,
    date: dateLabel,
    missed: missed.length,
    posted: posted.length,
    totalApproved,
    batch,
    platformResults,
  });
});
