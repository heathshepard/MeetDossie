'use strict';

// api/_lib/social-goals.js
//
// SINGLE SOURCE OF TRUTH for per-account social growth targets. Editable
// config, never hardcode a target/period inline in a cron script body — read
// it from here.
//
// WHY (Heath, 2026-09-16): Facebook's own "Professional dashboard" sets
// explicit weekly targets for the Dossie Page. A live browser audit of the
// real dashboard, same day, corrected the FIRST read of that screenshot on
// two counts: (1) the period is Sep 13-19, not Sep 14-20 — Facebook's
// dashboard runs SUNDAY-SATURDAY, not the Monday-Sunday this file
// originally assumed; (2) there are 5 targets, not 4 — "Create 2 new public
// reels" was missed entirely on the first pass. Live numbers, 2026-09-16:
//   - Create 2 new public reels              (2/2 — already done)
//   - Create 23 new public posts             (10/23)
//   - Reply to 5 comments                    (0/5)
//   - Create 7 new group posts               (0/7)
//   - Create 23 new public posts with photos (0/23)
//   Weekly focus: "Reach more people". Dashboard also showed "4 days left,
//   20% complete" as of the 2026-09-16 read (that 20% is Facebook's own
//   composite completion stat across all 5 tasks — not reproduced here,
//   we grade each target on its own pace instead).
//
// These numbers are READ OFF A SCREENSHOT / LIVE VIEW OF FACEBOOK'S OWN
// UI — Meta does not expose Page-dashboard suggested-goal targets via any
// API we have access to (Zernio doesn't surface them either). There is no
// live pull for the NUMBERS. The PERIOD, however, now rolls itself —
// currentWeekPeriod() below computes period.start/period.end fresh from
// `now` every call using period_anchor_weekday, so the boundary dates can
// never silently go stale the way a hardcoded pair of dates did (that is
// exactly how the Mon-Sun assumption above went unnoticed for as long as it
// did). Whoever reads a new week's dashboard only ever needs to update
// `targets.*.target` (if Facebook changes the quotas) and
// `targets_last_verified` — never `period`, which is no longer a field on
// this object at all (see getGoalSet()). If targets_last_verified goes
// stale (> ~8 days old, i.e. nobody has re-confirmed the quotas in over a
// full cycle), every consumer must say so explicitly rather than silently
// grading against numbers that may no longer match this week's real
// targets — see isConfigStale() below, and api/cron-silence-alarm.js's
// heartbeat section which surfaces it every morning.
//
// STRUCTURE: keyed by an arbitrary goal-set id so more accounts/brands can
// be added later (e.g. a `heath_realtor_fb_page` entry) without touching
// any consumer code — api/_lib/social-goals-progress.js and
// api/cron-weekly-content-scheduler.js both iterate whatever's here.
//
// Owner: Carter, 2026-09-16

const SOCIAL_GOALS = {
  dossie_fb_page: {
    label: 'Dossie Facebook Page — Professional dashboard',
    source: 'Manual read of Facebook Page Professional Dashboard screenshot (no API access to these targets) — Heath, 2026-09-16',
    platform: 'facebook',
    target_owner: 'dossie',
    weekly_focus: 'Reach more people',

    // Facebook's own dashboard runs SUNDAY-SATURDAY (confirmed live
    // 2026-09-16 — the displayed period was Sep 13 [Sun] to Sep 19 [Sat]).
    // 0 = Sunday, matching JS Date#getUTCDay(). period.start/period.end are
    // NOT stored here anymore — getGoalSet() computes them fresh from `now`
    // via currentWeekPeriod() every call, so they roll forward automatically
    // instead of needing a manual edit every week (see file header).
    period_anchor_weekday: 0,

    // Date someone last confirmed the TARGET NUMBERS below against a live
    // Facebook dashboard read. The period rolls itself; this does not —
    // isConfigStale() flags it once this goes further than ~8 days old.
    targets_last_verified: '2026-09-16',

    targets: {
      // "Create 2 new public reels" — MISSED on the first pass at this
      // config (2026-09-16); Facebook's dashboard has no API we can poll,
      // and there is no automated publisher tag that marks a social_posts
      // row as a "reel" (video posts and reels aren't distinguished in our
      // schema today) — so this stays a MANUAL snapshot, not a live query,
      // same disclosed-gap pattern as comment_replies below. Re-read the
      // dashboard and update manual_progress every week this target is
      // still open; once genuinely done for a period it can stay flat.
      reels: {
        label: 'Create new public reels',
        target: 2,
        manual_action: true,
        manual_progress: {
          current: 2,
          as_of: '2026-09-16',
          source: 'Live read of Facebook Page Professional Dashboard — Heath/Carter, 2026-09-16, showed 2/2 done',
        },
      },

      // "Create 23 new public posts" — counted against social_posts rows
      // (platform=facebook, target_owner=dossie, status=posted) with
      // posted_at inside the period. Does NOT include group_posts — FB's
      // dashboard tracks those as a separate line item (group_posts below).
      public_posts: {
        label: 'Create new public posts',
        target: 23,
      },

      // "Create 23 new public posts with photos" — a public post that
      // carries an image OR video (social_posts.media_url not null)
      // satisfies BOTH this target and public_posts at once. See
      // api/_lib/social-goals-progress.js's combinedPublicPostNeed() —
      // never schedule/count these as two independent quotas.
      public_posts_with_photos: {
        label: 'Create new public posts with photos',
        target: 23,
        overlaps_with: 'public_posts',
      },

      // "Reply to 5 comments" — counted against social_comment_replies
      // (platform=facebook, reply_status=posted) created inside the
      // period. NOTE (2026-09-16): no automated publisher writes
      // reply_status='posted' to this table yet (api/cron-comment-monitor.js
      // only drafts). This count will legitimately read 0 until either that
      // publisher ships or Heath's real FB replies get logged here some
      // other way — that is a disclosed gap, not a bug, and the heartbeat
      // must say so rather than imply Facebook's real reply count is 0.
      comment_replies: {
        label: 'Reply to comments',
        target: 5,
        manual_action: true, // no automated daily-cap producer for this one
      },

      // "Create 7 new group posts" — a SEPARATE quota from public_posts.
      // Counted against group_posts (status=posted, posted_at in period,
      // pipeline in group_post_pipelines below). Fulfilled exclusively
      // through the existing group-post queue (fb-group5-post-queue.js /
      // scripts/_lib/comment-caps.js's facebook_group_post budget) — never
      // bypass that cap to chase this number.
      group_posts: {
        label: 'Create new group posts',
        target: 7,
        separate_quota: true,
        // Only Dossie-brand group posts count toward THIS page's goal —
        // pipeline='listing-groups' is Heath's personal listing-marketing
        // rotation (Fawndale/Nopalito/Senisa), a different brand entirely,
        // and must never be folded into this count.
        group_post_pipelines: ['daily5', null], // null = legacy/manual Founding Files direct inserts (RULE 4)
        // Real daily ceiling this quota can ever produce against, from
        // scripts/_lib/comment-caps.js PLATFORM_DAILY_CAPS.facebook_group_post
        // (Heath-approved cap; duplicated here as a NUMBER, not re-derived,
        // so this config can flag "unreachable" without importing the
        // caps module's whole dependency chain into every consumer).
        daily_cap: 5,
      },
    },

    // Bounded knob for cron-weekly-content-scheduler.js: how many EXTRA
    // facebook posts (beyond cron-generate-posts.js's normal 2/day fixed
    // slots) it may request per day when public_posts is behind pace.
    // Kept here (not a magic number in the scheduler) so it's one edit to
    // retune. These extra posts are still text-only under the current
    // video-only-no-static-cards policy (docs: cron-generate-posts.js
    // "card_fallback_removed") — they help public_posts, NOT
    // public_posts_with_photos.
    scheduler: {
      max_extra_public_posts_per_day: 2,
    },
  },
};

/**
 * Computes the current Sunday-Saturday (or whatever anchor weekday is
 * configured) 7-day period as {start, end} YYYY-MM-DD strings, anchored to
 * `now` — never a stored pair of dates. All arithmetic in UTC calendar days
 * so this is stable regardless of what local timezone a caller runs in.
 *
 * @param {number} anchorWeekday  0=Sunday..6=Saturday — the day Facebook's
 *   dashboard period starts on.
 * @param {Date}   [now]
 */
function currentWeekPeriod(anchorWeekday, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayWeekday = today.getUTCDay();
  let sinceAnchor = todayWeekday - anchorWeekday;
  if (sinceAnchor < 0) sinceAnchor += 7;
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - sinceAnchor);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const toDateStr = (d) => d.toISOString().slice(0, 10);
  return { start: toDateStr(start), end: toDateStr(end) };
}

/**
 * Returns { start: Date, end: Date } as real Date objects (end = 23:59:59.999
 * UTC on the end date, inclusive).
 */
function periodBounds(period) {
  const start = new Date(`${period.start}T00:00:00.000Z`);
  const end = new Date(`${period.end}T23:59:59.999Z`);
  return { start, end };
}

/**
 * True once the target NUMBERS haven't been re-confirmed against a live
 * Facebook dashboard read in over one full weekly cycle (+1 day buffer).
 * The period itself always rolls forward and can never be "expired" now —
 * this is the replacement staleness signal: it catches the case where
 * nobody has checked whether this week's real targets still match what's
 * hardcoded here.
 */
function isConfigStale(goalSet, now = new Date()) {
  if (!goalSet || !goalSet.targets_last_verified) return true;
  const verified = new Date(`${goalSet.targets_last_verified}T00:00:00.000Z`);
  const daysSince = (now.getTime() - verified.getTime()) / 86400000;
  return daysSince > 8;
}

/**
 * Returns the goal set with `period` computed fresh from `now` — never read
 * `SOCIAL_GOALS[key].period` directly, it doesn't exist; this is the only
 * place period.start/period.end get produced.
 */
function getGoalSet(key, now = new Date()) {
  const goalSet = SOCIAL_GOALS[key];
  if (!goalSet) return null;
  return {
    ...goalSet,
    period: currentWeekPeriod(goalSet.period_anchor_weekday, now),
  };
}

function listGoalSetKeys() {
  return Object.keys(SOCIAL_GOALS);
}

module.exports = {
  SOCIAL_GOALS,
  currentWeekPeriod,
  periodBounds,
  isConfigStale,
  getGoalSet,
  listGoalSetKeys,
};
