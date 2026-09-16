'use strict';

// scripts/_lib/auto-reply-risk-classifier.js
//
// Deterministic, rule-based risk classifier for the auto-reply-with-veto
// feature (Heath's explicit approval, 2026-09-16 — see
// supabase/migrations/20260916_auto_reply_veto.sql for the full contract).
//
// FAIL-CLOSED BY DESIGN: this is intentionally NOT an LLM call. A model can
// be argued into "this looks fine" on an edge case; a fixed keyword/pattern
// list can't. classifyCommentRisk() defaults to ESCALATE and only returns
// eligible=true when the comment+draft clear every escalate trigger AND
// positively match one of the four allowed low-risk shapes. Any comment the
// rules don't recognize falls into 'low_confidence' and escalates — per
// spec: "Default to escalate when in doubt."
//
// Used by:
//   - api/cron-tc-reply-approval.js (decides veto-path vs manual-approval-path)
//   - scripts/regression-auto-reply-classifier.js (unit coverage)
//
// Owner: Carter, 2026-09-16

// ── Escalate categories ──────────────────────────────────────────────────────
// Checked against comment_text AND the drafted reply — a claim that leaks
// into Heath's own drafted reply is just as disqualifying as one in the
// inbound comment (e.g. the draft itself naming a price or a competitor).
//
// Order matters: first match wins, so list the most specific/highest-signal
// categories first where two could plausibly both match the same text.
const ESCALATE_PATTERNS = [
  {
    category: 'pricing',
    patterns: [
      /\bhow much\b/i,
      /\bhow's much\b/i,
      /\bcost[s]?\b/i,
      /\bpricing\b/i,
      /\bprice[sd]?\b/i,
      /\bdiscount\b/i,
      /\brefund(?:ed|s)?\b/i,
      /\bbilling\b/i,
      /\bcharge[sd]?\b/i,
      /\bfee[s]?\b/i,
      /\$\s?\d/,
      /\d+\s?(?:\/|per)\s?(?:mo|month|yr|year)\b/i,
      /\bsubscription\b/i,
    ],
  },
  {
    category: 'demo_request',
    patterns: [
      /\bdemo\b/i,
      /\btrial\b/i,
      /\bcan i (?:see|try|check out)\b/i,
      /\bshow me\b/i,
      /\btry it out\b/i,
      /\bsign\s?up\b/i,
      /\bwhere (?:can|do) i (?:sign up|get (?:it|access))\b/i,
    ],
  },
  {
    category: 'complaint',
    patterns: [
      /\bscam\b/i,
      /\brip\s?off\b/i,
      /\bwaste of (?:time|money)\b/i,
      /\bhate\b/i,
      /\bterrible\b/i,
      /\bworst\b/i,
      /\bawful\b/i,
      /\bdisappoint(?:ed|ing)\b/i,
      /\bfrustrat(?:ed|ing)\b/i,
      /\bangry\b/i,
      /\bannoy(?:ed|ing)\b/i,
      /\bdoesn'?t work\b/i,
      /\bnot working\b/i,
      /\bbroken\b/i,
      /\bbull\s?shit\b/i,
      /\bsucks?\b/i,
      /\blied\b|\blying\b/i,
      /\bunacceptable\b/i,
      /\bfurious\b/i,
      /\bpissed\b/i,
      /\bcomplain(?:t|ing)?\b/i,
    ],
  },
  {
    category: 'legal_compliance',
    patterns: [
      /\btrec\b/i,
      /\bcompliance\b/i,
      /\blegal(?:ly)?\b/i,
      /\blawsuit\b/i,
      /\bsue[ds]?\b/i,
      /\bliab(?:le|ility)\b/i,
      /\be\s?&\s?o\b/i,
      /\bstatute\b/i,
      /\bregulat(?:ion|ory|ed)\b/i,
      /\bviolat(?:ion|ed|es)\b/i,
      /\blicens(?:e|ing) (?:board|complaint|violation)\b/i,
    ],
  },
  {
    category: 'specific_client',
    patterns: [
      /\bmy client\b/i,
      /\bmy (?:deal|transaction|file|listing|buyer|seller)\b/i,
      /\bthis (?:client|deal|transaction|file)\b/i,
      /\b\d{2,6}\s+[A-Za-z][A-Za-z.'-]*\s+(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|way|cir|circle|pl|place|trl|trail)\b/i,
      /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, // phone number
    ],
  },
  {
    category: 'contact_request',
    patterns: [
      /\bdm\b/i,
      /\bdirect message\b/i,
      /\breach out\b/i,
      /\bcontact me\b/i,
      /\bcall me\b/i,
      /\btext me\b/i,
      /\bemail me\b/i,
      /\bmessage me\b/i,
      /\bpm me\b/i,
    ],
  },
  {
    category: 'competitor_mention',
    // Known competitors (memory: competitor-agentalent-orion) + common
    // TC/transaction-management tools that could come up in this exact
    // peer-discussion group. Extend this list as new names surface — a
    // name NOT on it simply won't trigger this category (a known limit of
    // a fixed list, not a bug).
    patterns: [
      /\bagentalent(?:\.ai)?\b/i,
      /\borion\b/i,
      /\bdotloop\b/i,
      /\bskyslope\b/i,
      /\bbrokermint\b/i,
      /\breesio\b/i,
      /\btrackxi\b/i,
      /\bhomelight\b/i,
      /\blone\s?wolf\b/i,
      /\bzillow premier\b/i,
      /\bkw command\b/i,
    ],
  },
];

// ── Auto-eligible positive shapes ────────────────────────────────────────────
// The comment must positively match one of these to be eligible at all —
// clearing the escalate list is necessary but not sufficient.
const THANKS_RE = /\b(?:thanks?|thank you|appreciate (?:it|that|this)|much appreciated)\b/i;
const NEGATED_THANKS_RE = /\bno thanks\b/i;
const AGREEMENT_RE = /\b(?:yes|yeah|yep|yup|agreed?|exactly|100%|so true|same here|totally|spot on|couldn'?t agree more)\b/i;
const QUESTION_MAX_WORDS = 40;

// Domain-relevance signal for the "factual answer about how TC/transaction
// work goes" archetype — a plain declarative statement with no positive
// shape above still counts as eligible IF it's clearly on-topic (peer TC/
// transaction-coordination talk), because that's exactly the "factual
// answer" category the spec names. Off-topic or ambiguous declaratives stay
// low_confidence and escalate.
const DOMAIN_KEYWORDS_RE = /\b(?:tc|transaction coordinator|coordinator|contract|closing|close(?:s|d)?|deadline|option period|earnest money|escrow|title|file|dossier|checklist|paperwork|compliance packet|brokerage|commission split)\b/i;

const MAX_COMMENT_WORDS_FOR_CONFIDENCE = 60; // long/rambling comments aren't safe to auto-classify

function firstMatch(patternGroups, text) {
  const t = String(text || '');
  for (const group of patternGroups) {
    for (const re of group.patterns) {
      if (re.test(t)) return { category: group.category, pattern: re.toString() };
    }
  }
  return null;
}

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * classifyCommentRisk(commentText, replyDraft)
 *
 * @param {string} commentText  the inbound FB comment
 * @param {string} replyDraft   Heath's drafted reply to it
 * @returns {{
 *   eligible: boolean,
 *   category: string,           // 'auto_eligible' or an escalate reason
 *   reason: string,              // human-readable explanation
 *   matched: string|null         // the regex source that triggered escalation, if any
 * }}
 */
function classifyCommentRisk(commentText, replyDraft) {
  const comment = String(commentText || '');
  const draft = String(replyDraft || '');
  const combined = `${comment}\n${draft}`;

  // 1. Any escalate trigger anywhere in comment OR draft wins immediately.
  const hit = firstMatch(ESCALATE_PATTERNS, combined);
  if (hit) {
    return {
      eligible: false,
      category: hit.category,
      reason: `matched escalate pattern for "${hit.category}"`,
      matched: hit.pattern,
    };
  }

  // 2. Empty draft (shouldn't happen post-hostile-filter, but fail closed).
  if (!draft.trim()) {
    return { eligible: false, category: 'low_confidence', reason: 'empty draft', matched: null };
  }

  // 3. Too long / rambling to safely auto-classify.
  if (wordCount(comment) > MAX_COMMENT_WORDS_FOR_CONFIDENCE) {
    return { eligible: false, category: 'low_confidence', reason: 'comment too long to classify with confidence', matched: null };
  }

  // 4. Positive-shape check, in priority order.
  const trimmed = comment.trim();

  if (NEGATED_THANKS_RE.test(trimmed)) {
    return { eligible: false, category: 'low_confidence', reason: 'negated thanks reads ambiguous', matched: null };
  }
  if (THANKS_RE.test(trimmed)) {
    return { eligible: true, category: 'auto_eligible', reason: 'thanks', matched: null };
  }
  if (AGREEMENT_RE.test(trimmed)) {
    return { eligible: true, category: 'auto_eligible', reason: 'agreement', matched: null };
  }
  if (trimmed.endsWith('?') && wordCount(trimmed) <= QUESTION_MAX_WORDS) {
    return { eligible: true, category: 'auto_eligible', reason: 'neutral_follow_up_question', matched: null };
  }
  if (DOMAIN_KEYWORDS_RE.test(trimmed)) {
    return { eligible: true, category: 'auto_eligible', reason: 'factual_tc_transaction_answer', matched: null };
  }

  // 5. Nothing positively matched — default to escalate.
  return { eligible: false, category: 'low_confidence', reason: 'no positive low-risk shape matched', matched: null };
}

module.exports = {
  ESCALATE_PATTERNS,
  classifyCommentRisk,
};
