// Update posting_schedule caps
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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const results = [];

  // Update Facebook to max_per_day=3
  const fbUpdate = await supabaseFetch(
    '/rest/v1/posting_schedule?platform=eq.facebook',
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ max_per_day: 3 }),
    }
  );
  results.push({
    platform: 'facebook',
    action: 'update_cap',
    ok: fbUpdate.ok,
    rows_updated: Array.isArray(fbUpdate.data) ? fbUpdate.data.length : 0,
  });

  // Update Twitter to max_per_day=3
  const twUpdate = await supabaseFetch(
    '/rest/v1/posting_schedule?platform=eq.twitter',
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ max_per_day: 3 }),
    }
  );
  results.push({
    platform: 'twitter',
    action: 'update_cap',
    ok: twUpdate.ok,
    rows_updated: Array.isArray(twUpdate.data) ? twUpdate.data.length : 0,
  });

  // Count approved posts
  const { data: fbPosts } = await supabaseFetch(
    '/rest/v1/social_posts?platform=eq.facebook&status=eq.approved&select=id'
  );
  const { data: twPosts } = await supabaseFetch(
    '/rest/v1/social_posts?platform=eq.twitter&status=eq.approved&select=id'
  );

  results.push({
    platform: 'facebook',
    action: 'count_approved',
    count: Array.isArray(fbPosts) ? fbPosts.length : 0,
  });

  results.push({
    platform: 'twitter',
    action: 'count_approved',
    count: Array.isArray(twPosts) ? twPosts.length : 0,
  });

  // Verify final state
  const { data: schedules } = await supabaseFetch(
    '/rest/v1/posting_schedule?is_active=eq.true&select=platform,max_per_day&order=platform.asc'
  );

  return res.status(200).json({
    ok: true,
    results,
    final_state: schedules || [],
  });
};
