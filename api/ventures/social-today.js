/**
 * GET /api/ventures/social-today
 * Returns "today" aggregate for the /ventures/social/today dashboard:
 *
 *   - Per platform: target / posted / pending / blocked
 *   - Per platform: comments today / cap
 *   - Watchdog status (last run + last 5 actions + last 10 wall entries)
 *   - Mission completion %
 *   - Platform-pause state
 *
 * Auth: Bearer Supabase JWT — heath emails only (same as cron-health).
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
  'heathshepard@meetdossie.com',
]);

const ALLOWED_ORIGINS = new Set(['https://meetdossie.com', 'https://www.meetdossie.com']);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const PLATFORMS = ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok'];

// Mirror caps from scripts/_lib/comment-caps.js (kept defensive — if that file
// changes, dashboard will still load with stale numbers and a warning).
const COMMENT_CAPS_FALLBACK = {
  facebook: 12,
  instagram: 8,
  linkedin: 6,
  reddit: 5,
  twitter: 15,
};

let cachedCommentCaps = null;
function getCommentCaps() {
  if (cachedCommentCaps) return cachedCommentCaps;
  try {
    const shared = require('../../scripts/_lib/comment-caps');
    cachedCommentCaps = shared.PLATFORM_DAILY_CAPS || COMMENT_CAPS_FALLBACK;
  } catch {
    cachedCommentCaps = COMMENT_CAPS_FALLBACK;
  }
  return cachedCommentCaps;
}

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

// CDT-day start/end as UTC ISO strings.
function dayWindowCdt() {
  // Compute "now" in CDT (UTC-5 standard).
  const now = new Date();
  const cdtNow = new Date(now.getTime() - 5 * 3600 * 1000);
  const startCdt = new Date(Date.UTC(cdtNow.getUTCFullYear(), cdtNow.getUTCMonth(), cdtNow.getUTCDate()));
  const startUtc = new Date(startCdt.getTime() + 5 * 3600 * 1000); // +5h back to UTC
  const endUtc = new Date(startUtc.getTime() + 24 * 3600 * 1000 - 1);
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() };
}

async function countPosts(platform, status, startUtc, endUtc, timeCol = 'created_at') {
  const filter =
    `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.${encodeURIComponent(status)}` +
    `&${timeCol}=gte.${encodeURIComponent(startUtc)}` +
    `&${timeCol}=lte.${encodeURIComponent(endUtc)}` +
    '&select=id';
  const r = await supa(`social_posts?${filter}`);
  if (!r.ok) return 0;
  const arr = await r.json();
  return Array.isArray(arr) ? arr.length : 0;
}

async function fetchSchedule() {
  // posting_schedule rows for today's day_of_week.
  const dow = new Date().getUTCDay(); // 0..6 — Supabase rows use same.
  const r = await supa(`posting_schedule?select=platform,day_of_week,time_slots,max_per_day&is_active=eq.true&day_of_week=eq.${dow}`);
  if (!r.ok) return {};
  const rows = await r.json();
  const map = {};
  for (const row of rows) map[row.platform] = row;
  return map;
}

async function platformPauseState() {
  const r = await supa('platform_health_state?select=platform,platform_pause_until,consecutive_fails,last_probe_ok,last_latency_ms,last_checked_at');
  if (!r.ok) return new Map();
  const rows = await r.json();
  const m = new Map();
  for (const row of rows) m.set(row.platform, row);
  return m;
}

async function countCommentsToday(platform, startUtc, endUtc) {
  const filter =
    `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.posted` +
    `&posted_at=gte.${encodeURIComponent(startUtc)}` +
    `&posted_at=lte.${encodeURIComponent(endUtc)}` +
    '&select=id';
  const r = await supa(`engagement_candidates?${filter}`);
  if (!r.ok) return 0;
  const arr = await r.json();
  return Array.isArray(arr) ? arr.length : 0;
}

async function watchdogStatus() {
  // Latest cron_runs row for watchdog
  const r = await supa('cron_runs?cron_name=eq.cron-mission-watchdog&select=last_run,last_status,last_error&order=last_run.desc&limit=1');
  let last = null;
  if (r.ok) {
    const arr = await r.json();
    last = arr && arr.length ? arr[0] : null;
  }
  // Latest 10 wall entries (any cron)
  const w = await supa('wall_log_entries?select=detected_at,wall_id,title,detected_by,route_around&order=detected_at.desc&limit=10');
  let walls = [];
  if (w.ok) walls = await w.json();
  return { last, walls };
}

async function reliabilityCronsStatus() {
  const names = [
    'cron-mission-watchdog',
    'cron-cron-fire-verifier',
    'cron-platform-health-checker',
    'cron-account-session-monitor',
  ];
  const r = await supa(`cron_runs?cron_name=in.(${names.join(',')})&select=cron_name,last_run,last_status&order=last_run.desc&limit=20`);
  if (!r.ok) return [];
  const arr = await r.json();
  // Reduce to one per name (latest).
  const map = {};
  for (const row of arr) if (!map[row.cron_name]) map[row.cron_name] = row;
  return names.map((n) => ({ name: n, ...(map[n] || {}) }));
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { startUtc, endUtc } = dayWindowCdt();
    const schedule = await fetchSchedule();
    const pauseState = await platformPauseState();
    const commentCaps = getCommentCaps();

    const platformRows = [];
    let totalTarget = 0;
    let totalPosted = 0;
    let totalCommentsTarget = 0;
    let totalCommentsPosted = 0;

    for (const p of PLATFORMS) {
      const sched = schedule[p] || null;
      const target = sched ? (sched.max_per_day || (sched.time_slots || []).length) : 0;

      const posted   = await countPosts(p, 'posted',         startUtc, endUtc, 'posted_at');
      const pending  = await countPosts(p, 'pending_video',  startUtc, endUtc, 'created_at');
      const approved = await countPosts(p, 'approved',       startUtc, endUtc, 'created_at');
      const draft    = await countPosts(p, 'draft',          startUtc, endUtc, 'created_at');
      const rejected = await countPosts(p, 'rejected',       startUtc, endUtc, 'created_at');
      const failed   = await countPosts(p, 'failed',         startUtc, endUtc, 'created_at');

      const commentsCap = commentCaps[p] || 0;
      const commentsPosted = await countCommentsToday(p, startUtc, endUtc);

      const pause = pauseState.get(p) || null;
      const pausedUntil = pause && pause.platform_pause_until ? new Date(pause.platform_pause_until) : null;
      const isPaused = pausedUntil && pausedUntil.getTime() > Date.now();

      totalTarget += target;
      totalPosted += posted;
      totalCommentsTarget += commentsCap;
      totalCommentsPosted += commentsPosted;

      platformRows.push({
        platform: p,
        target,
        posted,
        pending,        // pending_video for tiktok mostly
        approved,       // queued for next publish slot
        draft,
        rejected,
        failed,
        blocked: failed + rejected,
        comments_today: commentsPosted,
        comments_cap: commentsCap,
        paused: !!isPaused,
        paused_until: isPaused ? pausedUntil.toISOString() : null,
        consecutive_fails: pause ? pause.consecutive_fails || 0 : 0,
        last_probe_ok: pause ? !!pause.last_probe_ok : null,
        last_latency_ms: pause ? pause.last_latency_ms : null,
        last_probe_checked_at: pause ? pause.last_checked_at : null,
      });
    }

    const wd = await watchdogStatus();
    const rel = await reliabilityCronsStatus();

    const missionPostsPct = totalTarget ? Math.round((totalPosted / totalTarget) * 100) : 0;
    const missionCommentsPct = totalCommentsTarget ? Math.round((totalCommentsPosted / totalCommentsTarget) * 100) : 0;
    const missionOverallPct = (totalTarget + totalCommentsTarget) > 0
      ? Math.round(((totalPosted + totalCommentsPosted) / (totalTarget + totalCommentsTarget)) * 100)
      : 0;

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      window: { start_utc: startUtc, end_utc: endUtc },
      platforms: platformRows,
      mission: {
        posts_target: totalTarget,
        posts_posted: totalPosted,
        posts_pct: missionPostsPct,
        comments_target: totalCommentsTarget,
        comments_posted: totalCommentsPosted,
        comments_pct: missionCommentsPct,
        overall_pct: missionOverallPct,
      },
      watchdog: wd.last,
      walls_recent: wd.walls,
      reliability: rel,
    });
  } catch (err) {
    console.error('[ventures/social-today] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
