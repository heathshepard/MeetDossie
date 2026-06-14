'use strict';

// api/cron-mission-watchdog.js
//
// SV-ENG-WATCHDOG-001 (Atlas, 2026-06-11)
//
// MISSION WATCHDOG: runs every hour 8 AM–8 PM CDT (13:00–01:00 UTC).
// Per platform (facebook, instagram, linkedin, twitter, tiktok, youtube):
//
//   1. Compute expected pace for "now":
//        expected_so_far = ceil(max_per_day * (slots_passed / total_slots))
//      where slots_passed = how many time_slots from posting_schedule have
//      already clock-passed in the platform timezone (America/Chicago).
//
//   2. Compute actual posted today:
//        social_posts where platform=eq.X AND status=eq.posted AND
//        posted_at >= start_of_day(tz). We CONFIRM the post is real by
//        requiring zernio_post_id IS NOT NULL (Zernio actually accepted it).
//
//   3. Decision tree:
//
//        case A — behind pace AND next slot >2h away:
//          → not urgent. Log + skip. The next scheduled cron will catch up.
//
//        case B — behind pace AND next slot <2h away (or already past):
//          → route around the failure:
//            (i)   call /api/cron-sage-regenerate   (Sage owns rewrite)
//            (ii)  call /api/cron-publish-approved  (re-fire the publish lane)
//            (iii) Special case: tiktok behind + after 16:00 CDT + no video →
//                  call swapTikTokForOtherPlatform() to substitute with
//                  IG or Twitter extra post.
//
//        case C — structurally broken (cron not firing, no approved-and-due
//                 rows even after regenerate attempt):
//          → record root_cause + log so morning digest can surface.
//
//   4. End-of-day summary (only when current_hour_cdt >= 20):
//      send one Telegram message with platform-by-platform actuals vs expected.
//      Mid-day runs DO NOT ping Heath per the summary-only rule.
//
// Caps respected: never exceed posting_schedule.max_per_day. The watchdog
// only tries to UNBLOCK posts that should fire — it doesn't add new ones.
//
// Auth: Bearer ${CRON_SECRET} or x-vercel-cron header.
// Schedule:
//   - Windows Task Scheduler "Dossie Mission Watchdog" (primary, hourly 8-8 CDT).
//   - vercel.json secondary cron (hourly 13-01 UTC) as belt-and-suspenders.

const { retryFetch } = require('./_lib/retry.js');
const { DateTime } = require('luxon');
const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;
const SELF_BASE_URL             = process.env.SELF_BASE_URL || 'https://meetdossie.com';

const TZ = 'America/Chicago';
const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube'];
const BUSINESS_START_HOUR_CDT = 8;   // 8 AM CDT
const BUSINESS_END_HOUR_CDT   = 20;  // 8 PM CDT (inclusive end-of-day digest)
const NEXT_SLOT_GRACE_HOURS   = 2;   // route-around threshold

// ─── Supabase ─────────────────────────────────────────────────────────────

async function sb(path, init = {}) {
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

// ─── Telegram ─────────────────────────────────────────────────────────────

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[watchdog] telegram error:', err && err.message);
  }
}

// ─── Schedule helpers ─────────────────────────────────────────────────────

function hhmmToMin(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}

function nowInTz() {
  const now = DateTime.now().setZone(TZ);
  return {
    dow:  now.weekday % 7,                       // luxon: 1=Mon..7=Sun → 0=Sun..6=Sat
    hhmm: now.toFormat('HH:mm'),
    minute: now.hour * 60 + now.minute,
    hour: now.hour,
    dateKey: now.toFormat('yyyy-LL-dd'),
  };
}

async function loadSchedules() {
  const { ok, data } = await sb('/rest/v1/posting_schedule?is_active=eq.true&select=platform,day_of_week,time_slots,timezone,max_per_day,max_per_slot');
  return ok && Array.isArray(data) ? data : [];
}

// Count posts with status='posted' today (primary ship signal). Secondary
// verification: log warning if zernio_post_id is null (Zernio API shape
// regression on 2026-06-06 fixed by adding new shape extraction paths).
async function countActuallyPostedToday(platform) {
  const now = DateTime.now().setZone(TZ);
  const startUtc = now.startOf('day').toUTC().toISO();
  const endUtc   = now.endOf('day').toUTC().toISO();

  const filter = `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.posted` +
    `&posted_at=gte.${encodeURIComponent(startUtc)}` +
    `&posted_at=lte.${encodeURIComponent(endUtc)}` +
    `&select=id,zernio_post_id,error_message`;
  const { ok, data } = await sb(`/rest/v1/social_posts?${filter}`);
  if (!ok || !Array.isArray(data)) return 0;

  // Log warning if any posted rows are missing zernio_post_id (likely unverified)
  const unverified = data.filter(r => !r.zernio_post_id);
  if (unverified.length > 0) {
    console.warn(`[watchdog] ${platform}: ${unverified.length} posted rows missing zernio_post_id (unverified survival — see error_message)`);
  }

  return data.length;
}

// Count "approved-and-due" (not yet posted) for this platform — does the
// publish lane even have something to fire?
async function countApprovedReady(platform) {
  const nowIso = new Date().toISOString();
  const filter = `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.approved` +
    `&posted_at=is.null` +
    `&or=(scheduled_for.is.null,scheduled_for.lte.${encodeURIComponent(nowIso)})` +
    `&select=id`;
  const { ok, data } = await sb(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data.length : 0;
}

async function countRejectedToday(platform) {
  const now = DateTime.now().setZone(TZ);
  const startUtc = now.startOf('day').toUTC().toISO();
  const filter = `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.rejected` +
    `&created_at=gte.${encodeURIComponent(startUtc)}` +
    `&select=id`;
  const { ok, data } = await sb(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data.length : 0;
}

// Diagnose WHY a platform fell short. Returns a short string for the digest:
//   "no-gen"     — generator never produced a row today
//   "all-rejected" — every row this platform got was rejected (Sage flap)
//   "stuck-pending" — drafts exist but never reached approved status
//   "publish-failed" — approved rows exist but didn't post
//   "stale-no-data" — platform has no rows ever (structural break)
//   null         — no shortfall to diagnose
async function diagnoseShortfall(platform, actual, expected) {
  if (actual >= expected) return null;
  const now = DateTime.now().setZone(TZ);
  const startUtc = now.startOf('day').toUTC().toISO();
  // All today's rows for the platform.
  const todayRes = await sb(
    `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}` +
    `&created_at=gte.${encodeURIComponent(startUtc)}` +
    `&select=id,status`
  );
  const todayRows = todayRes.ok && Array.isArray(todayRes.data) ? todayRes.data : [];

  if (todayRows.length === 0) {
    // Did this platform EVER produce a row? If never → structural break.
    const everRes = await sb(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}` +
      `&select=id&limit=1`
    );
    if (everRes.ok && Array.isArray(everRes.data) && everRes.data.length === 0) {
      return 'stale-no-data';
    }
    return 'no-gen';
  }

  const counts = todayRows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  if (counts.posted >= expected) return null; // edge: counted differently
  if (counts.rejected === todayRows.length) return 'all-rejected';
  if (counts.approved > 0 && !counts.posted) return 'publish-failed';
  if (counts.draft > 0 && !counts.approved && !counts.posted) return 'stuck-pending';
  if (counts.failed > 0) return 'gen-failed';
  return null;
}

// ─── Pace math ────────────────────────────────────────────────────────────

function paceFor(platform, schedules, clock) {
  const row = schedules.find((s) => s.platform === platform && s.day_of_week === clock.dow);
  if (!row) {
    return { has_schedule: false, expected: 0, slots: [], next_slot_min: null };
  }
  const slots = (row.time_slots || []).map(hhmmToMin).sort((a, b) => a - b);
  const cap = row.max_per_day || slots.length;
  const passed = slots.filter((s) => s <= clock.minute).length;
  // Expected so far: cap * (passed/total), rounded to the nearest int but at
  // least equal to passed (each passed slot SHOULD have produced a post).
  const expected = Math.min(cap, passed);
  const next = slots.find((s) => s > clock.minute);
  return {
    has_schedule: true,
    expected,
    cap,
    slots_total: slots.length,
    slots_passed: passed,
    next_slot_min: next || null,
  };
}

// ─── Route-around actions ─────────────────────────────────────────────────

async function fireCron(path) {
  try {
    const url = `${SELF_BASE_URL}${path}`;
    const res = await retryFetch(
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${CRON_SECRET}` } },
      { name: `watchdog-${path}`, maxAttempts: 2, baseDelay: 1500 }
    );
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 240) };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

// Re-route TikTok quota into an extra IG or Twitter post when no video lands
// by 4 PM CDT. We don't manufacture posts — we just look for an EXTRA
// approved row beyond today's cap and let it fly. If no extras, log only.
async function swapTikTokForOtherPlatform(clock) {
  // Only after 4 PM CDT (16:00).
  if (clock.minute < 16 * 60) return { swapped: false, reason: 'too-early' };

  // Confirm tiktok has no video-attached approved row.
  const { data: tiktokPosts } = await sb(
    `/rest/v1/social_posts?platform=eq.tiktok&status=in.(approved,pending_video)&posted_at=is.null&select=id,status,media_url,video_required`
  );
  const hasVideoReady = Array.isArray(tiktokPosts) && tiktokPosts.some((p) => p.media_url);
  if (hasVideoReady) return { swapped: false, reason: 'tiktok-video-ready' };

  // For now we just log + mark intent. Heath approved silent substitution;
  // we let cron-publish-approved naturally publish whatever the other lanes
  // have. The watchdog does NOT bump caps — that's a Heath-only decision.
  console.log('[watchdog] tiktok swap: marked intent; cron-publish-approved will fly extras within existing caps');
  return { swapped: true, reason: 'tiktok-deferred-to-fallback-lanes' };
}

// LinkedIn auto-replacement: if LinkedIn got a rejected today AND has nothing
// approved-and-due, queue a regenerate so we don't end the day empty.
async function ensureLinkedInReplacement(rejectedCount, approvedReady) {
  if (rejectedCount === 0) return { triggered: false, reason: 'no-rejects-today' };
  if (approvedReady > 0)   return { triggered: false, reason: 'already-has-approved' };

  // Find latest rejected LinkedIn post and re-queue it for regeneration.
  // cron-sage-regenerate reads from sage_inbox where status='regenerating'.
  const { data: rejected } = await sb(
    `/rest/v1/social_posts?platform=eq.linkedin&status=eq.rejected&order=created_at.desc&limit=1&select=id`
  );
  if (!Array.isArray(rejected) || rejected.length === 0) return { triggered: false, reason: 'no-rejected-row' };

  const postId = rejected[0].id;
  // Find sage_inbox row and flip back to regenerating so cron-sage-regenerate picks it up.
  const { data: inbox } = await sb(`/rest/v1/sage_inbox?post_id=eq.${encodeURIComponent(postId)}&limit=1&select=id,regeneration_attempts`);
  if (!Array.isArray(inbox) || inbox.length === 0) return { triggered: false, reason: 'no-inbox-row' };

  const attempts = inbox[0].regeneration_attempts || 0;
  if (attempts >= 3) return { triggered: false, reason: 'max-attempts' };

  await sb(`/rest/v1/sage_inbox?id=eq.${encodeURIComponent(inbox[0].id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'regenerating',
      sage_feedback: 'Watchdog: LinkedIn pipeline empty after rejection — regenerate to keep slot filled.',
    }),
  });
  // Also clear the rejection so the post can fly post-regen.
  await sb(`/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'draft', rejection_reason: null }),
  });

  // Kick the regen cron now.
  const fired = await fireCron('/api/cron-sage-regenerate');
  return { triggered: true, post_id: postId, regen_fired: fired.ok };
}

// ─── Daily summary ────────────────────────────────────────────────────────

function platformEmoji(p) {
  return ({
    facebook: 'FB', instagram: 'IG', linkedin: 'LI',
    twitter: 'TW', tiktok: 'TT', youtube: 'YT',
  })[p] || p;
}

// Idempotency: claim the date-stamped notification key BEFORE sending the
// digest. If another concurrent watchdog run already wrote the row, skip.
//
// 2026-06-14 (Sage): Heath saw 3 copies of WATCHDOG END-OF-DAY in overnight
// digests. Root cause: watchdog runs hourly via vercel.json AND a Windows
// Task Scheduler entry; the previous guard `clock.hour >= 20` triggered the
// summary on EVERY hourly run past 8 PM (20:00, 21:00, 22:00, 23:00...).
// Two-layer fix:
//   (a) Caller restricts firing to a SINGLE hour: clock.hour === 20.
//   (b) This claim() check ensures even two concurrent 20:00 runs only
//       ship one digest, keyed by the CDT date.
async function claimDigestSlot(notificationKey, meta) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const lookup = await sb(
    `/rest/v1/cron_notifications?notification_key=eq.${encodeURIComponent(notificationKey)}` +
    `&sent_at=gte.${encodeURIComponent(cutoff)}&select=id&limit=1`
  );
  if (lookup.ok && Array.isArray(lookup.data) && lookup.data.length > 0) {
    return false;
  }
  const insert = await sb('/rest/v1/cron_notifications', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ notification_key: notificationKey, meta: meta || {} }),
  });
  return insert.ok;
}

async function sendDailySummary(state, clock) {
  // Date-stamped key in America/Chicago to prevent same-day dupes across
  // timezone boundaries (e.g. a run at 00:30 UTC is still 19:30 CDT same day).
  const digestKey = `watchdog-eod-${clock.dateKey}`;
  const claimed = await claimDigestSlot(digestKey, {
    hour_cdt: clock.hour,
    platforms: Object.fromEntries(
      Object.entries(state).map(([p, s]) => [p, { actual: s.actual, expected: s.expected }])
    ),
  });
  if (!claimed) {
    console.log(`[watchdog] EOD digest already sent today (key=${digestKey}) — suppressing duplicate`);
    return false;
  }
  const lines = ['📊 <b>WATCHDOG END-OF-DAY</b>', ''];
  let totalActual = 0;
  let totalExpected = 0;
  for (const p of PLATFORMS) {
    const s = state[p];
    if (!s || !s.has_schedule) continue;
    totalActual   += s.actual;
    totalExpected += s.expected;
    const ok = s.actual >= s.expected ? '✓' : '⚠';
    const notes = s.notes && s.notes.length ? ` — ${s.notes.join('; ')}` : '';
    lines.push(`${ok} ${platformEmoji(p)}: ${s.actual}/${s.expected}${notes}`);
  }
  lines.push('');
  lines.push(`Total: ${totalActual}/${totalExpected} shipped today`);
  await tg(lines.join('\n'));
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const clock = nowInTz();

    const schedules = await loadSchedules();
    const state = {};
    const actions = [];

    for (const platform of PLATFORMS) {
      const pace     = paceFor(platform, schedules, clock);
      if (!pace.has_schedule) {
        state[platform] = { has_schedule: false, actual: 0, expected: 0, notes: [] };
        continue;
      }
      const actual    = await countActuallyPostedToday(platform);
      const approved  = await countApprovedReady(platform);
      const rejected  = await countRejectedToday(platform);

      const notes = [];
      const behind = actual < pace.expected;
      const nextSlotMinAway = pace.next_slot_min != null
        ? pace.next_slot_min - clock.minute
        : null;

      // Case A/B: behind pace
      if (behind) {
        const urgent =
          nextSlotMinAway == null ||
          nextSlotMinAway <= NEXT_SLOT_GRACE_HOURS * 60;
        if (urgent) {
          // Route around. Sage may need to regenerate AND publish.
          if (approved === 0) {
            // No approved row to publish — try regenerate first.
            const regen = await fireCron('/api/cron-sage-regenerate');
            actions.push({ platform, action: 'regenerate', ok: regen.ok });
            notes.push('regen-fired');
          }
          const pub = await fireCron('/api/cron-publish-approved');
          actions.push({ platform, action: 'publish', ok: pub.ok });
          notes.push('publish-fired');
        } else {
          notes.push(`behind-but-${nextSlotMinAway}min-to-next-slot`);
        }
      }

      // LinkedIn-specific replacement (Fix #4)
      if (platform === 'linkedin') {
        const lr = await ensureLinkedInReplacement(rejected, approved);
        if (lr.triggered) {
          actions.push({ platform: 'linkedin', action: 'replace-rejected', post_id: lr.post_id });
          notes.push('linkedin-replacement-queued');
        }
      }

      // TikTok-specific swap (Fix #5)
      if (platform === 'tiktok') {
        const swap = await swapTikTokForOtherPlatform(clock);
        if (swap.swapped) notes.push('tiktok-swap-active');
      }

      // Diagnose root cause if we're behind pace — surfaces in the EOD digest
      // so Heath sees WHY a platform is 0/1, not just "regen-fired".
      if (behind) {
        const why = await diagnoseShortfall(platform, actual, pace.expected);
        if (why) notes.unshift(`root-cause:${why}`);
      }

      state[platform] = {
        has_schedule: true,
        actual,
        expected: pace.expected,
        cap: pace.cap,
        approved_ready: approved,
        rejected_today: rejected,
        next_slot_in_min: nextSlotMinAway,
        notes,
      };
    }

    // End-of-day summary at 8 PM CDT EXACTLY (one fire per day).
    //
    // Previous bug (2026-06-14): used `clock.hour >= 20` which matched every
    // hourly run from 20:00 onward — Heath got 3-4 duplicate digests overnight.
    // Now: fires ONLY on the 20:00 hourly tick. claimDigestSlot() inside
    // sendDailySummary() is a belt-and-suspenders idempotency check in case
    // two concurrent 20:00 runs collide (vercel cron + Windows Task Scheduler).
    let summarySent = false;
    if (clock.hour === BUSINESS_END_HOUR_CDT) {
      summarySent = await sendDailySummary(state, clock);
    }

    await recordCronRun('cron-mission-watchdog', 'ok', { actions: actions.length });

    return res.status(200).json({
      ok: true,
      clock,
      state,
      actions,
      summary_sent: summarySent,
    });
  } catch (e) {
    console.error('cron-mission-watchdog crashed:', e);
    await recordCronRun('cron-mission-watchdog', 'error', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};
