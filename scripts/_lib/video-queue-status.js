'use strict';

// scripts/_lib/video-queue-status.js
//
// THE ONE PLACE the local video pipeline names a video_library status.
//
// ---------------------------------------------------------------------------
// WHY A FILE FOR FIVE STRINGS
// ---------------------------------------------------------------------------
// On 2026-09-18 video_library held FIVE rows across THREE different
// pre-approval statuses simultaneously, written by three different lanes:
//
//   'approved'              queue-finished-videos.py / register-video.js
//   'ready'                 feature-demo-publish.js
//   'pending_approval'      cron-video-approval.js  <- read by nothing
//   'pending_heath_review'  cron-post-videos.js
//   'heath_approved'        telegram-webhook.js approve callback
//
// Two of those lanes are dead ends. api/_lib/silence-alarm.js calls
// 'pending_approval' out by name: "the dead-end status Carter found 2026-09-17:
// 9 rows sat here for up to 4 months because pending_approval is only ever a
// CRON-WRITTEN transient state." The column has no CHECK constraint, so a typo
// or a new lane inventing its own word is silently accepted and the row simply
// never moves again.
//
// A separate change was consolidating these on the same day. Rather than race
// it or guess the winner, everything this pipeline writes or queries goes
// through the constants below. When that consolidation lands, this file is the
// single edit — not a grep across a dozen scripts, half of which would be
// missed.
//
// ---------------------------------------------------------------------------
// THE VALUES, AND WHY THESE ONES
// ---------------------------------------------------------------------------
// These are not a proposal; they are what the live posting path ACTUALLY reads
// today, verified against api/cron-post-videos.js and 23 rows that reached
// 'posted' through it:
//
//   STATUS_AWAITING_NOTIFY = 'approved'
//       cron-post-videos.js STEP 1 selects `status=eq.approved`. The name is a
//       trap and worth stating plainly: 'approved' does NOT mean Heath approved
//       it. It means "ingested, quality gate passed, ready to be SENT to him."
//       Anyone reading a DB dump will misread this; that is a naming problem
//       for the consolidation to fix, not a reason for this pipeline to invent
//       a sixth word.
//
//   STATUS_AWAITING_HEATH = 'pending_heath_review'
//       Set by cron-post-videos.js once the card is sent (or batched into the
//       morning brief). Waiting on a human.
//
//   STATUS_GREENLIT = 'heath_approved'
//       Set by the Telegram approve callback. The ONLY status
//       cron-post-videos.js STEP 2 will actually publish.
//
// A generator must write STATUS_AWAITING_NOTIFY and nothing further along.
// Writing STATUS_AWAITING_HEATH directly is the specific bug that strands a
// video: cron-post-videos.js never selects that status, so the row is past the
// only step that would have notified anyone, and it waits forever for an
// approval nobody was asked for.

/** Gate-passed, queued, NOT yet put in front of Heath. What a producer writes. */
const STATUS_AWAITING_NOTIFY = 'approved';

/** Notification sent (or batched into the brief). Waiting on a human. */
const STATUS_AWAITING_HEATH = 'pending_heath_review';

/** Heath tapped Approve. The only status that publishes. */
const STATUS_GREENLIT = 'heath_approved';

/** Quality gate failed. Held, never published, never silently dropped. */
const STATUS_QUALITY_HOLD = 'quality_hold';

/** Terminal states. */
const STATUS_POSTED = 'posted';
const STATUS_REJECTED = 'rejected';
const STATUS_FAILED = 'failed';

/**
 * Every status a gate-passed video can sit in while it still needs a human.
 *
 * Includes the two known dead-end/legacy values ('ready', 'pending_approval')
 * on purpose: scripts/check-video-notify-debt.js has to be able to SEE a video
 * stranded in a lane this pipeline does not itself write, or the oldest and
 * most invisible backlog is the one the alarm is blind to.
 */
const ALL_PRE_APPROVAL_STATUSES = [
  STATUS_AWAITING_NOTIFY,
  STATUS_AWAITING_HEATH,
  'ready',
  'pending_approval',
];

module.exports = {
  STATUS_AWAITING_NOTIFY,
  STATUS_AWAITING_HEATH,
  STATUS_GREENLIT,
  STATUS_QUALITY_HOLD,
  STATUS_POSTED,
  STATUS_REJECTED,
  STATUS_FAILED,
  ALL_PRE_APPROVAL_STATUSES,
};
