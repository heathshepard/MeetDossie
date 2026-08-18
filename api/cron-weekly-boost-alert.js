'use strict';

// Vercel Serverless Function: /api/cron-weekly-boost-alert
// =============================================================================
// Scoped-down version of the "autonomous FB ads agent" idea from the shared
// marketing video (see memory: dossie-social-marketing-playbook.md item #4).
// The full version needs a real data warehouse + live Marketing API spend
// decisions — too big a lift right now. This is the version that fits the
// current stack: a weekly suggestion, no spend, no API integration.
//
// WHAT IT DOES
//   Ranks organic Meta posts (Facebook + Instagram -- the only platforms
//   actually boostable from Meta Ads Manager) from the last 7 days by real
//   engagement, and sends Heath a Telegram message naming the top 2-3.
//   Heath clicks Boost/Promote himself in Meta Ads Manager if he wants to put
//   spend behind one. This cron never touches the Marketing API and never
//   spends anything -- notification only, same human-approval-gate pattern
//   as every other review cron (nothing here is an action Heath didn't take).
//
// WHY FACEBOOK + INSTAGRAM ONLY
//   Twitter/LinkedIn/TikTok posts aren't boostable from Meta Ads Manager --
//   telling Heath to "boost" one there would send him to the wrong place.
//
// DATA SOURCE
//   post_analytics.engagement_score (Postgres-generated column, populated by
//   cron-analytics-sync.js's weekly Zernio sync) is the source of truth when
//   a post has been synced at least once. Zernio sync and this cron both run
//   Sunday/Monday, so a post published mid-week usually has one snapshot by
//   the time this runs. Posts published very recently -- before their first
//   analytics-sync pass -- fall back to a same-weights composite computed
//   from the inline social_posts.likes/comments/shares/clicks columns (the
//   identical weighting cron-analytics-sync.js already uses for its A/B
//   winner scoring: likes*1 + comments*3 + shares*5 + clicks*2), so a brand
//   new post never blocks silently on "waiting for Sunday."
//
// GRACEFUL DEGRADE
//   No permalink field exists anywhere in the pipeline yet
//   (actual_platform_url is NULL on every row in social_posts today -- not
//   fixed by this cron, flagged as-is). The message instead tells Heath the
//   platform, persona, post date, and opening words of the post so he can
//   find it on the Page himself. If nothing from the last 7 days has any
//   engagement (score 0, or zero FB/IG posts posted at all), the cron sends
//   a one-line "not enough data yet" note instead of a wall of empty stats,
//   and returns 200 -- this is not treated as an error.
//
// Auth:     Authorization: Bearer ${CRON_SECRET} (or Vercel's own cron header)
// Schedule: vercel.json -- Monday 8am CDT (13 UTC), same slot family as
//           cron-weekly-post-review / cron-weekly-scorecard.
// Owner: Atlas, 2026-08-18.
// =============================================================================

require('./_lib/telegram-gate').install('cron-weekly-boost-alert');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BOOSTABLE_PLATFORMS = ['facebook', 'instagram'];
const LOOKBACK_DAYS = 7;
const TOP_N = 3;

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function tgSend(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, skipped: true };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  const respText = await res.text();
  let data = null;
  try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, data, raw: respText };
}

function truncate(s, n) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > n ? str.slice(0, n) + '...' : str;
}

// Same weighting cron-analytics-sync.js uses for A/B winner scoring -- kept
// identical so "top post" means the same thing everywhere in the pipeline.
function inlineScore(row) {
  return (row.likes || 0) * 1 + (row.comments || 0) * 3 + (row.shares || 0) * 5 + (row.clicks || 0) * 2;
}

function formatCandidate(c, rank) {
  const stats = c.fromAnalytics
    ? `${c.likes} likes, ${c.comments} comments, ${c.shares} shares, ${c.views} views, ${c.reach || 0} reach (engagement_score ${c.score})`
    : `${c.likes} likes, ${c.comments} comments, ${c.shares} shares, ${c.clicks} clicks (not yet synced by Zernio -- provisional score ${c.score})`;
  const posted = new Date(c.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return [
    `${rank}. [${c.platform.toUpperCase()}] posted ${posted}${c.persona ? ` (${c.persona})` : ''}`,
    `   "${truncate(c.hook || c.content, 100)}"`,
    `   ${stats}`,
  ].join('\n');
}

async function loadCandidates() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const platformFilter = BOOSTABLE_PLATFORMS.map((p) => `"${p}"`).join(',');

  const { ok, data } = await sb(
    `social_posts?select=id,platform,persona,hook,content,posted_at,likes,comments,shares,clicks,views` +
    `&status=eq.posted&platform=in.(${platformFilter})&posted_at=gte.${since}&order=posted_at.desc&limit=200`,
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return [];

  const ids = data.map((r) => r.id);
  // Pull the most recent post_analytics snapshot per post, if any exist.
  let latestByPost = new Map();
  if (ids.length > 0) {
    const idFilter = ids.map((id) => `"${id}"`).join(',');
    const { ok: aOk, data: aRows } = await sb(
      `post_analytics?select=social_post_id,likes,comments,shares,views,reach,engagement_score,synced_at` +
      `&social_post_id=in.(${idFilter})&order=synced_at.desc&limit=1000`,
    );
    if (aOk && Array.isArray(aRows)) {
      for (const r of aRows) {
        if (!latestByPost.has(r.social_post_id)) latestByPost.set(r.social_post_id, r);
      }
    }
  }

  return data.map((row) => {
    const a = latestByPost.get(row.id);
    if (a) {
      return {
        ...row,
        fromAnalytics: true,
        likes: a.likes,
        comments: a.comments,
        shares: a.shares,
        views: a.views,
        reach: a.reach,
        score: Number(a.engagement_score || 0),
      };
    }
    return {
      ...row,
      fromAnalytics: false,
      score: inlineScore(row),
    };
  });
}

module.exports = withTelemetry('cron-weekly-boost-alert', async function handler(req, res) {
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
    console.error('[cron-weekly-boost-alert] Telegram env not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }

  let candidates;
  try {
    candidates = await loadCandidates();
  } catch (err) {
    console.error('[cron-weekly-boost-alert] failed to load candidates:', err && err.message);
    return res.status(502).json({ ok: false, error: 'failed to load social_posts/post_analytics' });
  }

  const withEngagement = candidates.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  const top = withEngagement.slice(0, TOP_N);

  if (top.length === 0) {
    const reason = candidates.length === 0
      ? `No Facebook/Instagram posts went out in the last ${LOOKBACK_DAYS} days.`
      : `${candidates.length} FB/IG post(s) went out this week but none has measurable engagement yet.`;
    const msg = [
      'WEEKLY BOOST CHECK',
      '',
      reason,
      'Nothing to suggest boosting this week.',
    ].join('\n');
    const sendRes = await tgSend(msg);
    console.log('[cron-weekly-boost-alert] no candidates — sent notice:', sendRes.ok);
    return res.status(200).json({ ok: true, candidates: candidates.length, suggested: 0 });
  }

  const lines = [
    'WEEKLY BOOST CHECK',
    '',
    `Top ${top.length} organic post${top.length > 1 ? 's' : ''} from the last ${LOOKBACK_DAYS} days by engagement.`,
    'These are suggestions only — nothing auto-spends. Find the post on the Page and click Boost/Promote yourself in Meta Ads Manager if you want to put money behind it.',
    '',
    ...top.map((c, i) => formatCandidate(c, i + 1)),
  ];
  const sendRes = await tgSend(lines.join('\n\n'));
  if (!sendRes.ok) {
    console.error('[cron-weekly-boost-alert] telegram send failed:', sendRes.raw?.slice(0, 200));
  }

  return res.status(200).json({
    ok: true,
    candidates: candidates.length,
    suggested: top.length,
    telegram_sent: !!sendRes.ok,
    top: top.map((c) => ({ id: c.id, platform: c.platform, score: c.score, posted_at: c.posted_at })),
  });
});
