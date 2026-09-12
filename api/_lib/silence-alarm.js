'use strict';

// api/_lib/silence-alarm.js
//
// Shared detection logic for api/cron-silence-alarm.js. Split out so the
// conditions can be unit-tested against a mock PostgREST server without
// spinning up the whole cron handler (see
// scripts/regression-silence-alarm.js).
//
// Heath, 2026-09-12: three separate silent failures hit him this week and
// nobody noticed until he said something. This is the monitor that closes
// that gap — checked conditions:
//   1. Platform silence — no successful post on a (platform, target_owner)
//      pair in N days (default 3), even though that pair is clearly still
//      "in use" (has recent generation activity).
//   2. Approvals sitting >48h without publishing.
//   3. Drafts sitting >24h that were never even sent to Telegram for review.
//   4. A status accumulating rows without moving — the exact
//      video_failed/pending_video pattern that jammed Instagram/TikTok, PLUS
//      video_library rows stuck at pending_heath_review (sent to Telegram,
//      never tapped).
//
// Dedup: api/_lib/weekly-batch-digest.js's sibling table, alert_state — one
// row per condition key, alerts only if not already fired in the last
// ALERT_COOLDOWN_HOURS.
//
// Owner: Carter, 2026-09-12

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SILENCE_DAYS_DEFAULT = 3;
const APPROVAL_STALE_HOURS = 48;
const DRAFT_STALE_HOURS = 24;
const BACKLOG_THRESHOLD = 5;
const VIDEO_REVIEW_STALE_HOURS = 48;
const ALERT_COOLDOWN_HOURS = 20; // < 24 so a once-daily cron always re-fires next day, never skips one

// (platform, target_owner) pairs worth tracking. Kept explicit (not derived
// from zernio_accounts) so a brand-new/experimental owner doesn't silently
// start alerting before anyone's decided it should be monitored — see
// docs/PIPELINE.md "SOCIAL MEDIA ACCOUNTS" / "ZERNIO ACCOUNT IDs" for the
// live account roster this mirrors.
const TRACKED_PAIRS = [
  { platform: 'facebook', target_owner: 'dossie' },
  { platform: 'instagram', target_owner: 'dossie' },
  { platform: 'twitter', target_owner: 'dossie' },
  { platform: 'linkedin', target_owner: 'dossie' },
  { platform: 'tiktok', target_owner: 'dossie' },
  { platform: 'facebook', target_owner: 'heath-realtor' },
  { platform: 'instagram', target_owner: 'heath-realtor' },
];

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

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgoIso(days) {
  return hoursAgoIso(days * 24);
}

// ─── condition detectors ──────────────────────────────────────────────────

// 1. Platform silence.
async function checkPlatformSilence(silenceDays = SILENCE_DAYS_DEFAULT) {
  const results = [];
  const sinceRecentActivity = daysAgoIso(30);
  const sinceThreshold = daysAgoIso(silenceDays);

  for (const { platform, target_owner } of TRACKED_PAIRS) {
    const ownerFilter = `&target_owner=eq.${encodeURIComponent(target_owner)}`;

    // Only alert on pairs with real recent generation activity — otherwise
    // a pair that's intentionally dormant (e.g. no content plan yet) would
    // alarm forever.
    const activity = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}${ownerFilter}` +
      `&created_at=gte.${encodeURIComponent(sinceRecentActivity)}&select=id&limit=1`,
    );
    const hasRecentActivity = activity.ok && Array.isArray(activity.data) && activity.data.length > 0;
    if (!hasRecentActivity) continue;

    const lastPosted = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}${ownerFilter}` +
      `&status=eq.posted&select=posted_at&order=posted_at.desc&limit=1`,
    );
    const lastPostedAt = lastPosted.ok && Array.isArray(lastPosted.data) && lastPosted.data[0]
      ? lastPosted.data[0].posted_at
      : null;

    const silent = !lastPostedAt || lastPostedAt < sinceThreshold;
    if (!silent) continue;

    // Likely-reason: what's actually backed up for this pair right now.
    const backlog = await supabaseFetch(
      `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}${ownerFilter}` +
      `&status=in.(pending_video,video_failed,draft,approved)&select=status`,
    );
    const counts = {};
    if (backlog.ok && Array.isArray(backlog.data)) {
      for (const row of backlog.data) counts[row.status] = (counts[row.status] || 0) + 1;
    }
    const reasonParts = Object.entries(counts).map(([status, n]) => `${n} ${status}`);
    const reason = reasonParts.length ? reasonParts.join(', ') + ' rows sitting unpublished' : 'no backlog found — check Zernio connection';

    const days = lastPostedAt
      ? Math.floor((Date.now() - new Date(lastPostedAt).getTime()) / (24 * 60 * 60 * 1000))
      : null;

    results.push({
      key: `silence:${platform}:${target_owner}`,
      platform,
      target_owner,
      last_posted_at: lastPostedAt,
      days_silent: days,
      reason,
      message: `${platform}${target_owner !== 'dossie' ? ` (${target_owner})` : ''} has not posted in ${days != null ? `${days} days` : 'ever'} (last: ${lastPostedAt || 'never'}). Likely reason: ${reason}.`,
    });
  }
  return results;
}

// 2. Approvals older than 48h still not published.
async function checkStaleApprovals(staleHours = APPROVAL_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const results = [];

  const social = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.approved&approved_at=lt.${encodeURIComponent(cutoff)}&select=id,platform,approved_at&order=approved_at.asc`,
  );
  if (social.ok && Array.isArray(social.data) && social.data.length > 0) {
    results.push({
      key: 'approvals_stale:social_posts',
      count: social.data.length,
      oldest: social.data[0],
      message: `${social.data.length} social_posts row(s) approved >${staleHours}h ago still not published (oldest: ${social.data[0].platform}, approved ${social.data[0].approved_at}).`,
    });
  }

  const group = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.approved&approved_at=lt.${encodeURIComponent(cutoff)}&select=id,group_name,approved_at&order=approved_at.asc`,
  );
  if (group.ok && Array.isArray(group.data) && group.data.length > 0) {
    results.push({
      key: 'approvals_stale:group_posts',
      count: group.data.length,
      oldest: group.data[0],
      message: `${group.data.length} group_posts row(s) approved >${staleHours}h ago still not posted (oldest: ${group.data[0].group_name}, approved ${group.data[0].approved_at}).`,
    });
  }

  return results;
}

// 3. Drafts older than 24h never sent for approval.
async function checkStaleDrafts(staleHours = DRAFT_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const results = [];

  const social = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&telegram_sent_at=is.null&created_at=lt.${encodeURIComponent(cutoff)}&select=id,platform,created_at&order=created_at.asc`,
  );
  if (social.ok && Array.isArray(social.data) && social.data.length > 0) {
    results.push({
      key: 'drafts_stale:social_posts',
      count: social.data.length,
      oldest: social.data[0],
      message: `${social.data.length} social_posts draft(s) >${staleHours}h old were never sent to Telegram for approval (oldest: ${social.data[0].platform}, created ${social.data[0].created_at}).`,
    });
  }

  const group = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.draft&telegram_sent_at=is.null&created_at=lt.${encodeURIComponent(cutoff)}&select=id,group_name,created_at&order=created_at.asc`,
  );
  if (group.ok && Array.isArray(group.data) && group.data.length > 0) {
    results.push({
      key: 'drafts_stale:group_posts',
      count: group.data.length,
      oldest: group.data[0],
      message: `${group.data.length} group_posts draft(s) >${staleHours}h old were never sent to Telegram for approval (oldest: ${group.data[0].group_name}, created ${group.data[0].created_at}).`,
    });
  }

  return results;
}

// 4a. A status accumulating rows without moving — video_failed/pending_video
// pattern on social_posts, per platform.
async function checkAccumulatingBacklog(threshold = BACKLOG_THRESHOLD) {
  const results = [];
  const res = await supabaseFetch(
    `/rest/v1/social_posts?status=in.(pending_video,video_failed)&select=platform,status`,
  );
  if (!res.ok || !Array.isArray(res.data)) return results;

  const counts = {};
  for (const row of res.data) {
    const k = `${row.platform}:${row.status}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  for (const [k, count] of Object.entries(counts)) {
    if (count < threshold) continue;
    const [platform, status] = k.split(':');
    results.push({
      key: `backlog:${platform}:${status}`,
      platform,
      status,
      count,
      message: `${count} ${platform} rows stuck at status='${status}' — accumulating without moving.`,
    });
  }
  return results;
}

// 4b. video_library rows stuck at pending_heath_review (already sent to
// Telegram, waiting on a tap) — the exact mechanism that silenced the
// Instagram/TikTok mobile-cut feature-demo videos in Sept 2026.
async function checkVideoLibraryPendingReview(staleHours = VIDEO_REVIEW_STALE_HOURS) {
  const cutoff = hoursAgoIso(staleHours);
  const res = await supabaseFetch(
    `/rest/v1/video_library?status=eq.pending_heath_review&created_at=lt.${encodeURIComponent(cutoff)}&select=id,topic,platforms,created_at&order=created_at.asc`,
  );
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return [];
  const platforms = new Set();
  for (const row of res.data) {
    for (const p of (row.platforms || [])) platforms.add(p);
  }
  return [{
    key: 'video_library_pending_review',
    count: res.data.length,
    oldest: res.data[0],
    message: `${res.data.length} video(s) in video_library sitting >${staleHours}h at pending_heath_review, targeting [${[...platforms].join(', ') || 'unknown'}] — already sent to Telegram, waiting on your Approve tap (oldest: ${res.data[0].topic}, created ${res.data[0].created_at}).`,
  }];
}

// ─── dedupe ────────────────────────────────────────────────────────────────

async function shouldFire(key) {
  const res = await supabaseFetch(`/rest/v1/alert_state?key=eq.${encodeURIComponent(key)}&select=last_fired_at`);
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return true;
  const lastFiredAt = res.data[0].last_fired_at;
  if (!lastFiredAt) return true;
  return new Date(lastFiredAt).getTime() < Date.now() - ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
}

async function markFired(key, reason, metadata) {
  return supabaseFetch(`/rest/v1/alert_state?on_conflict=key`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      key,
      last_fired_at: new Date().toISOString(),
      last_reason: reason,
      metadata: metadata || null,
      updated_at: new Date().toISOString(),
    }),
  });
}

// Runs every detector, filters through dedupe, marks fired ones. Returns
// { fired: [...], suppressed: [...] } — suppressed = true but already
// alerted within the cooldown window.
async function runAllChecks(opts = {}) {
  const [silence, approvals, drafts, backlog, videoReview] = await Promise.all([
    checkPlatformSilence(opts.silenceDays),
    checkStaleApprovals(opts.approvalStaleHours),
    checkStaleDrafts(opts.draftStaleHours),
    checkAccumulatingBacklog(opts.backlogThreshold),
    checkVideoLibraryPendingReview(opts.videoReviewStaleHours),
  ]);

  const all = [...silence, ...approvals, ...drafts, ...backlog, ...videoReview];
  const fired = [];
  const suppressed = [];

  // dryRun is READ-ONLY: it must never consult or mutate alert_state. A
  // diagnostic peek marking a condition "fired" would make the NEXT real
  // run silently suppress it inside the cooldown window — dry_run would
  // itself become a silent-failure vector. Bug found + fixed same day it
  // shipped (Carter, 2026-09-12): a dry_run call ate 2 of the first real
  // alarm's conditions, including the video_library nudge.
  if (opts.dryRun) {
    return { fired: all, suppressed: [], totalConditions: all.length };
  }

  for (const condition of all) {
    const ok = await shouldFire(condition.key);
    if (ok) {
      fired.push(condition);
      await markFired(condition.key, condition.message, condition);
    } else {
      suppressed.push(condition);
    }
  }

  return { fired, suppressed, totalConditions: all.length };
}

module.exports = {
  TRACKED_PAIRS,
  SILENCE_DAYS_DEFAULT,
  APPROVAL_STALE_HOURS,
  DRAFT_STALE_HOURS,
  BACKLOG_THRESHOLD,
  VIDEO_REVIEW_STALE_HOURS,
  ALERT_COOLDOWN_HOURS,
  checkPlatformSilence,
  checkStaleApprovals,
  checkStaleDrafts,
  checkAccumulatingBacklog,
  checkVideoLibraryPendingReview,
  shouldFire,
  markFired,
  runAllChecks,
};
