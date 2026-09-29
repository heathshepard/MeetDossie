'use strict';

// scripts/_lib/fb-post-verify-outcome.js
//
// Pure decision function for "what actually happened to this group post (or
// threaded comment reply) submit" -- extracted from scripts/fb-group-poster.js
// so the core fix is unit-testable without launching Chrome. Deliberately
// generic (signals in, status/reason/posted out) so it is shared, not
// duplicated: scripts/fb-reply-poster.js reuses it as of 2026-09-17 for the
// same false-'posted' shape found in the group-post pipeline (see below) --
// a reply was marked 'posted' purely because no exception was thrown, with
// no check that the reply actually rendered in the thread.
//
// THE 2026-09-16 BUG (false 'posted' rows)
// -----------------------------------------
// The old logic treated ANY of these as proof the post went live:
//   - the composer dialog closing after clicking Post
//   - no error banner appearing within 30s
//   - falling back to the group's own URL as "post_url" when no real
//     /groups/<id>/posts/<id> permalink could be found
// None of those is positive evidence a post exists. Real-world result: 6 of
// the last ~20 group_posts rows read status='posted' with nothing on
// Facebook (Founding Files, All about Real Estate Houston x1, Real Estate
// in Austin TX x2, Boerne Real Estate, Stone Oak Neighborhood) -- verified
// live 2026-09-16.
//
// THE FIX
// -------
// status='posted' requires POSITIVE evidence only: a real permalink
// captured, or the post located afterward in the group's feed (text/DOM
// match). Composer-closed and no-error-shown are demoted to weak signals
// that a submit action occurred (worth recording as a fact -- e.g. to gate
// spacing/dedupe -- but never sufficient to mark 'posted').
//
// Distinguishable outcomes are threaded through, not one "failed" bucket
// (per-group truth audit, 2026-09-16; extended for replies 2026-09-17):
//   - pending_admin_approval  (existing, unchanged -- 2026-09-14 fix)
//   - identity_rejected       (Page blocked from the group entirely)
//   - not_a_member            (account/Page never joined)
//   - blocked                 (2026-09-17, reply-poster fix -- Facebook
//                              blocked/removed the content itself after a
//                              real submit occurred, e.g. "you're temporarily
//                              blocked from commenting" or the comment was
//                              auto-removed. Distinct from identity_rejected/
//                              not_a_member, which are pre-submit group-
//                              access gates; `blocked` fires post-submit and
//                              is equally terminal/non-retryable)
//   - failed                  (genuinely failed -- an explicit FB error, OR
//                              a submit with no confirmable evidence either
//                              way; the `reason` field is what distinguishes
//                              those two failed sub-cases for a human
//                              reading the row -- see the
//                              'unconfirmed_submit' marker below, which
//                              callers use to tell "submitted but not found"
//                              apart from an explicit error)

function resolvePostStatus(signals = {}) {
  const {
    identityRejected = false,
    notAMember = false,
    pendingApproval = false,
    blocked = false,
    blockedReason = null,
    errorShown = false,
    errorText = null,
    permalinkFound = false,
    feedConfirmed = false,
  } = signals;

  // Order matters -- identity/membership/blocked gates are checked first
  // because they can co-occur with a stray error banner or a closed
  // composer, and they're the more specific, more actionable diagnosis.
  if (identityRejected) {
    return {
      status: 'identity_rejected',
      reason: 'Facebook blocked posting under the current acting identity (Page vs. personal profile restriction) -- see scripts/_lib/fb-group-access-detect.js',
      posted: false,
    };
  }

  if (notAMember) {
    return {
      status: 'not_a_member',
      reason: 'the acting account/Page is not a member of this group -- post never had a path to publish',
      posted: false,
    };
  }

  if (blocked) {
    return {
      status: 'blocked',
      reason: blockedReason || 'Facebook blocked or removed the content after submit',
      posted: false,
    };
  }

  if (pendingApproval) {
    return {
      status: 'pending_admin_approval',
      reason: null,
      posted: false,
    };
  }

  if (permalinkFound || feedConfirmed) {
    return {
      status: 'posted',
      reason: null,
      posted: true,
    };
  }

  if (errorShown) {
    return {
      status: 'failed',
      reason: `facebook showed an error: ${errorText || 'unknown error'}`,
      posted: false,
    };
  }

  // No positive evidence either way. This is the exact false-positive this
  // fix closes -- previously defaulted to 'posted'.
  return {
    status: 'failed',
    reason: 'unconfirmed_submit: composer closed / no error shown, but no permalink captured and no feed match found -- verify on Facebook manually before retrying (do not blindly re-post, may have actually gone live)',
    posted: false,
  };
}

module.exports = { resolvePostStatus };
