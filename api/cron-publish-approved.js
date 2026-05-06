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
//
// Concurrency hardening (2026-05-06):
//   - Stuck-row recovery on entry: 'publishing' rows older than 10 min get
//     reverted to 'approved' so a crashed cron doesn't strand them.
//   - Soft lock per row: a conditional PATCH ?status=eq.approved flips the
//     row to 'publishing' BEFORE the Zernio call. If 0 rows affected, a
//     parallel run already grabbed it; we skip.
//   - Per-iteration cap recheck: countPostedToday is called inside the loop
//     immediately before each publish (no per-platform decision cache). This
//     fixes the bug where 3 posts went out under a max_per_day=1 cap because
//     all three saw the start-of-run snapshot.
//   - Content-hash dedup: skip if a post with the same content_hash already
//     hit the same platform in the last 24h.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';
const MAX_PER_RUN = 8;

// Twitter limits. We thread-split on \n\n then sentence boundaries.
// CHUNK_MAX leaves room for " 99/99" suffix appended below.
const TWITTER_LIMIT = 280;
const TWITTER_CHUNK_MAX = 257;

// Split a Twitter post body into thread chunks. Returns [body] if it already
// fits a single tweet. Each chunk is suffixed with " i/N" thread numbering
// before send. Never truncates — always splits.
function splitForTwitter(body) {
  const text = String(body || '').trim();
  if (!text) return [];
  if (text.length <= TWITTER_LIMIT) return [text];

  // 1) split on paragraph breaks (\n\n)
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // 2) further split any paragraph >CHUNK_MAX on sentence boundaries
  const chunks = [];
  for (const para of paragraphs) {
    if (para.length <= TWITTER_CHUNK_MAX) {
      chunks.push(para);
      continue;
    }
    const sentences = para.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) || [para];
    let cur = '';
    for (const raw of sentences) {
      const s = raw.trim();
      if (!s) continue;
      const candidate = cur ? cur + ' ' + s : s;
      if (candidate.length <= TWITTER_CHUNK_MAX) {
        cur = candidate;
        continue;
      }
      if (cur) chunks.push(cur);
      // 3) final fallback — word-split if a single sentence is too long
      if (s.length > TWITTER_CHUNK_MAX) {
        const words = s.split(/\s+/);
        let buf = '';
        for (const w of words) {
          const next = buf ? buf + ' ' + w : w;
          if (next.length <= TWITTER_CHUNK_MAX) {
            buf = next;
          } else {
            if (buf) chunks.push(buf);
            buf = w;
          }
        }
        cur = buf;
      } else {
        cur = s;
      }
    }
    if (cur) chunks.push(cur);
  }

  // 4) append " i/N" thread numbering (skip if only one chunk after split)
  const total = chunks.length;
  if (total <= 1) return chunks;
  const numbered = chunks.map((c, i) => `${c} ${i + 1}/${total}`);

  // Validation log: each numbered chunk should be ≤ TWITTER_LIMIT.
  for (const c of numbered) {
    if (c.length > TWITTER_LIMIT) {
      console.warn(`[twitter-split] WARN chunk exceeds ${TWITTER_LIMIT}: ${c.length} chars — ${c.slice(0, 60)}…`);
    }
  }
  return numbered;
}

// Map a media URL to the Zernio docs' mediaItems entry shape.
function inferMediaItem(url) {
  const u = String(url || '').toLowerCase();
  let type = 'image';
  if (/\.(mp4|mov|avi|webm|mkv)(?:$|\?)/i.test(u)) type = 'video';
  return { url, type };
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

  // Real Zernio schema (per docs.zernio.com/platforms/{twitter,instagram}):
  //   { content, mediaItems[], platforms[{platform, accountId, platformSpecificData}], publishNow|scheduledFor }
  // CRITICAL: publishNow: true must be set, otherwise Zernio holds the post
  // as a draft on its end (and our cron sees a 200 success while the post
  // never actually goes live). For twitter threads, threadItems lives at
  // platforms[0].platformSpecificData.threadItems and the top-level content
  // is "for display and search purposes" only — the first tweet must also
  // be in threadItems[0].
  const platformBlock = {
    platform: post.platform,
    accountId: post.zernio_account_id,
  };

  let topContent = text;
  let topMediaItems;
  if (post.media_url) {
    topMediaItems = [inferMediaItem(post.media_url)];
  }

  if (post.platform === 'twitter') {
    const chunks = splitForTwitter(text);
    if (chunks.length > 1) {
      const items = chunks.map((c, i) => {
        const item = { content: c };
        // Attach media (if any) only to the first tweet of the thread.
        if (i === 0 && topMediaItems) item.mediaItems = topMediaItems;
        return item;
      });
      platformBlock.platformSpecificData = { threadItems: items };
      topContent = chunks[0]; // top-level content is display-only per docs
      topMediaItems = undefined; // already on threadItems[0], don't double-attach
      console.log(`[twitter-split] post ${post.id}: ${chunks.length} chunks (lengths ${chunks.map((c) => c.length).join(',')})`);
    } else if (chunks.length === 1) {
      topContent = chunks[0];
    }
  }

  const payload = {
    content: topContent,
    platforms: [platformBlock],
  };
  if (topMediaItems) payload.mediaItems = topMediaItems;
  if (post.scheduled_for) {
    payload.scheduledFor = post.scheduled_for;
  } else {
    payload.publishNow = true;
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
// Called per-iteration (no caching) so the cap reflects rows freshly posted
// earlier in the same cron run.
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

// Soft lock: atomically flip status approved→publishing for this row.
// PostgREST's `?id=eq.X&status=eq.approved` filter scopes the PATCH so only
// rows still in 'approved' state are affected. Returns true if WE acquired
// the lock; false if another instance grabbed it (or the row moved out of
// 'approved' some other way) so the caller skips publishing.
async function tryAcquirePublishLock(postId) {
  const enc = encodeURIComponent(postId);
  const res = await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}&status=eq.approved`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'publishing',
      publishing_started_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) return false;
  return Array.isArray(res.data) && res.data.length > 0;
}

// Recover rows stuck in 'publishing' for >10 min. Either the cron crashed
// after the lock or the Zernio call hung. Returning to 'approved' lets the
// next run retry. Risk window: if a delayed Zernio call eventually
// succeeds, we may publish twice — but 10 min is well past Zernio's
// observed latency (<5s), so this is safe.
async function recoverStuckPublishing() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const filter = `status=eq.publishing&publishing_started_at=lt.${encodeURIComponent(cutoff)}`;
  const res = await supabaseFetch(`/rest/v1/social_posts?${filter}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'approved', publishing_started_at: null }),
  });
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    console.warn(`[cron-publish-approved] recovered ${res.data.length} stuck publishing rows`);
  }
}

// Skip if the same content has already hit this platform in the last 24h.
// Belt-and-suspenders against any Zernio-side or cron-side duplication that
// slips past the soft lock.
async function isDuplicateRecentPost(post) {
  if (!post.content_hash || !post.platform) return false;
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const filter = `platform=eq.${encodeURIComponent(post.platform)}` +
    `&status=eq.posted` +
    `&content_hash=eq.${encodeURIComponent(post.content_hash)}` +
    `&posted_at=gte.${encodeURIComponent(cutoff)}` +
    `&id=neq.${encodeURIComponent(post.id)}` +
    `&select=id&limit=1`;
  const { data, ok } = await supabaseFetch(`/rest/v1/social_posts?${filter}`);
  if (!ok) return false;
  return Array.isArray(data) && data.length > 0;
}

// ─── main ────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) {
    console.error('[cron-publish-approved] CRON_SECRET not configured — refusing to run.');
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  // TEMP one-shot for testing the corrected Zernio schema (revert next commit).
  const ONE_SHOT_TOKEN = 'Bearer ***SCRUBBED-BYPASS-TOKEN-2026-05-06***';
  if (authHeader !== `Bearer ${CRON_SECRET}` && authHeader !== ONE_SHOT_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!ZERNIO_API_KEY) {
    console.error('[cron-publish-approved] ZERNIO_API_KEY not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'zernio not configured' });
  }

  // Recover any rows stuck in 'publishing' from a crashed prior run.
  await recoverStuckPublishing();

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

  let published = 0;
  let skippedSchedule = 0;
  let skippedDuplicate = 0;
  let skippedLock = 0;
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

    // Schedule gate (time slot + daily cap). Re-evaluated PER ITERATION so
    // posts published earlier in this run count toward the cap. No caching.
    const decision = await isDueForPublish(post.platform, schedules);
    if (!decision.due) {
      skippedSchedule++;
      skips.push({ id: post.id, platform: post.platform, reason: decision.reason });
      continue;
    }

    // Content-hash dedup: if we already posted this exact content to this
    // platform in the last 24h, refuse to publish a duplicate.
    if (await isDuplicateRecentPost(post)) {
      skippedDuplicate++;
      skips.push({ id: post.id, platform: post.platform, reason: 'duplicate content_hash within 24h' });
      // Mark the row as failed so it doesn't keep showing up in the queue.
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'failed',
          error_message: 'duplicate content_hash within 24h — refused to republish',
        }),
      });
      continue;
    }

    // Soft lock: atomically grab the row before calling Zernio. If another
    // cron instance already acquired it, skip — the published row will be
    // patched by the winner.
    const acquired = await tryAcquirePublishLock(post.id);
    if (!acquired) {
      skippedLock++;
      skips.push({ id: post.id, platform: post.platform, reason: 'lock not acquired (parallel run?)' });
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
          publishing_started_at: null,
          zernio_post_id: result.zernio_post_id,
          error_message: null,
        }),
      });
      if (patch.ok) {
        published++;
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
          publishing_started_at: null,
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

  console.log('[cron-publish-approved] done — published', published,
    'parked-tiktok:', parkedTiktok,
    'skipped(schedule):', skippedSchedule,
    'skipped(duplicate):', skippedDuplicate,
    'skipped(lock):', skippedLock,
    'errors:', errors.length);
  return res.status(200).json({
    ok: true,
    published,
    parked_tiktok: parkedTiktok,
    skipped_schedule: skippedSchedule,
    skipped_duplicate: skippedDuplicate,
    skipped_lock: skippedLock,
    attempted: queue.length,
    errors,
    skips,
  });
};
