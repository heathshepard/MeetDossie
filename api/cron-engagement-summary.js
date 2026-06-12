const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// api/cron-engagement-summary.js
//
// Daily 9 AM CDT digest for the unified engagement scanner.
// Sends Heath a one-message snapshot via Claudy:
//   - candidates found in the last 24h (by platform)
//   - approvals + posts in the last 24h
//   - current queue depth at each status
//   - any rows stuck in 'posting' for more than 15 minutes (poster crash)
//
// Schedule: cron-job.org daily 14:00 UTC (= 9 AM CDT).
// Auth: Bearer ${CRON_SECRET}.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;   // Claudy
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

async function sbFetch(urlPath) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function countWhere(filter) {
  const path = `/rest/v1/engagement_candidates?select=id&${filter}`;
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const contentRange = res.headers.get('content-range') || '';
  const m = contentRange.match(/\/(\d+|\*)$/);
  if (m && m[1] !== '*') return parseInt(m[1], 10) || 0;
  // Fallback: parse body
  const body = await res.text();
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function platformCount(platform, sinceIso) {
  return countWhere(`platform=eq.${platform}&created_at=gte.${encodeURIComponent(sinceIso)}`);
}

async function statusCount(status) {
  return countWhere(`status=eq.${status}`);
}

async function postedSince(sinceIso) {
  return countWhere(`status=eq.posted&approved_at=gte.${encodeURIComponent(sinceIso)}`);
}

async function approvedSince(sinceIso) {
  return countWhere(`status=in.(approved,posted)&approved_at=gte.${encodeURIComponent(sinceIso)}`);
}

async function stuckPosting() {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  return countWhere(`status=eq.posting&updated_at=lt.${encodeURIComponent(since)}`);
}

module.exports = withTelemetry('cron-engagement-summary', async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(500).json({ error: 'Telegram env not configured' });
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    fb, ig, li, rd,
    pending, drafted, sent, approved,
    postedToday, approvedToday, stuck,
  ] = await Promise.all([
    platformCount('facebook', since24h),
    platformCount('instagram', since24h),
    platformCount('linkedin', since24h),
    platformCount('reddit', since24h),
    statusCount('pending'),
    statusCount('drafted'),
    statusCount('sent_for_approval'),
    statusCount('approved'),
    postedSince(since24h),
    approvedSince(since24h),
    stuckPosting(),
  ]);

  const lines = [
    'Engagement scanner -- last 24h:',
    `  Found: ${fb} FB / ${ig} IG / ${li} LI / ${rd} Reddit`,
    `  Approvals: ${approvedToday}  Posted: ${postedToday}`,
    '',
    'Current queue:',
    `  ${pending} pending Sage draft`,
    `  ${drafted} drafted, waiting for next approval send`,
    `  ${sent} awaiting your Telegram tap`,
    `  ${approved} approved, waiting for poster`,
  ];
  if (stuck > 0) {
    lines.push('', `WARNING: ${stuck} rows stuck in 'posting' >15 min. Poster crashed?`);
  }

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: lines.join('\n'),
      disable_web_page_preview: true,
    }),
  });

  return res.status(200).json({
    ok: true,
    found_24h: { fb, ig, li, rd },
    queue: { pending, drafted, sent_for_approval: sent, approved },
    posted_24h: postedToday,
    approved_24h: approvedToday,
    stuck,
  });
});
