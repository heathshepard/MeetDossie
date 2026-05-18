// Update posting_schedule caps and reset approved posts
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

async function main() {
  console.log('=== UPDATING POSTING SCHEDULE CAPS ===\n');

  // Update Facebook to max_per_day=3
  const fbUpdate = await supabaseFetch(
    '/rest/v1/posting_schedule?platform=eq.facebook',
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ max_per_day: 3 }),
    }
  );
  console.log('Facebook update:', fbUpdate.ok ? 'SUCCESS' : 'FAILED', fbUpdate.status);
  if (fbUpdate.data) console.log('  Updated rows:', fbUpdate.data.length);

  // Update Twitter to max_per_day=3
  const twUpdate = await supabaseFetch(
    '/rest/v1/posting_schedule?platform=eq.twitter',
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ max_per_day: 3 }),
    }
  );
  console.log('Twitter update:', twUpdate.ok ? 'SUCCESS' : 'FAILED', twUpdate.status);
  if (twUpdate.data) console.log('  Updated rows:', twUpdate.data.length);

  console.log('\n=== RESETTING APPROVED POSTS ===\n');

  // "Reset" means setting them back to approved status if they were in some other state,
  // but they're already approved. So this is a no-op unless we need to clear some field.
  // Actually, approved posts are already eligible - they just hit the cap.
  // So this is already done - they'll publish when caps allow.

  // But let's show current approved counts:
  const { data: fbPosts } = await supabaseFetch(
    '/rest/v1/social_posts?platform=eq.facebook&status=eq.approved&select=id'
  );
  const { data: twPosts } = await supabaseFetch(
    '/rest/v1/social_posts?platform=eq.twitter&status=eq.approved&select=id'
  );

  console.log('Facebook approved posts ready:', Array.isArray(fbPosts) ? fbPosts.length : 0);
  console.log('Twitter approved posts ready:', Array.isArray(twPosts) ? twPosts.length : 0);

  console.log('\n=== VERIFICATION ===\n');

  const { data: schedules } = await supabaseFetch(
    '/rest/v1/posting_schedule?is_active=eq.true&select=platform,max_per_day&order=platform.asc'
  );

  if (schedules) {
    for (const s of schedules) {
      console.log(`${s.platform.padEnd(12)} max_per_day=${s.max_per_day}`);
    }
  }
}

main().catch(console.error);
