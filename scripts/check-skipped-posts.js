// Check why posts were skipped in the last cron run
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

function nowInTz(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dowMap[parts.weekday] ?? 0,
    hhmm: `${parts.hour}:${parts.minute}`,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function hhmmToMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

async function countPostedToday(platform, tz) {
  const today = nowInTz(tz).dateKey;
  const startOfDayUtc = new Date(`${today}T00:00:00`).toISOString();
  const endOfDayUtc = new Date(`${today}T23:59:59.999`).toISOString();
  const filter = `platform=eq.${encodeURIComponent(platform)}&status=eq.posted` +
    `&posted_at=gte.${encodeURIComponent(startOfDayUtc)}` +
    `&posted_at=lte.${encodeURIComponent(endOfDayUtc)}` +
    `&select=id`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  if (!ok) return 0;
  return Array.isArray(data) ? data.length : 0;
}

async function checkPost(post, schedules) {
  const tz = 'America/Chicago';
  const today = nowInTz(tz);
  const platform = post.platform;

  console.log(`\n=== ${post.post_id} ===`);
  console.log(`Platform: ${platform}`);
  console.log(`Persona: ${post.persona}`);
  console.log(`Status: ${post.status}`);
  console.log(`Created: ${post.created_at}`);

  // Check schedule
  const row = schedules.find((s) => s.platform === platform && s.day_of_week === today.dow);
  if (!row) {
    console.log(`❌ SKIP REASON: No schedule row for ${platform} on day ${today.dow} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][today.dow]})`);
    return;
  }

  console.log(`Schedule found: day_of_week=${row.day_of_week}, time_slots=${JSON.stringify(row.time_slots)}, max_per_day=${row.max_per_day}`);

  // Check time slots
  const slots = (row.time_slots || []).map(hhmmToMin).sort((a, b) => a - b);
  const nowMin = hhmmToMin(today.hhmm);
  const passedSlots = slots.filter((s) => s <= nowMin);

  if (passedSlots.length === 0) {
    console.log(`❌ SKIP REASON: No time slot reached yet (current time=${today.hhmm} = ${nowMin} min, slots=${JSON.stringify(slots)})`);
    return;
  }

  console.log(`✅ Time slot passed: ${passedSlots.length} of ${slots.length} slots reached`);

  // Check daily cap
  const cap = row.max_per_day ?? null;
  if (cap != null) {
    const already = await countPostedToday(platform, tz);
    console.log(`Cap check: ${already}/${cap} posted today`);
    if (already >= cap) {
      console.log(`❌ SKIP REASON: Daily cap reached (${already}/${cap})`);
      return;
    }
  }

  console.log(`✅ Should publish (all checks passed)`);
}

async function main() {
  // Get recent approved posts
  const { data: posts, ok: postsOk } = await supabaseFetch(
    '/rest/v1/social_posts?status=eq.approved&order=created_at.desc&limit=10&select=id,post_id,platform,persona,status,created_at'
  );

  if (!postsOk || !Array.isArray(posts)) {
    console.error('Failed to load posts');
    return;
  }

  console.log(`Found ${posts.length} approved posts`);

  // Get posting schedule
  const { data: schedules, ok: schedOk } = await supabaseFetch(
    '/rest/v1/posting_schedule?is_active=eq.true&select=platform,day_of_week,time_slots,max_per_day'
  );

  if (!schedOk) {
    console.error('Failed to load schedules');
    return;
  }

  console.log(`Loaded ${schedules.length} schedule rows`);
  console.log(`Current time: ${nowInTz('America/Chicago').hhmm} CST (day ${nowInTz('America/Chicago').dow})`);

  for (const post of posts) {
    await checkPost(post, schedules);
  }
}

main().catch(console.error);
