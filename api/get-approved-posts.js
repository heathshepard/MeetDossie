// GET /api/get-approved-posts
// Returns all approved posts ready to publish (for n8n workflow)
// Auth: Authorization: Bearer ${CRON_SECRET}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const HCTI_USER_ID = process.env.HCTI_USER_ID;
const HCTI_API_KEY = process.env.HCTI_API_KEY;

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

async function generateCardWithHCTI(post) {
  if (!HCTI_USER_ID || !HCTI_API_KEY) {
    throw new Error('HCTI credentials not configured');
  }

  const hook = (post.content || '').slice(0, 200);
  const stat = '';
  const statLabel = '';

  const html = `
    <div style="width: 1080px; height: 1080px; background: #F5E6E0; font-family: 'Cormorant Garamond', Georgia, serif; display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 80px; box-sizing: border-box; position: relative;">
      <div style="position: absolute; top: 0; left: 0; right: 0; height: 12px; background: linear-gradient(90deg, #E8836B 0%, #D4A0A0 100%);"></div>
      <div style="text-align: center; margin-bottom: 60px;">
        <div style="font-size: 72px; font-weight: 600; line-height: 1.2; color: #1A1A2E; margin-bottom: 40px;">${hook}</div>
      </div>
      <div style="text-align: center; margin-top: auto;">
        <div style="font-size: 120px; font-weight: 700; color: #C9A96E; margin-bottom: 20px;">${stat}</div>
        <div style="font-size: 42px; color: #1A1A2E; opacity: 0.8;">${statLabel}</div>
      </div>
      <div style="position: absolute; bottom: 60px; left: 0; right: 0; text-align: center; font-size: 36px; color: #1A1A2E; opacity: 0.6;">meetdossie.com</div>
    </div>
  `;

  const hctiRes = await fetch('https://hcti.io/v1/image', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${HCTI_USER_ID}:${HCTI_API_KEY}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ html }),
  });

  if (!hctiRes.ok) {
    throw new Error(`HCTI API error: ${hctiRes.status}`);
  }

  const hctiData = await hctiRes.json();
  return hctiData.url;
}

export default async function handler(req, res) {
  // Auth check
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    // Get daily caps from posting_schedule (use defaults if fails)
    const { data: schedule, ok: scheduleOk, status: scheduleStatus } = await supabaseFetch('/rest/v1/posting_schedule?select=platform,max_per_day&is_active=eq.true');

    // Get today's posted counts per platform
    const { data: postedToday, ok: postedOk, status: postedStatus } = await supabaseFetch(`/rest/v1/social_posts?select=platform&status=eq.posted&posted_at=gte.${today}T00:00:00`);

    if (!postedOk) {
      return res.status(502).json({ ok: false, error: 'Failed to load posted counts', status: postedStatus, data: postedToday });
    }

    // Build platform cap map with defaults if schedule query failed
    const platformCaps = {};
    const platforms = ['facebook', 'twitter', 'instagram', 'linkedin', 'tiktok'];
    const defaultCaps = { facebook: 1, twitter: 2, instagram: 1, linkedin: 1, tiktok: 1 };

    platforms.forEach(platform => {
      let limit = defaultCaps[platform];
      if (scheduleOk && Array.isArray(schedule)) {
        const scheduleEntry = schedule.find(s => s.platform === platform);
        if (scheduleEntry && scheduleEntry.max_per_day !== null) {
          limit = scheduleEntry.max_per_day;
        }
      }
      const posted = Array.isArray(postedToday) ? postedToday.filter(p => p.platform === platform).length : 0;
      platformCaps[platform] = {
        limit,
        posted,
        remaining: Math.max(0, limit - posted),
      };
    });

    // Load approved posts
    const filter = 'status=eq.approved&posted_at=is.null&select=id,post_id,platform,content,media_url,zernio_account_id,hashtags';
    const { data: posts, ok: loadOk, status: loadStatus } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);

    if (!loadOk) {
      return res.status(502).json({ ok: false, error: 'Failed to load approved posts', status: loadStatus, data: posts });
    }

    // Filter posts to only include platforms with remaining capacity
    const allPosts = Array.isArray(posts) ? posts : [];
    const items = allPosts.filter(post => {
      const cap = platformCaps[post.platform];
      return cap && cap.remaining > 0;
    });

    for (const post of items) {
      if (!post.media_url && (post.platform === 'instagram' || post.platform === 'facebook')) {
        try {
          const cardUrl = await generateCardWithHCTI(post);
          post.media_url = cardUrl;

          await supabaseFetch(
            `/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ media_url: cardUrl }),
            }
          );
        } catch (cardError) {
          console.error(`Failed to generate card for ${post.post_id}:`, cardError.message);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      count: items.length,
      posts: items,
      caps: platformCaps,
      filtered: allPosts.length - items.length,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
