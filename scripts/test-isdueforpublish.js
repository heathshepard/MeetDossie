// Test isDueForPublish logic to see what it returns for each platform
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

async function testIsDueForPublish(platform, schedules) {
  const tz = 'America/Chicago';
  const today = nowInTz(tz);
  console.log(`\nTesting ${platform}:`);
  console.log(`  Current time: ${today.hhmm} (${today.dow}=${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][today.dow]}), ${today.dateKey}`);

  const row = schedules.find((s) => s.platform === platform && s.day_of_week === today.dow);
  if (!row) {
    console.log(`  ❌ No schedule row found for ${platform} on day ${today.dow}`);
    console.log(`  → Falling back to immediate (due=true)`);
    return { due: true, reason: `no schedule row for ${platform} on day ${today.dow}` };
  }

  console.log(`  ✅ Found schedule: slots=${JSON.stringify(row.time_slots)}, cap=${row.max_per_day}`);

  const slots = (row.time_slots || []).map(hhmmToMin).sort((a, b) => a - b);
  const nowMin = hhmmToMin(today.hhmm);
  const passedSlots = slots.filter((s) => s <= nowMin);

  if (passedSlots.length === 0) {
    console.log(`  ❌ No slot reached yet (now=${nowMin} min, slots=${JSON.stringify(slots)})`);
    return { due: false, reason: `no slot reached yet` };
  }

  console.log(`  ✅ Passed ${passedSlots.length} slots: ${JSON.stringify(passedSlots)}`);

  const cap = row.max_per_day ?? null;
  if (cap != null) {
    const already = await countPostedToday(platform, tz);
    console.log(`  Cap check: ${already}/${cap} posted today`);
    if (already >= cap) {
      console.log(`  ❌ Daily cap reached`);
      return { due: false, reason: `daily cap reached (${already}/${cap})` };
    }
  }

  console.log(`  ✅ DUE FOR PUBLISH`);
  return { due: true, reason: `slot ${passedSlots[passedSlots.length - 1]} passed` };
}

async function main() {
  const { data: schedules, ok } = await supabaseFetch('/rest/v1/posting_schedule?is_active=eq.true&select=platform,day_of_week,time_slots,timezone,max_per_day');
  if (!ok) {
    console.error('Failed to load schedules');
    return;
  }

  console.log('=== isDueForPublish Test ===');
  console.log(`Loaded ${schedules.length} schedule rows`);

  const platforms = ['facebook', 'instagram', 'twitter', 'linkedin'];
  for (const platform of platforms) {
    await testIsDueForPublish(platform, schedules);
  }
}

main().catch(console.error);
