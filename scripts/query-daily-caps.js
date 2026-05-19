// Query actual posted counts vs caps
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
  console.log('=== CHECKING POSTED COUNTS VS CAPS ===\n');

  // Get all platforms from posting_schedule
  const { data: schedules } = await supabaseFetch(
    '/rest/v1/posting_schedule?is_active=eq.true&select=platform,max_per_day'
  );

  const today = new Date().toISOString().slice(0, 10);
  const startOfDayUtc = new Date(`${today}T00:00:00`).toISOString();
  const endOfDayUtc = new Date(`${today}T23:59:59.999`).toISOString();

  console.log(`Today: ${today}`);
  console.log(`Start: ${startOfDayUtc}`);
  console.log(`End: ${endOfDayUtc}\n`);

  for (const sched of schedules || []) {
    const platform = sched.platform;
    const cap = sched.max_per_day;

    // Count posted today
    const { data: postedToday } = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}&status=eq.posted&posted_at=gte.${encodeURIComponent(startOfDayUtc)}&posted_at=lte.${encodeURIComponent(endOfDayUtc)}&select=id,post_id,posted_at`
    );

    // Count approved waiting
    const { data: approved } = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}&status=eq.approved&select=id`
    );

    const postedCount = Array.isArray(postedToday) ? postedToday.length : 0;
    const approvedCount = Array.isArray(approved) ? approved.length : 0;

    console.log(`${platform.toUpperCase()}:`);
    console.log(`  Posted today: ${postedCount}/${cap}`);
    console.log(`  Approved waiting: ${approvedCount}`);

    if (postedCount > 0 && Array.isArray(postedToday)) {
      console.log(`  Posts:`);
      for (const post of postedToday) {
        console.log(`    - ${post.post_id} at ${post.posted_at}`);
      }
    }

    if (postedCount < cap && approvedCount > 0) {
      console.log(`  ⚠️ BUG: Cap not reached but posts are waiting!`);
    } else if (postedCount >= cap) {
      console.log(`  ✅ Cap reached - correctly blocking`);
    }

    console.log('');
  }
}

main().catch(console.error);
