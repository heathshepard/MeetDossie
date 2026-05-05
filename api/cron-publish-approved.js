// Vercel Serverless Function: /api/cron-publish-approved
// Picks up approved social_posts and pushes each one to Zernio for fan-out
// to the connected platform account.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — every 30 min ("*/30 * * * *").
//
// Behaviour:
//   1. For each platform with approved-and-due rows, look up today's
//      posting_schedule row (time_slots + max_per_day + max_per_slot).
//   2. Skip the platform until the next slot's clock-time has arrived
//      (compares now-in-platform-tz against time_slots).
//   3. Skip the platform once max_per_day is reached for today.
//   4. tiktok rows are flipped to status='pending_video' (Zernio rejects
//      text-only TikTok); they'll be picked up later when a video is
//      attached via the DONE pipeline.
//   5. Zernio errors land in social_posts.error_message and the row flips
//      to status='failed' (replaces the prior "leave at approved for retry"
//      behaviour, which silently masked permanent failures).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';
const MAX_PER_RUN = 8;

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

function buildPostBody(post) {
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const tagLine = hashtags.length
    ? '\n\n' + hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '';
  const content = String(post.content || '');
  const text = /\B#\w/.test(content) ? content : `${content}${tagLine}`;
  return text.trim();
}

async function pushToZernio(post) {
  if (!post.zernio_account_id) return { ok: false, error: 'no zernio_account_id on row' };
  const text = buildPostBody(post);
  const payload = {
    account_id: post.zernio_account_id,
    content: text,
  };
  if (post.scheduled_for) payload.scheduled_for = post.scheduled_for;
  // Media attachment. Zernio's media field name isn't formally documented to
  // us; the most common pattern across publish APIs (Buffer, Hootsuite,
  // Ayrshare) is `media_urls: [url, ...]`. If Zernio wants a different shape,
  // the 4xx response body will land in social_posts.error_message and we
  // iterate. Instagram requires media — text-only IG posts get rejected.
  if (post.media_url) {
    payload.media_urls = [post.media_url];
  }
  try {
    const res = await fetch(ZERNIO_POSTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const respText = await res.text();
    let data = null;
    try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        // Keep enough of the body to capture multi-line JSON errors.
        error: respText.slice(0, 1000),
        data,
      };
    }
    return { ok: true, status: res.status, data, zernio_post_id: data?.id || data?.post_id || null };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

// ─── posting_schedule helpers ────────────────────────────────────────────

// Compute today's clock state in the schedule row's timezone.
//   returns { dow: 0-6 Sun..Sat, hhmm: 'HH:MM', dateKey: 'YYYY-MM-DD' }
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

// Convert "HH:MM:SS" or "HH:MM" → minutes-since-midnight.
function hhmmToMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

async function loadSchedules() {
  const { data, ok } = await supabaseFetch('/rest/v1/posting_schedule?is_active=eq.true&select=platform,day_of_week,time_slots,timezone,max_per_day,max_per_slot');
  if (!ok) return [];
  return Array.isArray(data) ? data : [];
}

// Count how many posts already published for `platform` today (in the platform tz).
async function countPostedToday(platform, tz) {
  const today = nowInTz(tz).dateKey;
  // Postgres timestamp comparison in UTC; the day window is computed locally.
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

// Decide if `platform` should publish right now: needs schedule row for
// today's dow, current time >= some slot, daily cap not exhausted.
async function isDueForPublish(platform, schedules) {
  const row = schedules.find((s) => s.platform === platform);
  if (!row) return { due: true, reason: 'no schedule row — falling back to immediate' };
  const tz = row.timezone || 'America/Chicago';
  const today = nowInTz(tz);
  const todayRow = schedules.find((s) => s.platform === platform && s.day_of_week === today.dow);
  if (!todayRow) return { due: false, reason: `no schedule for ${platform} on dow=${today.dow}` };

  const slots = (todayRow.time_slots || []).map(hhmmToMin).sort((a, b) => a - b);
  const nowMin = hhmmToMin(today.hhmm);
  const passedSlots = slots.filter((s) => s <= nowMin);
  if (passedSlots.length === 0) {
    return { due: false, reason: `no slot reached yet (now=${today.hhmm}, next=${slots[0] != null ? Math.floor(slots[0]/60).toString().padStart(2,'0')+':'+(slots[0]%60).toString().padStart(2,'0') : 'none'})` };
  }

  const cap = todayRow.max_per_day ?? null;
  if (cap != null) {
    const already = await countPostedToday(platform, tz);
    if (already >= cap) {
      return { due: false, reason: `daily cap reached (${already}/${cap})` };
    }
  }
  return { due: true, reason: `slot ${passedSlots[passedSlots.length - 1]} passed` };
}

// ─── main ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) {
    console.error('[cron-publish-approved] CRON_SECRET not configured — refusing to run.');
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!ZERNIO_API_KEY) {
    console.error('[cron-publish-approved] ZERNIO_API_KEY not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'zernio not configured' });
  }

  const nowIso = new Date().toISOString();
  const filter = `status=eq.approved&posted_at=is.null&or=(scheduled_for.is.null,scheduled_for.lte.${encodeURIComponent(nowIso)})`;
  const { data: items, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?${filter}&order=approved_at.asc.nullslast&limit=${MAX_PER_RUN}`,
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load approved posts' });
  }
  const queue = Array.isArray(items) ? items : [];
  console.log('[cron-publish-approved] approved-and-due rows:', queue.length);

  const schedules = await loadSchedules();
  const platformDecisionCache = {};

  let published = 0;
  let skippedSchedule = 0;
  let parkedTiktok = 0;
  const errors = [];
  const skips = [];

  for (const post of queue) {
    if (!post || !post.id) continue;

    // TikTok text-only → park for video pipeline.
    if (post.platform === 'tiktok') {
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'pending_video',
          error_message: 'TikTok requires a video attachment; awaiting DONE-pipeline render.',
        }),
      });
      if (patch.ok) parkedTiktok++;
      else errors.push({ id: post.id, error: 'patch to pending_video failed', status: patch.status });
      continue;
    }

    // Schedule gate (time slot + daily cap).
    if (!platformDecisionCache[post.platform]) {
      platformDecisionCache[post.platform] = await isDueForPublish(post.platform, schedules);
    }
    const decision = platformDecisionCache[post.platform];
    if (!decision.due) {
      skippedSchedule++;
      skips.push({ id: post.id, platform: post.platform, reason: decision.reason });
      continue;
    }

    // Note: Instagram requires media. Without a media_id attached, Zernio will
    // 4xx; we capture that error in error_message + status='failed' so we can
    // diagnose. The IG-card generator endpoint is built separately and will
    // be wired in once Zernio's media-upload contract is confirmed.

    const result = await pushToZernio(post);
    if (result.ok) {
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'posted',
          posted_at: new Date().toISOString(),
          zernio_post_id: result.zernio_post_id,
          error_message: null,
        }),
      });
      if (patch.ok) {
        published++;
        // Once we've consumed a slot for this platform, advance the cache so
        // the next post on the same platform in this run respects max_per_slot.
        // (max_per_slot=1 means: don't double-publish in a single cron run.)
        const todayRow = schedules.find((s) => s.platform === post.platform);
        if (todayRow && (todayRow.max_per_slot ?? 1) <= 1) {
          platformDecisionCache[post.platform] = { due: false, reason: 'slot consumed this run' };
        }
      } else {
        errors.push({ id: post.id, error: 'patch after publish failed', status: patch.status });
      }
    } else {
      console.error('[cron-publish-approved] push failed for', post.id, result);
      const errBody = (result.error || '').toString().slice(0, 1500);
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          error_message: `[${result.status || 'no-status'}] ${errBody}`,
        }),
      });
      errors.push({
        id: post.id,
        platform: post.platform,
        zernio_status: result.status,
        zernio_error: errBody,
        patch_ok: patch.ok,
      });
    }
  }

  console.log('[cron-publish-approved] done — published', published, 'parked-tiktok:', parkedTiktok, 'skipped(schedule):', skippedSchedule, 'errors:', errors.length);
  return res.status(200).json({
    ok: true,
    published,
    parked_tiktok: parkedTiktok,
    skipped_schedule: skippedSchedule,
    attempted: queue.length,
    errors,
    skips,
  });
};
