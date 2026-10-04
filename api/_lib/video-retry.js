'use strict';

// api/_lib/video-retry.js
//
// FAILED-RETRYABLE STATE MODEL (Atlas, 2026-10-03 — "three days and no
// video" incident). video 8 (dossie-trec-12b-contribution-2026-10-02 and
// its -heath sibling) was scheduled for 2026-10-02. The publishing agent
// hung ~27h on a stuck MCP call and never wrote the real caption.
// cron-post-videos.js's own publish-time safety check correctly refused to
// post an empty caption and flipped BOTH rows to status='failed'. Nothing
// published on 10-02 or 10-03. Once 'failed', the rows were invisible to
// BOTH guards that should have caught the gap:
//   - checkNoVideoScheduledToday (silence-alarm.js) only reads
//     approved/pending_heath_review/heath_approved — 'failed' reads as
//     "nothing exists" rather than "something is owed and broken".
//   - the video-priority reservation (video-reservation.js) only reserves
//     for heath_approved/pending_heath_review — once 'failed', text posts
//     freely took the platform slot a retry would have needed.
//
// WHY A DISTINCT STATUS, NOT JUST A REASON COLUMN ON 'failed'
// -------------------------------------------------------------------------
// video_library.status='failed' is already read elsewhere as a TERMINAL,
// needs-a-human state (buildHeartbeatSnapshot's videoFailed count; the
// 20260930f CHECK constraint's own comment distinguishes 'failed' from
// 'posted_partial' on exactly this basis). Overloading 'failed' with "maybe
// retryable" rows would make every existing 'failed' consumer either start
// silently counting mid-retry rows that aren't alarm-worthy yet, or have to
// learn a new reason column just to keep its old meaning. A separate status
// keeps 'failed' unambiguous and gives this one narrow lifecycle its own
// name:
//
//   heath_approved -> (recoverable publish-time block) -> failed_retryable
//     -> EITHER back to heath_approved (precondition fixed, retry_count++)
//     -> OR terminal 'failed' (precondition still broken AND retries
//        exhausted)
//
// WHAT COUNTS AS "RECOVERABLE" (auto-retryable) VS NOT
// -------------------------------------------------------------------------
// Only the two publish-time checks in cron-post-videos.js that run BEFORE
// any Zernio call — invalid caption, and the Rust store/download CTA
// guard — are auto-retryable. Both are purely a property of the row's own
// `caption` column; a human/script rewriting the caption makes the row
// postable again with zero other state change, and re-checking is just
// re-running the same cheap, pure, local check.
//
// A Zernio delivery failure (an actual post attempt was made and REJECTED)
// goes straight to plain 'failed', never 'failed_retryable' — there is no
// cheap way from here to tell "transient Zernio hiccup" from "this video
// file is actually broken", and Heath's instruction is explicit: a
// genuinely broken video must stay failed and must not be auto-retried
// into the queue. Same posture for quality-gate holds, which never reach
// this module at all — verify-video-quality.js routes those to
// quality_status='held', a separate lifecycle this file does not touch.
//
// RETRY CAP
// -------------------------------------------------------------------------
// MAX_VIDEO_RETRIES auto-retries per row (tracked in video_library.
// retry_count). A row whose retry_count has already reached the cap is
// never re-armed again, even if its caption now looks valid — it is
// flipped to terminal 'failed' instead, and the alarm fires a distinct
// exhaustion key (video_failed_retryable_exhausted) so hitting the cap is
// visible rather than a row that quietly stops trying forever.

const MAX_VIDEO_RETRIES = 3;

// Byte-for-byte the same validity check cron-post-videos.js runs on a
// candidate's caption before trusting it — extracted here so the alarm's
// self-heal precondition check can never drift from the publish-time gate
// it is re-validating.
function isCaptionValid(caption) {
  const c = (caption || '').trim().toLowerCase();
  if (!c) return false;
  if (c.startsWith('pulled')) return false;
  if (c.includes('do not repost')) return false;
  if (c.includes('internal')) return false;
  return true;
}

// Same regex cron-post-videos.js applies to owner='rust' rows (RUST-OWNER-
// WIRING, Heath 2026-09-16): no store/download CTA language before
// iOS/Android are both live.
function hasRustStoreCta(caption) {
  const c = (caption || '').trim().toLowerCase();
  return /\b(download( it)? now|get it on|app store|google play|available now on)\b/.test(c);
}

// Re-runs the SAME gate cron-post-videos.js applies at publish time,
// against the row's CURRENT caption/target_owner. true = the condition that
// caused the original failure no longer holds and the row is safe to
// re-arm.
function isRetryPreconditionMet(row) {
  if (!row) return false;
  if (!isCaptionValid(row.caption)) return false;
  if ((row.target_owner || 'dossie') === 'rust' && hasRustStoreCta(row.caption)) return false;
  return true;
}

// Only these failure_reason values are ever considered for auto-retry. A
// row that somehow lands in failed_retryable with any other reason
// (defensive — no current cron-post-videos.js call site produces one) is
// treated the same as "precondition not met": the alarm alerts, it never
// self-heals.
const AUTO_RETRYABLE_REASONS = new Set(['invalid_caption', 'rust_store_cta']);

function isAutoRetryableReason(reason) {
  return AUTO_RETRYABLE_REASONS.has(reason);
}

module.exports = {
  MAX_VIDEO_RETRIES,
  AUTO_RETRYABLE_REASONS,
  isCaptionValid,
  hasRustStoreCta,
  isRetryPreconditionMet,
  isAutoRetryableReason,
};
