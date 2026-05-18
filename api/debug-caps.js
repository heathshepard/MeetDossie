// Debug endpoint to show cap calculations
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

async function countPostedToday(platform, tz) {
  const today = nowInTz(tz).dateKey;
  const [year, month, day] = today.split('-').map(Number);

  const now = new Date();
  const testDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const utcString = testDate.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzString = testDate.toLocaleString('en-US', { timeZone: tz });
  const utcMs = new Date(utcString).getTime();
  const tzMs = new Date(tzString).getTime();
  const offsetMs = utcMs - tzMs;

  const midnightTz = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const endOfDayTz = Date.UTC(year, month - 1, day, 23, 59, 59, 999);

  const startOfDayUtc = new Date(midnightTz + offsetMs).toISOString();
  const endOfDayUtc = new Date(endOfDayTz + offsetMs).toISOString();

  const filter = `platform=eq.${encodeURIComponent(platform)}&status=eq.posted` +
    `&posted_at=gte.${encodeURIComponent(startOfDayUtc)}` +
    `&posted_at=lte.${encodeURIComponent(endOfDayUtc)}` +
    `&select=id,post_id,posted_at`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);

  return {
    platform,
    today_in_tz: today,
    tz,
    start_utc: startOfDayUtc,
    end_utc: endOfDayUtc,
    offset_ms: offsetMs,
    offset_hours: offsetMs / (60 * 60 * 1000),
    count: ok && Array.isArray(data) ? data.length : 0,
    posts: ok && Array.isArray(data) ? data : [],
  };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const tz = 'America/Chicago';
  const today = nowInTz(tz);
  const platforms = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok'];

  const results = [];
  for (const platform of platforms) {
    const result = await countPostedToday(platform, tz);
    results.push(result);
  }

  return res.status(200).json({
    ok: true,
    current_time_utc: new Date().toISOString(),
    current_time_chicago: `${today.dateKey} ${today.hhmm} CST (day ${today.dow})`,
    results,
  });
};
