'use strict';

// scripts/_lib/auto-reply-risk-classifier.js
//
// Deterministic, rule-based risk classifier for the auto-reply-with-veto
// feature (Heath's explicit approval, 2026-09-16 — see
// supabase/migrations/20260916_auto_reply_veto.sql for the full contract).
//
// FAIL-CLOSED BY DESIGN: this is intentionally NOT an LLM call. A model can
// be argued into "this looks fine" on an edge case; a fixed rule set can't.
// classifyCommentRisk() defaults to ESCALATE and only returns eligible=true
// when the comment+draft clear every escalate trigger AND the comment is
// POSITIVELY identified as one of a small number of safe shapes.
//
// REWRITTEN 2026-09-16 after Quinn's QA pass on the first version failed 5
// real cases, all through the same root defect: the "positive shape" checks
// were "innocent until proven guilty" (any question that didn't match an
// escalate keyword was called safe; any comment containing "thanks" was
// called safe regardless of what else it said). Quinn's fix mandate,
// verbatim: "a question is only neutral_follow_up_question when it's
// positively identified as safe, not when it fails to match a bad-word
// list, and thanks only counts when the comment carries no doubt, criticism
// or question at all... It's fine if the eligible set gets small."
//
// This version:
//   1. Widens the escalate patterns themselves to catch indirect phrasing
//      (money without "cost", demo asks without "demo", legal questions
//      without "TREC", named third parties without "my client") — fixing
//      the ROOT SHAPE, not the 5 reported strings.
//   2. Adds a HEDGE/DOUBT/CRITICISM lexicon that overrides thanks/agreement/
//      question eligibility — a "thanks" sitting next to "I guess" or
//      "not sure" or "though" is not a clean thanks.
//   3. Replaces the blanket "any question is eligible" rule with a small,
//      positive SAFE_QUESTION allowlist of general peer-experience
//      phrasings ("did you have to...", "how do you handle...") — a
//      question has to affirmatively look like harmless small talk, not
//      merely fail to trip a keyword.
// The eligible surface is deliberately small. Any comment the rules don't
// recognize falls into 'low_confidence' and escalates.
//
// Used by:
//   - api/cron-tc-reply-approval.js (decides veto-path vs manual-approval-path)
//   - scripts/regression-auto-reply-classifier.js (unit coverage, incl.
//     Quinn's 5 reported cases + harder variants as permanent fixtures)
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
      // Indirect money phrasing — Quinn 2026-09-16 case 1: "Is it worth the
      // money though?" never says cost/price/how much.
      /\bworth (?:it|the money|paying(?: for)?)\b/i,
      /\bis it worth\b/i,
      /\bpay for\b/i,
      /\baffordable\b/i,
      /\bcan('?t| not) afford\b/i,
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
      // Indirect demo phrasing — Quinn case 2: "Could you walk me through
      // what it actually looks like on the back end?" never says "demo."
      /\bwalk (?:me|us) through\b/i,
      /\bshow (?:me|us) how\b/i,
      /\bwhat (?:does|do) it (?:actually )?look like\b/i,
      /\bback[- ]?end\b/i,
      /\bunder the hood\b/i,
      /\bhow (?:does|do) it (?:actually )?work\b/i,
      /\bcould you (?:show|walk)\b/i,
      /\bcan you (?:show|walk)\b/i,
      /\btake a look at it\b/i,
      /\bbehind the scenes\b/i,
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
      // Legal/compliance questions that never say the word "legal" or
      // "TREC" — Quinn case 4: an earnest-money-forfeiture question.
      /\bforfeit(?:ed|ure)?\b/i,
      /\blose (?:the |his |her |their )?earnest money\b/i,
      /\bkeep (?:the |their |his |her )?earnest money\b/i,
      /\bwalk away\b/i,
      /\bwho'?s (?:liable|responsible)\b/i,
      /\bwho is (?:liable|responsible)\b/i,
      /\bbreach(?: of contract)?\b/i,
      /\bin default\b/i,
      /\bentitled to\b/i,
      /\blegally (?:required|obligated|entitled)\b/i,
      /\bcan (?:they|he|she|the buyer|the seller) (?:sue|be sued)\b/i,
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
      // A named third party's transaction — Quinn case 5: "How did you
      // handle it for Sarah's closing?" names no address, no "my client",
      // just a specific person's name + a transaction noun.
      /\b[A-Z][a-zA-Z]+'s (?:closing|deal|transaction|file|listing|contract|escrow|option period|earnest money|paperwork)\b/,
      /\bfor [A-Z][a-zA-Z]+(?:'s)?\b.{0,20}\b(?:closing|deal|transaction|file|listing|contract|escrow)\b/,
      /\bhandled? it for [A-Z][a-zA-Z]+\b/i,
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

// ── Hedge / doubt / criticism lexicon ────────────────────────────────────────
// Quinn case 3: "Thanks, I guess, not sure it actually works though" —
// "thanks" alone used to be sufficient. It never should have been: a thanks
// carrying doubt, a backhanded qualifier, or a live question is not a clean
// thanks. This lexicon BLOCKS the thanks/agreement/question/factual
// archetypes below — it does not itself escalate to a specific category
// (there's no clean signal WHICH category), it just forces low_confidence,
// which escalates by the same default-deny rule as everything else.
const HEDGE_DOUBT_CRITICISM_RE = /\b(?:i guess|not sure|though|but\b|however|i don'?t know|idk|kind of|sort of|not really|doubt(?:ful)?|skeptical|questionable|not convinced|supposedly|allegedly|eh[,.]?|meh\b|not (?:totally|entirely|fully) sure|still not sure|not (?:so|too) sure)\b/i;

// ── Auto-eligible positive shapes ────────────────────────────────────────────
// Necessary but NOT sufficient: clearing ESCALATE_PATTERNS and
// HEDGE_DOUBT_CRITICISM_RE still requires positively matching one of these.
const THANKS_RE = /\b(?:thanks?|thank you|appreciate (?:it|that|this)|much appreciated)\b/i;
const NEGATED_THANKS_RE = /\bno thanks\b/i;
const AGREEMENT_RE = /\b(?:yes|yeah|yep|yup|agreed?|exactly|100%|so true|same here|totally|spot on|couldn'?t agree more)\b/i;
const THANKS_AGREEMENT_MAX_WORDS = 20; // a real thanks/agreement is short; a long one carrying "thanks" plus three more sentences of commentary is not a clean thanks

// SAFE_QUESTION_PATTERNS — Quinn's mandate: a question must be POSITIVELY
// identified as safe small talk about the peer's own general practice, not
// merely fail to match an escalate keyword. Deliberately narrow.
const SAFE_QUESTION_PATTERNS = [
  /\bdid you (?:have to|end up|switch|use|try)\b/i,
  /\bhow (?:do|did) you (?:handle|deal with|manage|switch|find|end up)\b/i,
  /\bwhat (?:do|did) you (?:do|use|find)\b/i,
  /\bhow long (?:did|does|do)\b/i,
  /\bhow often (?:do|does|did)\b/i,
  /\bdoes? (?:yours|it) (?:also|ever|always|usually)\b/i,
  /\bwhat tripped you up\b/i,
  /\bwhat worked for you\b/i,
  /\bhave you (?:had|ever)\b/i,
  /\bwas (?:that|it|yours) (?:always|ever)\b/i,
];
const QUESTION_MAX_WORDS = 25;

// Domain-relevance signal for the "factual answer about how TC/transaction
// work goes" archetype — a plain declarative statement (no hedge, no
// question) with no other positive shape above still counts as eligible IF
// it's clearly on-topic (peer TC/transaction-coordination talk). Off-topic
// or ambiguous declaratives stay low_confidence and escalate.
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
  const trimmed = comment.trim();
  if (wordCount(trimmed) > MAX_COMMENT_WORDS_FOR_CONFIDENCE) {
    return { eligible: false, category: 'low_confidence', reason: 'comment too long to classify with confidence', matched: null };
  }

  // 4. Hedge / doubt / criticism blocks EVERY positive shape below — a
  // "thanks, I guess" or "does it even work though?" never qualifies via
  // thanks/agreement/question/factual, no matter what else it contains.
  const hasHedge = HEDGE_DOUBT_CRITICISM_RE.test(trimmed);

  if (!hasHedge) {
    if (NEGATED_THANKS_RE.test(trimmed)) {
      return { eligible: false, category: 'low_confidence', reason: 'negated thanks reads ambiguous', matched: null };
    }
    // Thanks/agreement: positively safe only when clean (no hedge, tested
    // above) AND short AND not itself a live question tacked onto the end.
    const shortEnough = wordCount(trimmed) <= THANKS_AGREEMENT_MAX_WORDS;
    const isAlsoAQuestion = trimmed.endsWith('?');
    if (THANKS_RE.test(trimmed) && shortEnough && !isAlsoAQuestion) {
      return { eligible: true, category: 'auto_eligible', reason: 'thanks', matched: null };
    }
    if (AGREEMENT_RE.test(trimmed) && shortEnough && !isAlsoAQuestion) {
      return { eligible: true, category: 'auto_eligible', reason: 'agreement', matched: null };
    }
    // A question is eligible ONLY when it positively matches a known-safe
    // peer-experience shape — not merely for ending in "?".
    if (trimmed.endsWith('?') && wordCount(trimmed) <= QUESTION_MAX_WORDS) {
      const safeQuestion = SAFE_QUESTION_PATTERNS.some((re) => re.test(trimmed));
      if (safeQuestion) {
        return { eligible: true, category: 'auto_eligible', reason: 'neutral_follow_up_question', matched: null };
      }
    }
    // Plain declarative, on-topic, no hedge, no question mark.
    if (!trimmed.endsWith('?') && DOMAIN_KEYWORDS_RE.test(trimmed)) {
      return { eligible: true, category: 'auto_eligible', reason: 'factual_tc_transaction_answer', matched: null };
    }
  }

  // 5. Nothing positively matched — default to escalate.
  return { eligible: false, category: 'low_confidence', reason: 'no positively-safe shape matched', matched: null };
}

module.exports = {
  ESCALATE_PATTERNS,
  HEDGE_DOUBT_CRITICISM_RE,
  SAFE_QUESTION_PATTERNS,
  classifyCommentRisk,
};
