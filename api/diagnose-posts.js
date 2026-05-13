// Emergency diagnostic endpoint
// GET /api/diagnose-posts?secret=CRON_SECRET

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
  return { ok: res.ok, status: res.status, data, text };
}

export default async function handler(req, res) {
  // Auth check
  const secret = req.query.secret;
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    // Get today's UTC date range
    const now = new Date();
    const todayStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0, 0, 0
    )).toISOString();

    // Get all posts from today
    const { data: allPosts, ok: loadOk } = await supabaseFetch(
      `/rest/v1/social_posts?created_at=gte.${encodeURIComponent(todayStart)}&order=created_at.asc&select=id,platform,status,persona,hook,created_at,telegram_sent_at,approved_at,posted_at,publishing_started_at,error_message,zernio_account_id,media_url`
    );

    if (!loadOk || !Array.isArray(allPosts)) {
      return res.status(502).json({
        ok: false,
        error: 'Failed to load posts',
        supabase_url: SUPABASE_URL,
      });
    }

    // Get posting schedule for context
    const { data: schedules } = await supabaseFetch(
      `/rest/v1/posting_schedule?is_active=eq.true&select=platform,day_of_week,time_slots,timezone,max_per_day`
    );

    // Check for posts already posted today (for cap calculation)
    const postedTodayFilter = `posted_at=gte.${encodeURIComponent(todayStart)}&status=eq.posted&select=platform,posted_at`;
    const { data: postedToday } = await supabaseFetch(`/rest/v1/social_posts?${postedTodayFilter}`);

    // Count by platform
    const postedCounts = {};
    if (Array.isArray(postedToday)) {
      postedToday.forEach(p => {
        postedCounts[p.platform] = (postedCounts[p.platform] || 0) + 1;
      });
    }

    // Analyze posts
    const report = {
      timestamp: now.toISOString(),
      total_posts_today: allPosts.length,
      by_status: {},
      posts: allPosts.map(p => ({
        id: p.id,
        platform: p.platform,
        status: p.status,
        persona: p.persona,
        hook: p.hook ? p.hook.substring(0, 50) + '...' : null,
        created_at: p.created_at,
        telegram_sent_at: p.telegram_sent_at,
        approved_at: p.approved_at,
        posted_at: p.posted_at,
        publishing_started_at: p.publishing_started_at,
        error_message: p.error_message,
        has_zernio_account: !!p.zernio_account_id,
        has_media: !!p.media_url,
      })),
      schedules: Array.isArray(schedules) ? schedules : [],
      posted_today_counts: postedCounts,
    };

    // Count by status
    allPosts.forEach(p => {
      report.by_status[p.status] = (report.by_status[p.status] || 0) + 1;
    });

    // Flag issues
    const issues = [];

    const approvedPosts = allPosts.filter(p => p.status === 'approved');
    if (approvedPosts.length > 0) {
      issues.push(`${approvedPosts.length} posts are approved but not yet posted`);
    }

    const failedPosts = allPosts.filter(p => p.status === 'failed');
    if (failedPosts.length > 0) {
      issues.push(`${failedPosts.length} posts failed: ${failedPosts.map(p => `${p.platform}: ${p.error_message || 'no error msg'}`).join('; ')}`);
    }

    const draftPosts = allPosts.filter(p => p.status === 'draft');
    if (draftPosts.length > 0) {
      issues.push(`${draftPosts.length} posts still in draft`);
    }

    const missingAccounts = allPosts.filter(p => !p.zernio_account_id && p.status === 'approved');
    if (missingAccounts.length > 0) {
      issues.push(`${missingAccounts.length} approved posts missing zernio_account_id`);
    }

    report.issues = issues;

    return res.status(200).json(report);

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
    });
  }
}
