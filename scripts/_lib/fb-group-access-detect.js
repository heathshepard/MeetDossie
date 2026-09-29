'use strict';

// scripts/_lib/fb-group-access-detect.js
//
// Shared detectors for the two non-retryable "this account can never post
// here as-is" states, extracted (same pattern as fb-pending-approval-detect.js)
// so they're unit-testable without a real page.
//
// Confirmed live 2026-09-16 (per-group truth audit): the acting identity for
// DossieBot's group posting is the PAGE "Heath Shepard, Realtor with Keller
// Williams City View" (facebook.com/HeathShepardRealtor), not Heath's
// personal profile.
//   - Founding Files: Pages are explicitly blocked from joining ("Switch to
//     your main profile") -> identity_rejected.
//   - Stone Oak Neighborhood: not a member at all, "Join group" live ->
//     not_a_member.
// These must stay distinguishable from each other and from a genuine
// posting failure -- see scripts/fb-group-poster.js and
// scripts/_lib/fb-post-verify-outcome.js.
//
// IDENTITY DECISION (Heath's call, asked by the coordinator 2026-09-16, not
// made here): switching DossieBot's posting identity from the Page to
// Heath's personal profile would make Founding Files reachable again (the
// block is Page-specific -- "Switch to your main profile"). It would NOT
// automatically fix Stone Oak Neighborhood -- membership there is per-
// account, and whether Heath's personal profile is already a member of
// Stone Oak was not checked/confirmed in this pass.
//
// UPDATE 2026-09-17: that switch happened -- DossieBot-Sage is now confirmed
// logged in as Heath's PERSONAL profile (facebook.com/heath.shepard.75), not
// the Page. See scripts/comment-hunt-groups.json's _readme for the group-list
// side of this correction (acting_identity flipped 'page' -> 'personal' for
// all 4 active groups). The detectors below are identity-agnostic (they match
// Facebook's rejection/join-prompt TEXT, not which identity triggered it) so
// no logic change was needed here -- only this comment was stale. Stone Oak
// membership under the personal profile is still unconfirmed.

const IDENTITY_REJECTED_PATTERNS = [
  /switch to (your )?(main |personal )?profile/i,
  /pages? (can.?t|cannot|aren.?t allowed to|are not allowed to) (post|comment|join)/i,
  /you can.?t use (your |this )?page to (post|comment|join)/i,
  /this action isn.?t available (for|to) pages/i,
  /only profiles can (post|join) (in |to )?this group/i,
];

const NOT_A_MEMBER_PATTERNS = [
  /join (this )?group to (post|see|comment)/i,
  /you.?re not a member of this group/i,
  /you must join this group/i,
  /request to join/i,
];

function matchesIdentityRejected(text) {
  const s = String(text || '');
  return IDENTITY_REJECTED_PATTERNS.some((re) => re.test(s));
}

function matchesNotAMember(text) {
  const s = String(text || '');
  return NOT_A_MEMBER_PATTERNS.some((re) => re.test(s));
}

/** Playwright wrapper: scans the full page body text. Never throws. */
async function detectIdentityRejected(page) {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 2000 });
    return matchesIdentityRejected(bodyText);
  } catch {
    return false;
  }
}

/**
 * Playwright wrapper. NOT_A_MEMBER is deliberately conservative: text match
 * alone ("Join Group" appears in plenty of unrelated UI chrome) is not
 * enough -- also require a visible "Join Group" button, matching how the
 * live Stone Oak case actually presents.
 */
async function detectNotAMember(page) {
  try {
    const bodyText = await page.locator('body').innerText({ timeout: 2000 });
    if (!matchesNotAMember(bodyText)) return false;
    const joinBtn = page.getByRole('button', { name: /join group/i }).first();
    const visible = await joinBtn.isVisible({ timeout: 1500 }).catch(() => false);
    return visible;
  } catch {
    return false;
  }
}

module.exports = {
  IDENTITY_REJECTED_PATTERNS,
  NOT_A_MEMBER_PATTERNS,
  matchesIdentityRejected,
  matchesNotAMember,
  detectIdentityRejected,
  detectNotAMember,
};
