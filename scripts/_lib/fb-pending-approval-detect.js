'use strict';

// scripts/_lib/fb-pending-approval-detect.js
//
// Shared "this group requires admin approval" detector for the FB group
// poster (scripts/fb-group-poster.js). Extracted to its own module so it can
// be required side-effect-free from a regression test -- fb-group-poster.js
// itself runs main() at import time (a CLI script, not a library), so it
// can't be require()'d directly without launching Chrome.
//
// 2026-09-14 incident: a submit to "Realtors San Antonio, Boerne, Bulverde,
// New Braunfels" landed in the group's moderation queue. The generic
// role="alert" error-scan caught Facebook's own "sent to admins for review"
// notice, treated it as a posting failure, and tripped the SHARED circuit
// breaker (scripts/_lib/comment-hunt-halt.js) -- silently halting comment +
// reply posting for ~24h on a healthy account with nothing actually wrong.
//
// Facebook's own wording for this state varies by group settings and has
// changed before -- match on intent, not one exact string.

const PENDING_APPROVAL_PATTERNS = [
  /pending admin approval/i,
  /awaiting admin approval/i,
  /waiting for (a |the )?(group )?admin(s)? to (approve|review)/i,
  /admins? (will |must |need to )?(review|approve) (this|your) post/i,
  /sent (this|your|it|the post)?\s*(to )?(the )?(group )?admins? for (approval|review)/i,
  /sent (this|your) post to (the )?(group )?admins?/i,
  /your post (is|has been|was) sent for approval/i,
  /this post is awaiting approval/i,
  /post will be visible (once|after) (an? )?admin/i,
  /group admins have to approve/i,
];

/** Pure text match -- easy to unit test without a real page. */
function matchesPendingApproval(text) {
  const s = String(text || '');
  return PENDING_APPROVAL_PATTERNS.some((re) => re.test(s));
}

/** Playwright wrapper: scans the full page body text. Never throws. */
async function detectPendingApproval(page) {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 2000 });
    return matchesPendingApproval(bodyText);
  } catch {
    return false;
  }
}

module.exports = { PENDING_APPROVAL_PATTERNS, matchesPendingApproval, detectPendingApproval };
