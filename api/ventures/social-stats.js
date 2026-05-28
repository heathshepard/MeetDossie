/**
 * GET /api/ventures/social-stats
 * Social media performance metrics for the ventures dashboard.
 * Queries social_posts table for the last 7 days.
 *
 * Auth: Bearer token via Supabase JWT — heath emails only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
]);

const ALLOWED_ORIGINS = new Set(['https://meetdossie.com', 'https://www.meetdossie.com']);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return AUTHORIZED_EMAILS.has(u.email) ? u : null;
}

const PLATFORM_LABELS = {
  facebook: 'Facebook',
  twitter: 'Twitter',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
};

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Pull all posts from the last 7 days — select only what we need
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const r = await supa(
      `social_posts?select=id,status,platform,created_at,posted_at&created_at=gte.${encodeURIComponent(sevenDaysAgo)}&limit=500`
    );
    if (!r.ok) {
      const err = await r.text();
      console.error('[ventures/social-stats] supabase error:', err);
      return res.status(500).json({ error: 'Failed to fetch social posts' });
    }
    const posts = await r.json();

    // --- Rollup by status ---
    const byStatus = {};
    for (const p of posts) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    }

    const totalThisWeek = posts.length;
    const totalPosted = byStatus.posted || 0;
    const totalApproved = (byStatus.approved || 0) + totalPosted;
    const totalRejected = byStatus.rejected || 0;
    const totalDraft = byStatus.draft || 0;
    const totalFailed = byStatus.failed || 0;
    const totalPendingVideo = byStatus.pending_video || 0;

    // --- Posted Today: posts with status='posted' and posted_at (or created_at) in last 24h ---
    const postedToday = posts.filter(p => {
      if (p.status !== 'posted') return false;
      const ts = p.posted_at || p.created_at;
      return ts && ts >= oneDayAgo;
    }).length;

    // --- In Queue: drafts + approved (ready to post or waiting approval) ---
    const inQueue = (byStatus.draft || 0) + (byStatus.approved || 0);

    const approvalRate = totalApproved + totalRejected > 0
      ? Math.round((totalApproved / (totalApproved + totalRejected)) * 100)
      : null;

    const rejectionRate = totalApproved + totalRejected > 0
      ? Math.round((totalRejected / (totalApproved + totalRejected)) * 100)
      : null;

    // --- Rollup by platform (from platform field — may be array or string) ---
    const byPlatform = {};
    for (const p of posts) {
      if (!p.platform) continue;
      // platform field is a text value like 'facebook' or could be an array
      const platforms = Array.isArray(p.platform) ? p.platform : [p.platform];
      for (const plat of platforms) {
        if (plat) byPlatform[plat] = (byPlatform[plat] || 0) + 1;
      }
    }

    const platformBreakdown = Object.entries(byPlatform)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({
        platform: key,
        label: PLATFORM_LABELS[key] || key,
        count,
      }));

    // --- All-time posted count (quick total for context) ---
    const allTimeRes = await supa('social_posts?select=id&status=eq.posted&limit=1&prefer=count=exact');
    const allTimeCount = allTimeRes.ok
      ? Number(allTimeRes.headers.get('content-range')?.split('/')?.[1] || 0)
      : null;

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      weekWindow: '7 days',
      totalThisWeek,
      totalPosted,
      totalDraft,
      totalFailed,
      totalPendingVideo,
      postedToday,
      inQueue,
      approvalRate,
      rejectionRate,
      byStatus,
      platformBreakdown,
      allTimePosted: allTimeCount,
    });
  } catch (err) {
    console.error('[ventures/social-stats] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
