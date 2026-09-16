'use strict';

// api/_lib/social-goals.js
//
// SINGLE SOURCE OF TRUTH for per-account social growth targets. Editable
// config, never hardcode a target/period inline in a cron script body — read
// it from here.
//
// WHY (Heath, 2026-09-16): Facebook's own "Professional dashboard" sets
// explicit weekly targets for the Dossie Page (screenshot, 2026-09-16,
// "80% remaining"):
//   - Create 23 new public posts            (10/23 as of the screenshot)
//   - Reply to 5 comments                   (0/5)
//   - Create 7 new group posts               (0/7)
//   - Create 23 new public posts with photos (0/23)
//   Weekly focus: "Reach more people"
//
// These numbers are READ OFF A SCREENSHOT OF FACEBOOK'S OWN UI — Meta does
// not expose Page-dashboard suggested-goal targets via any API we have
// access to (Zernio doesn't surface them either). There is no live pull.
// Whoever reads the next week's dashboard (Heath or an agent working from a
// new screenshot) updates `period` + `targets.*.target` here. If this file
// goes stale (now > period.end), every consumer must say so explicitly
// rather than silently grading against an expired target — see
// isPeriodExpired() below, and api/cron-silence-alarm.js's heartbeat
// section which surfaces it every morning.
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

    // Facebook's own dashboard runs Monday-Sunday. Update BOTH dates and
    // every target below when a new screenshot comes in for the next
    // period — this file does not auto-roll itself (see file header).
    period: {
      start: '2026-09-14', // Monday
      end: '2026-09-20',   // Sunday, inclusive
    },

    targets: {
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
 * Returns { start: Date, end: Date } as real Date objects (end = 23:59:59.999
 * UTC on the end date, inclusive).
 */
function periodBounds(period) {
  const start = new Date(`${period.start}T00:00:00.000Z`);
  const end = new Date(`${period.end}T23:59:59.999Z`);
  return { start, end };
}

/**
 * True once `now` is past the period's end — the config has gone stale and
 * needs a fresh screenshot + edit before its numbers mean anything.
 */
function isPeriodExpired(period, now = new Date()) {
  const { end } = periodBounds(period);
  return now.getTime() > end.getTime();
}

function getGoalSet(key) {
  return SOCIAL_GOALS[key] || null;
}

function listGoalSetKeys() {
  return Object.keys(SOCIAL_GOALS);
}

module.exports = {
  SOCIAL_GOALS,
  periodBounds,
  isPeriodExpired,
  getGoalSet,
  listGoalSetKeys,
};
