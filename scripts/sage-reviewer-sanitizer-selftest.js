#!/usr/bin/env node
// Standalone selftest for the demoted-rule sanitizer. No LLM calls.
// Feeds real production reject feedback from the last 30 days through
// the sanitizer and reports which would have been auto-approved.
//
// Built 2026-07-07 during sage-reviewer-recalibration.

'use strict';

// Inline copy of the sanitizer to test in isolation (mirror of the version
// wired into api/cron-sage-autonomous-review.js).
// Two-part matcher:
// (1) Simple keyword hits — if chunk mentions any of these, it's a demoted objection.
// (2) Combo hits — chunk must contain both a verified-fact keyword AND an
//     unverification word to count. Handles "$29 ... unverified" style.
const DEMOTED_KEYWORD_PATTERNS = [
  // Dossie-in-body objections on main social (not group)
  /dossie\s+mention(ion)?\s+rule/i,
  /dossie\s+(should\s+)?(be\s+)?(in|moved\s+to)\s+(the\s+)?first\s+comment/i,
  /(reserve|save|move)\s+.*dossie.*for\s+first\s+comment/i,
  /dossie\s+in\s+(the\s+)?(main\s+)?(body|caption|post)/i,
  /product\s+details?\s+(buried|in\s+caption).*first\s+comment/i,
  /mentions?\s+dossie\s+throughout/i,
  /dossie\s+isn'?t\s+mentioned\s+until/i,
  /bury(?:ing|ies|ied)?\s+dossie/i,
  /dossie\s+(is\s+)?(mentioned\s+)?buried/i,
  /dossie\s+mention.*first\s+comment/i,
  /caption\s+.*(first\s+comment|save.*first)/i,
  /first\s+comment\s+per\s+rules/i,
  /should\s+save\s+product\s+details/i,

  // Persona=dossie flagged as mismatch
  /persona\s+mismatch/i,
  /tagged\s+(as\s+)?['"]?dossie['"]?\s+but\s+should\s+be/i,
  /'?dossie'?\s+is\s+not\s+a\s+valid\s+persona/i,
  /dossie\s+doesn'?t\s+post\s+in\s+first-?person/i,
  /use\s+brenda\/?patricia\/?victor/i,
  /(reframe|rewrite|use)\s+(as\s+)?agent\s+persona/i,
  /should\s+be\s+agent[- ]?focused\s+voice/i,
  /dossie\s+persona\s+(should|but\s+reads)/i,

  // Hashtag-count objections
  /hashtag\s+count/i,
  /too\s+many\s+hashtags/i,
  /(more|less)\s+than\s+\d+\s+hashtags/i,

  // Copy-nit / vibe / self-contradicting
  /clunky\s+phrasing/i,
  /could\s+read\s+better/i,
  /consider\s+rephrasing/i,
  /on\s+second\s+thought/i,
  /actually\s+fine/i,
  /minor\s+(copy\s+)?nit/i,
  /reads?\s+(like\s+)?(a\s+)?(corporate|sales\s*[- ]?y|salesy|marketing|product\s+pitch|sales\s+pitch)/i,
  /too\s+corporate/i,
  /voice\s+is\s+off/i,
  /tone\s+(drift|is\s+off)/i,
  /reads?\s+more\s+like\s+a?\s*sales\s+pitch/i,
  /voice\s+too\s+salesy/i,
  /salesy\/?corporate/i,
];

// Combo matcher: a chunk is DEMOTED if it contains any verified-fact
// keyword AND any unverification word (in either order, any distance apart).
const VERIFIED_FACT_KEYWORDS = [
  /\$29(?![\d])/i,           // $29 not followed by more digits
  /\$400(?![\d])/i,          // $400/file
  /founding\s+pricing/i,
  /founding\s+member\s+pricing/i,
  /founding\s+price/i,
  /italy/i,
  /4:?30\s*(am|a\.m\.)/i,
  /4:?30\s*in\s+the\s+morning/i,
  /heath\s+built\s+dossie/i,
  /heath.*tc\s+quit/i,
  /tc\s+quit.*heath/i,
  /locked\s+while\s+(your\s+)?subscription/i,
];
const UNVERIFICATION_KEYWORDS = [
  /unverified/i,
  /fabricat/i,   // fabricated / fabrication
  /invented/i,
  /needs\s+verification/i,
  /not\s+confirmed/i,
  /no\s+evidence/i,
  /lacks\s+verification/i,
  /is\s+a\s+(specific\s+)?claim/i,
  /is\s+a\s+specific\s+detail/i,
  /invented\s+narrative/i,
  /specific\s+claim.*verification/i,
];

function isDemotedChunk(chunk) {
  if (DEMOTED_KEYWORD_PATTERNS.some((rx) => rx.test(chunk))) return true;
  const hasFact = VERIFIED_FACT_KEYWORDS.some((rx) => rx.test(chunk));
  const hasUnverif = UNVERIFICATION_KEYWORDS.some((rx) => rx.test(chunk));
  if (hasFact && hasUnverif) return true;
  return false;
}
const HARD_BLOCK_PATTERNS = [
  /invented\s+customer(?:\s+name)?/i,
  /fake\s+testimonial/i,
  /fabricated\s+testimonial/i,
  /made-?up\s+testimonial/i,
  /unshipped\s+feature/i,
  /unreleased\s+feature/i,
  /pii/i,
  /personal\s+information/i,
  /phone\s+number/i,
  /email\s+address\s+exposed/i,
  /home\s+address/i,
  /harmful/i,
  /discriminatory/i,
  /misleading\s+medical/i,
];
function scoreFeedback(feedback) {
  if (!feedback || typeof feedback !== 'string') {
    return { totalObjections: 0, demotedCount: 0, hardBlockCount: 0 };
  }
  const chunks = feedback
    .split(/(?:\n+|\(\d+\)|(?:^|\s)\d+[\.\)]\s+|;\s+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);
  const list = chunks.length > 0 ? chunks : [feedback];
  // Drop the intro-only chunks like "Multiple hard blockers:" which are not
  // an objection but a heading
  const substantive = list.filter((c) => {
    const t = c.trim();
    if (/^(multiple\s+)?(hard\s+)?(critical\s+)?(blockers?|issues?|violations?|failures?)[\s:.-]*$/i.test(t)) return false;
    if (t.length < 15) return false;
    return true;
  });
  const scored = substantive.length > 0 ? substantive : list;
  let hardBlockCount = 0;
  let demotedCount = 0;
  for (const chunk of scored) {
    if (HARD_BLOCK_PATTERNS.some((rx) => rx.test(chunk))) {
      hardBlockCount++;
      continue;
    }
    if (isDemotedChunk(chunk)) {
      demotedCount++;
    }
  }
  return { totalObjections: scored.length, demotedCount, hardBlockCount };
}
function sanitizeReview(review, isGroupPost) {
  if (!review) return review;
  const decision = String(review.decision || '').toLowerCase();
  if (isGroupPost) return review;
  if (decision !== 'send_back' && decision !== 'reject') return review;
  const { totalObjections, demotedCount, hardBlockCount } = scoreFeedback(review.feedback);
  if (hardBlockCount > 0) return review;
  // Threshold: if half or more of the objections are demoted (and none are
  // hard-block), the review is spurious and we override to approve.
  if (demotedCount >= 2 && totalObjections > 0 && demotedCount / totalObjections >= 0.5) {
    return {
      decision: 'approve',
      score: Math.max(review.score || 5, 7),
      feedback: `[sanitized: ${demotedCount}/${totalObjections} demoted objections]`,
      _sanitized: true,
      _originalDecision: decision,
      _originalFeedback: review.feedback,
    };
  }
  return review;
}

// Real production reject feedbacks pulled 2026-07-07 for the last 30 days
const PRODUCTION_REJECTS = [
  {
    id: 1,
    reason: "Critical issues: (1) Persona mismatch—tagged as 'dossie' but should be agent persona (Brenda/Patricia/Victor); Dossie doesn't post in first-person about its own features. (2) Dossie Mention Rule violation—product details buried in caption instead of first comment. (3) Fabricated specifics—'$29/month founding pricing' and 'locked while subscription stays active' are unverified claims not confirmed by product team. (4) Voice too salesy/corporate ('nice-to-have,' pricing pitch) vs. warm and agent-focused.",
    expectFlip: true,
  },
  {
    id: 2,
    reason: "Multiple hard blockers: (1) Fabricated specifics—'$400 a file' and '$29/month founding pricing' are unverified claims that could expose Dossie legally; (2) Personal founder narrative ('Heath built Dossie because he lived that') lacks verification and feels inconsistent with agent-focused voice; (3) Dossie mention buried in caption instead of first comment per rules; (4) The post reads more like a sales pitch than agent problem-solving.",
    expectFlip: true,
  },
  {
    id: 3,
    reason: "Multiple hard blockers: (1) Dossie Mention Rule violation — post mentions Dossie features extensively in caption but should save product details for first comment instead. (2) Fabricated Specifics — '$29/month, locked while your subscription stays active' is a specific pricing claim that needs verification. (3) Persona mismatch — tagged 'dossie' persona but reads like corporate product marketing.",
    expectFlip: true,
  },
  {
    id: 4,
    reason: "Hard blockers: (1) Dossie Mention Rule violation - Dossie is buried throughout the caption instead of being mentioned in the first comment where it belongs for a feature-focused post. (2) Fabricated specifics - 'Founding pricing is $29/month, locked while your subscription stays active' is a specific claim that needs verification before posting. (3) Persona mismatch - Tagged as 'dossie' persona but should be agent-focused voice. (4) Hook quality issue - Opens with pain point but immediately pivots to product features.",
    expectFlip: true,
  },
  {
    id: 5,
    reason: "Multiple hard blockers: (1) Dossie Mention Rule violation — this is a feature post but Dossie is mentioned in the caption, not reserved for first comment as required by strategy. (2) Fabricated specifics — '$29/month founding pricing locked while subscription stays active' is a claim that needs verification. (3) Voice misalignment — the persona is tagged 'dossie' but the post reads like a direct sales pitch. (4) Hook is strong (4:30am anxiety), but the post pivots too quickly to product sell.",
    expectFlip: true,
  },
  // Real hard-block that should NOT be flipped
  {
    id: 6,
    reason: "Fabricated testimonial — 'Sarah from Plano said Dossie saved her deal' is an invented customer name not in our roster. Rewrite with a real customer or drop the testimonial.",
    expectFlip: false,
  },
  {
    id: 7,
    reason: "Unshipped feature — the post claims Dossie signs contracts on the agent's behalf. Dossie Sign is not yet live. Remove or rephrase as 'drafts the contract for you to review.'",
    expectFlip: false,
  },
  // Edge: PII should not flip
  {
    id: 8,
    reason: "PII exposure — post includes agent phone number 210-555-1234. Redact before shipping.",
    expectFlip: false,
  },
];

let pass = 0;
let fail = 0;
console.log('Sanitizer selftest — production reject sample\n');
for (const t of PRODUCTION_REJECTS) {
  const raw = { decision: 'reject', score: 3, feedback: t.reason };
  const sanitized = sanitizeReview(raw, false);
  const flipped = !!sanitized._sanitized;
  const ok = flipped === t.expectFlip;
  const score = scoreFeedback(t.reason);
  console.log(
    `[${t.id}] expect_flip=${t.expectFlip} actual_flip=${flipped} ${ok ? 'PASS' : 'FAIL'}`,
    `(demoted=${score.demotedCount}/${score.totalObjections}, hard_block=${score.hardBlockCount})`
  );
  if (!ok) console.log(`    reason: "${t.reason.slice(0, 140)}"`);
  if (ok) pass++; else fail++;
}
console.log(`\nResult: ${pass}/${PRODUCTION_REJECTS.length} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
