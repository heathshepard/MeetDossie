'use strict';

// api/_lib/social-goals-progress.js
//
// Pacing math + real-count queries for the per-account targets configured
// in api/_lib/social-goals.js. Two consumers:
//   - api/cron-weekly-content-scheduler.js — decides how much EXTRA
//     Facebook generation to request per day, prioritizing whichever
//     target is furthest behind pace.
//   - api/_lib/silence-alarm.js — folds computeGoalProgress() output into
//     the daily heartbeat so Heath sees target/current/remaining/days-left/
//     on-pace-or-behind every morning without opening Facebook.
//
// IMPORTANT — these counts are OUR OWN posted records (social_posts,
// group_posts, social_comment_replies), never a pull from Facebook's API.
// We have no API access to Facebook's Page-dashboard suggested-goal
// counters. Every formatted output from this file says so explicitly —
// never present these numbers as if they were read live from Facebook.
//
// Owner: Carter, 2026-09-16

const { getGoalSet, periodBounds, isPeriodExpired } = require('./social-goals.js');

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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function iso(d) {
  return d.toISOString();
}

// ─── pure pacing math (no network — directly unit-testable) ──────────────

/**
 * @param {object} opts
 * @param {number} opts.target
 * @param {number} opts.current      real count so far this period
 * @param {Date}   opts.start
 * @param {Date}   opts.end          inclusive
 * @param {Date}   [opts.now]
 * @param {number} [opts.dailyCap]   real ceiling this target can ever produce
 *                                   per day (e.g. a Heath-approved posting
 *                                   cap). Omit if there is no automated
 *                                   daily ceiling (fully manual action).
 * @returns pacing summary — never divides by zero, never negative days.
 */
function computePacing({ target, current, start, end, now = new Date(), dailyCap = null }) {
  // `end` is constructed (see periodBounds()) as 23:59:59.999 UTC on the
  // last calendar day of the period, i.e. exactly (N days - 1ms) after
  // `start`'s midnight for an N-day inclusive period — so a plain rounded
  // division already yields the correct inclusive day count with no
  // separate "+1". (Verified: a 1-day period diffs to 0.99999 days -> 1;
  // a 7-day Mon-Sun period diffs to 6.99999 days -> 7.)
  const totalMs = end.getTime() - start.getTime();
  const daysTotal = Math.max(1, Math.round(totalMs / 86400000));
  const clampedNow = Math.min(Math.max(now.getTime(), start.getTime()), end.getTime());
  const elapsedMs = clampedNow - start.getTime();
  const daysElapsed = Math.max(0, elapsedMs / 86400000);
  const periodEnded = now.getTime() > end.getTime();
  // Days left counts TODAY as usable if now is still inside the period.
  const daysLeft = periodEnded
    ? 0
    : Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));

  const remaining = Math.max(0, target - current);
  const expectedByNow = Math.min(target, (target * daysElapsed) / daysTotal);
  const perDayNeeded = daysLeft > 0 ? remaining / daysLeft : (remaining > 0 ? Infinity : 0);

  let reachable = null; // null = unknown (no dailyCap configured for this target)
  if (dailyCap != null) {
    reachable = periodEnded ? current >= target : (dailyCap * daysLeft) >= remaining;
  }

  let paceStatus;
  if (periodEnded) {
    paceStatus = current >= target ? 'period_ended_met' : 'period_ended_missed';
  } else if (current >= target) {
    paceStatus = 'met';
  } else if (current >= expectedByNow - 1e-9) {
    paceStatus = 'on_pace';
  } else {
    paceStatus = 'behind';
  }
  if (paceStatus === 'behind' && reachable === false) paceStatus = 'unreachable';

  return {
    target,
    current,
    remaining,
    daysTotal,
    daysElapsed: Math.round(daysElapsed * 10) / 10,
    daysLeft,
    expectedByNow: Math.round(expectedByNow * 10) / 10,
    perDayNeeded: Number.isFinite(perDayNeeded) ? Math.round(perDayNeeded * 100) / 100 : perDayNeeded,
    periodEnded,
    dailyCap,
    reachable,
    paceStatus,
  };
}

/**
 * The media-overlap rule: a public post carrying media satisfies BOTH the
 * plain post-count target and the photo-count target at once. The combined
 * number of NEW public posts still needed — of which at least
 * `photosPacing.remaining` must carry media — is the max of the two
 * individual remainders, never the sum. Callers must schedule against THIS
 * number, not `postsPacing.remaining + photosPacing.remaining`, or the
 * media overlap gets double-counted.
 */
function combinedPublicPostNeed(postsPacing, photosPacing) {
  return {
    totalRemaining: Math.max(postsPacing.remaining, photosPacing.remaining),
    mustCarryMedia: photosPacing.remaining,
    plainOk: Math.max(0, postsPacing.remaining - photosPacing.remaining),
  };
}

// ─── real counts (network) ────────────────────────────────────────────────

async function countPublicPosts({ platform, target_owner, start, end }) {
  const res = await supabaseFetch(
    `/rest/v1/social_posts?platform=eq.${encodeURIComponent(platform)}`
    + `&target_owner=eq.${encodeURIComponent(target_owner)}&status=eq.posted`
    + `&posted_at=gte.${encodeURIComponent(iso(start))}&posted_at=lte.${encodeURIComponent(iso(end))}`
    + '&select=media_url',
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const total = res.data.length;
  const withMedia = res.data.filter((r) => r.media_url).length;
  return { total, withMedia };
}

async function countGroupPosts({ pipelines, start, end }) {
  // No single OR-filter helper here — query once per pipeline value
  // (including null) and sum. Works against real PostgREST AND the
  // regression mock without needing `or=(...)` filter support either place.
  let total = 0;
  for (const pipeline of pipelines) {
    const pipelineFilter = pipeline === null ? 'pipeline=is.null' : `pipeline=eq.${encodeURIComponent(pipeline)}`;
    const res = await supabaseFetch(
      `/rest/v1/group_posts?${pipelineFilter}&status=eq.posted`
      + `&posted_at=gte.${encodeURIComponent(iso(start))}&posted_at=lte.${encodeURIComponent(iso(end))}`
      + '&select=id',
    );
    if (!res.ok || !Array.isArray(res.data)) return null;
    total += res.data.length;
  }
  return total;
}

async function countCommentReplies({ platform, start, end }) {
  const res = await supabaseFetch(
    `/rest/v1/social_comment_replies?platform=eq.${encodeURIComponent(platform)}&reply_status=eq.posted`
    + `&created_at=gte.${encodeURIComponent(iso(start))}&created_at=lte.${encodeURIComponent(iso(end))}`
    + '&select=id',
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  return res.data.length;
}

/**
 * Builds the full progress report for one configured goal set.
 * Returns null if the goal set key doesn't exist.
 */
async function computeGoalProgress(goalSetKey, { now = new Date() } = {}) {
  const goalSet = getGoalSet(goalSetKey);
  if (!goalSet) return null;

  const { start, end } = periodBounds(goalSet.period);
  const expired = isPeriodExpired(goalSet.period, now);

  const [publicPostCounts, groupPostTotal, commentReplyTotal] = await Promise.all([
    countPublicPosts({ platform: goalSet.platform, target_owner: goalSet.target_owner, start, end }),
    countGroupPosts({ pipelines: goalSet.targets.group_posts.group_post_pipelines, start, end }),
    countCommentReplies({ platform: goalSet.platform, start, end }),
  ]);

  const queryFailed = publicPostCounts === null || groupPostTotal === null || commentReplyTotal === null;

  const postsPacing = computePacing({
    target: goalSet.targets.public_posts.target,
    current: publicPostCounts ? publicPostCounts.total : 0,
    start, end, now,
  });
  const photosPacing = computePacing({
    target: goalSet.targets.public_posts_with_photos.target,
    current: publicPostCounts ? publicPostCounts.withMedia : 0,
    start, end, now,
  });
  const groupPacing = computePacing({
    target: goalSet.targets.group_posts.target,
    current: groupPostTotal || 0,
    start, end, now,
    dailyCap: goalSet.targets.group_posts.daily_cap,
  });
  const commentPacing = computePacing({
    target: goalSet.targets.comment_replies.target,
    current: commentReplyTotal || 0,
    start, end, now,
  });

  return {
    goalSetKey,
    label: goalSet.label,
    weekly_focus: goalSet.weekly_focus,
    period: goalSet.period,
    period_expired: expired,
    query_failed: queryFailed,
    note: 'Counts are OUR OWN posted records (social_posts / group_posts / social_comment_replies) — Facebook does not expose its dashboard target counters to us.',
    targets: {
      public_posts: { label: goalSet.targets.public_posts.label, ...postsPacing },
      public_posts_with_photos: { label: goalSet.targets.public_posts_with_photos.label, ...photosPacing },
      group_posts: {
        label: goalSet.targets.group_posts.label,
        ...groupPacing,
        note: groupPacing.reachable === false
          ? `Unreachable at the current ${goalSet.targets.group_posts.daily_cap}/day group-post cap with ${groupPacing.daysLeft} day(s) left — will under-deliver unless the cap itself changes (Heath's call, not this cron's).`
          : undefined,
      },
      comment_replies: {
        label: goalSet.targets.comment_replies.label,
        ...commentPacing,
        note: 'Manual action — no automated publisher posts replies yet (api/cron-comment-monitor.js only drafts). This count stays 0 until either that ships or real replies get logged here.',
      },
    },
    combined_public_post_need: combinedPublicPostNeed(postsPacing, photosPacing),
    scheduler: goalSet.scheduler,
  };
}

function formatGoalProgressLines(progress) {
  if (!progress) return [];
  const lines = [];
  lines.push(`GOALS (${progress.label}, ${progress.period.start} to ${progress.period.end}, focus: "${progress.weekly_focus}") — our counts, not Facebook's:`);
  if (progress.period_expired) {
    lines.push('  ⚠ PERIOD EXPIRED — api/_lib/social-goals.js needs a fresh Facebook dashboard screenshot + updated period/targets before these numbers mean anything.');
  }
  if (progress.query_failed) {
    lines.push('  ⚠ one or more count queries failed — numbers below may be incomplete.');
  }
  for (const key of ['public_posts', 'public_posts_with_photos', 'group_posts', 'comment_replies']) {
    const t = progress.targets[key];
    const paceLabel = {
      met: 'MET', on_pace: 'on pace', behind: 'BEHIND', unreachable: 'UNREACHABLE',
      period_ended_met: 'met (period ended)', period_ended_missed: 'MISSED (period ended)',
    }[t.paceStatus] || t.paceStatus;
    lines.push(`  ${t.label}: ${t.current}/${t.target} (${t.remaining} left, ${t.daysLeft}d left) — ${paceLabel}${t.note ? ` — ${t.note}` : ''}`);
  }
  return lines;
}

module.exports = {
  computePacing,
  combinedPublicPostNeed,
  countPublicPosts,
  countGroupPosts,
  countCommentReplies,
  computeGoalProgress,
  formatGoalProgressLines,
};
