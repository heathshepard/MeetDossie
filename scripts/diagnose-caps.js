// Diagnose why posts are hitting daily caps
// Run this to see:
// 1. What the posting_schedule caps are for each platform
// 2. How many posts have been published today for each platform
// 3. List of approved posts waiting to publish

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    console.log('Run with: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node diagnose-caps.js');
    return;
  }

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

  console.log('=== POSTING SCHEDULE (today is Sunday, day_of_week=0) ===\n');

  const { data: schedules } = await supabaseFetch(
    '/rest/v1/posting_schedule?is_active=eq.true&order=platform.asc&select=platform,day_of_week,time_slots,max_per_day,max_per_slot'
  );

  for (const row of schedules || []) {
    console.log(`${row.platform.toUpperCase()}:`);
    console.log(`  Day: ${row.day_of_week} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][row.day_of_week]})`);
    console.log(`  Time slots: ${JSON.stringify(row.time_slots)}`);
    console.log(`  Max per day: ${row.max_per_day}`);
    console.log(`  Max per slot: ${row.max_per_slot}`);
    console.log('');
  }

  console.log('=== POSTS PUBLISHED TODAY ===\n');

  const today = new Date().toISOString().slice(0, 10);
  const startOfDayUtc = new Date(`${today}T00:00:00`).toISOString();
  const endOfDayUtc = new Date(`${today}T23:59:59.999`).toISOString();

  const { data: postedToday } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(startOfDayUtc)}&posted_at=lte.${encodeURIComponent(endOfDayUtc)}&order=posted_at.asc&select=post_id,platform,persona,posted_at`
  );

  if (postedToday && postedToday.length > 0) {
    for (const post of postedToday) {
      console.log(`✅ ${post.platform.padEnd(10)} ${post.persona.padEnd(10)} ${post.posted_at} ${post.post_id}`);
    }
  } else {
    console.log('(none)');
  }

  console.log('\n=== APPROVED POSTS WAITING ===\n');

  const { data: approved } = await supabaseFetch(
    '/rest/v1/social_posts?status=eq.approved&order=created_at.asc&select=id,post_id,platform,persona,created_at'
  );

  if (approved && approved.length > 0) {
    const grouped = {};
    for (const post of approved) {
      if (!grouped[post.platform]) grouped[post.platform] = [];
      grouped[post.platform].push(post);
    }

    for (const [platform, posts] of Object.entries(grouped)) {
      console.log(`${platform.toUpperCase()}: ${posts.length} waiting`);
      for (const post of posts) {
        console.log(`  - ${post.persona.padEnd(10)} ${post.created_at} ${post.post_id.slice(0, 60)}`);
      }
      console.log('');
    }
  } else {
    console.log('(none)');
  }

  console.log('=== ANALYSIS ===\n');

  const platforms = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok'];
  for (const platform of platforms) {
    const schedule = (schedules || []).find(s => s.platform === platform && s.day_of_week === 0);
    const posted = (postedToday || []).filter(p => p.platform === platform).length;
    const waiting = (approved || []).filter(p => p.platform === platform).length;

    if (!schedule) {
      console.log(`${platform.toUpperCase()}: NO SCHEDULE for Sunday (day 0)`);
    } else {
      const cap = schedule.max_per_day ?? 'unlimited';
      const capReached = schedule.max_per_day != null && posted >= schedule.max_per_day;
      console.log(`${platform.toUpperCase()}: ${posted}/${cap} posted today${capReached ? ' ⛔ CAP REACHED' : ''}, ${waiting} waiting`);
    }
  }
}

main().catch(console.error);
