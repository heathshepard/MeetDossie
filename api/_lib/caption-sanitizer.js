// api/_lib/caption-sanitizer.js
//
// Guards the public caption text of every social post against leaking internal
// briefing/seed markers into the customer-facing world.
//
// Locked 2026-07-12 after the meetdossie IG account posted the raw
// "[COMPETITOR REMIX SEED] From: TikTok #transactioncoordinator..." briefing
// as the caption of a public Reel. That briefing was Sage's internal prompt to
// guide content generation — never intended for the caption. Root cause:
// scripts/claude-code-task-handlers/competitor_scan.js wrote the seed briefing
// straight into social_posts.content, and cron-auto-approve promoted the
// draft to approved after 30 min silence without transforming it.
//
// This sanitizer is called by cron-publish-approved BEFORE the Zernio push
// happens. Any hit → the row is flipped to status='failed' with a clear
// error_message, the row is never sent to Zernio, and Heath is notified.
//
// Deny markers list is kept small and unambiguous — every entry is text that
// should NEVER appear verbatim in a caption. If a false positive ever bites,
// adjust here, not in the individual generators.
//
// Owner: Atlas 2026-07-12 (leak emergency).

'use strict';

// Leak markers — verbatim strings that should NEVER land in a public caption.
// Ordered rarest-first so the reason string names the strongest signal.
const DENY_MARKERS = [
  '[COMPETITOR REMIX SEED]',
  '[COMPETITOR REMIX]',
  '[SEED]',
  '[BRIEF]',
  '[INTERNAL]',
  'BRIEFING_PENDING',  // competitor_scan.js placeholder for pending remix drafts
  'Angle:',           // "Angle: Flip \"how to hire/train...\"" pattern
  'Remix direction:',
  'Remix:',
  'Before/after reel',
  'persona,',         // "Patricia persona, 15s max" pattern
  'Persona:',
  'Original URL:',
  'Source: https://', // "Source: https://www.tiktok.com/..." pattern
];

// Stale founding-count text patterns that predate the 25-cap. Any live post
// mentioning "37 spots" / "37 of 50" / "50 spots" is definitionally stale
// content from before Heath's 2026-07-09 cohort cut from 50 → 25.
const STALE_COUNT_MARKERS = [
  '37 spots left',
  '37 of 50',
  'of 50 spots',
  '50 founding spots',
  '38 spots left',
  '39 spots left',
  '40 spots left',
];

/**
 * Check a caption string for leak markers.
 * @param {string} caption
 * @returns {{ ok: boolean, reason?: string, marker?: string }}
 */
function checkCaption(caption) {
  if (typeof caption !== 'string' || caption.length === 0) {
    return { ok: true };
  }

  for (const marker of DENY_MARKERS) {
    if (caption.includes(marker)) {
      return {
        ok: false,
        marker,
        reason: `caption contains internal-briefing marker: "${marker}" — refusing to publish`,
      };
    }
  }

  for (const marker of STALE_COUNT_MARKERS) {
    if (caption.includes(marker)) {
      return {
        ok: false,
        marker,
        reason: `caption contains stale founding-count text: "${marker}" — cohort cap is 25, not 50 (locked 2026-07-09)`,
      };
    }
  }

  return { ok: true };
}

/**
 * Sanitize a full post object (as loaded from social_posts). Checks the
 * caption (content field) plus any hashtag entries.
 * @param {object} post — social_posts row
 * @returns {{ ok: boolean, reason?: string, marker?: string }}
 */
function checkPost(post) {
  if (!post) return { ok: true };
  const captionCheck = checkCaption(post.content || '');
  if (!captionCheck.ok) return captionCheck;

  const hookCheck = checkCaption(post.hook || '');
  if (!hookCheck.ok) {
    return {
      ...hookCheck,
      reason: `hook field: ${hookCheck.reason}`,
    };
  }

  const voCheck = checkCaption(post.voiceover_script || '');
  if (!voCheck.ok) {
    return {
      ...voCheck,
      reason: `voiceover_script field: ${voCheck.reason}`,
    };
  }

  return { ok: true };
}

module.exports = {
  checkCaption,
  checkPost,
  DENY_MARKERS,
  STALE_COUNT_MARKERS,
};
