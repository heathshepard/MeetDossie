'use strict';

// api/_lib/persona-altitude-guard.js
//
// Enforces memory/heath-group-poster-persona.md, set by Heath 2026-10-02
// after rejecting both of that day's drafts as rookie-level:
//
//   1. hook_type "tracking_question:disclosure_review_habit" --
//      "Do you actually read a seller's disclosure notice line by line
//      before you put together an offer... I go back and forth depending
//      on how slammed the week is." Verdict: reading it early is A GIVEN,
//      not a question, and the admission makes Heath look disorganized.
//   2. hook_type "process_observation:earnest_money_vs_option_fee" -- a
//      post explaining the option fee and earnest money are different
//      checks. Verdict: "just as basic a conversation as anyone could have."
//
// THE RULE, in Heath's words: "a very smart capable experienced agent, not
// some rookie agent that talks about the option period and earnest fee
// like it's some profound concept... someone who is more experienced,
// professional, subject matter expert, but maybe is looking for process
// improvements because they're old school."
//
// THE OPERATING DISTINCTION this file enforces mechanically: an expert
// never asks "what is X" -- an expert asks "how do you handle X when it
// goes sideways." The gap a veteran genuinely has is in SYSTEMS, never in
// understanding. A post fails here if it (a) explains/defines a basic TREC
// term pair instead of assuming the reader already knows it, (b) asks a
// question a working agent already knows the answer to, or (c) admits
// disorganization in Heath's own first-person voice.
//
// THIS IS A PATTERN SCANNER, NOT A JUDGMENT ENGINE -- same posture as
// fabrication-guard.js and practitioner-test-guard.js. It cannot read
// intent; it can catch the shapes of the two incidents that already
// happened, plus the closely related shapes those two generalize to. A
// post that clears every rule here can still, in principle, read as
// rookie in some way this file doesn't model -- see the limitations note
// in the handoff report that shipped it (persona-altitude-guard cannot
// detect a NEW flavor of basic-knowledge question it has no pattern for,
// only the ones already named here).
//
// Owner: Sage, 2026-10-02.

// -- Rule A: basic-term explainer -----------------------------------------
//
// The rejected option-fee/earnest-money post's shape: name two canonical
// TREC concepts, then explicitly walk through how they differ ("they're
// not", "aren't the same", "get lumped together", "gets treated like...
// and it isn't"). Any working Texas agent already knows every pair below
// cold -- explaining the distinction, rather than assuming it, is the
// rookie tell. Pairs are the canonical basics most likely to get this
// treatment; add to this list only for a genuinely basic pair, never for
// an edge case (an edge case IS what this pipeline should produce).
const BASIC_TERM_PAIRS = [
  ['option fee', 'earnest money'],
  ['option period', 'inspection period'],
  ['pre-approval', 'pre-qualification'],
  ['pre-approval', 'prequalification'],
  ['listing agreement', 'buyer representation agreement'],
  ['listing agreement', "buyer's representation agreement"],
  ['effective date', 'closing date'],
];

// Connector phrases that signal the post is actively DEFINING/CONTRASTING
// the pair for the reader, not merely mentioning both terms in passing
// (e.g. a process question that references both option fee AND earnest
// money while asking about a tracking system is fine -- it never pauses to
// explain what either one IS).
const EXPLAINER_CONNECTORS = [
  /\bare not the same\b/i,
  /\baren'?t the same\b/i,
  /\bisn'?t the same (as|thing as)\b/i,
  /\bis not the same (as|thing as)\b/i,
  /\bget(s)? (lumped|treated|confused) (together|as the same|like)\b/i,
  /\bget(s)? treated like.{0,40}and (it|they)('re| are|'s| is) ?n'?t\b/i,
  /\bwhat'?s the difference between\b/i,
  /\bdifferent (checks?|things?|concepts?) (with|entirely)\b/i,
  /\btwo different names\b/i,
  /\bclients? hear ["“]?deposit["”]?\b/i,
];

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ');
}

function checkBasicTermExplainer(text) {
  const t = normalize(text);
  const connectorHit = EXPLAINER_CONNECTORS.find((re) => re.test(text));
  if (!connectorHit) return { pass: true, note: '' };

  const pairHit = BASIC_TERM_PAIRS.find(([a, b]) => t.includes(a) && t.includes(b));
  if (!pairHit) return { pass: true, note: '' };

  return {
    pass: false,
    note: `explains the difference between "${pairHit[0]}" and "${pairHit[1]}" -- a working agent already knows this; matched connector ${connectorHit}`,
  };
}

// -- Rule B: obvious-answer question ---------------------------------------
//
// The rejected disclosure post's shape: frame a baseline professional duty
// ("do you read the thing you're legally obligated to review before you
// act on it") as a genuine open question. The honest answer is always
// "yes, obviously" -- asking it at all marks the writer as junior. These
// patterns are deliberately specific to the known incident shape (reading
// disclosures/contracts/forms before acting) rather than banning questions
// broadly -- a genuine SYSTEMS question ("how do you track X") is exactly
// what this pipeline should produce and must not trip this rule.
const OBVIOUS_ANSWER_QUESTION_PATTERNS = [
  // "do/should you (actually) read the disclosure/contract/forms before..."
  /\b(do|should|does)\b[^.?!]{0,60}\bread\b[^.?!]{0,80}\b(seller'?s )?disclosure\b[^.?!]{0,60}\bbefore\b/i,
  /\b(do|should|does)\b[^.?!]{0,60}\bread\b[^.?!]{0,80}\bcontract\b[^.?!]{0,60}\bbefore\b/i,
  // "is the option fee the same as / different from earnest money" asked
  // as a literal question (covers the explainer-as-a-question variant).
  /\bis\b[^.?!]{0,40}\boption fee\b[^.?!]{0,40}\b(the )?same\b[^.?!]{0,40}\bearnest money\b/i,
  // "do you verify/check pre-approval before showing" -- same baseline-duty
  // shape, different topic.
  /\b(do|should|does)\b[^.?!]{0,60}\b(verify|check)\b[^.?!]{0,60}\bpre-?approv/i,
];

function checkObviousAnswerQuestion(text) {
  const hit = OBVIOUS_ANSWER_QUESTION_PATTERNS.find((re) => re.test(text));
  if (!hit) return { pass: true, note: '' };
  return {
    pass: false,
    note: `asks a baseline-duty question with an obvious answer (matched ${hit}) -- an expert asks how a process breaks, not whether a given step is skipped`,
  };
}

// -- Rule C: disorganization admission --------------------------------------
//
// Heath's verdict, verbatim: "depending on how slammed the week is" makes
// him look disorganized when he's selling competence. Never admit an
// inconsistent/ad-hoc personal practice in first person.
const DISORGANIZATION_PATTERNS = [
  /\bdepending on how (slammed|busy|crazy|hectic|wild)\b/i,
  /\bi go back and forth\b/i,
  /\bwhen i('m| am) not too busy\b/i,
  /\bif i have time\b/i,
  /\bi don'?t always\b/i,
  /\bsome weeks i\b/i,
  /\bi'?m not (always |that )?(organized|on top of)\b/i,
  /\bhonestly,? it depends on my (week|schedule)\b/i,
  /\bwhatever i can (get to|squeeze in)\b/i,
];

function checkDisorganizationAdmission(text) {
  const hit = DISORGANIZATION_PATTERNS.find((re) => re.test(text));
  if (!hit) return { pass: true, note: '' };
  return {
    pass: false,
    note: `admits a disorganized/inconsistent personal practice (matched ${hit}) -- Heath's words: this reads as disorganized, not relatable, and he's selling competence`,
  };
}

/**
 * @param {string} text  a group_posts.post_body candidate
 * @returns {{pass:boolean, rules:object, failedRules:string[]}}
 */
function checkPersonaAltitude(text) {
  const rules = {};
  const addRule = (name, { pass, note = '' }) => { rules[name] = { pass: !!pass, note }; };

  addRule('no_basic_term_explainer', checkBasicTermExplainer(text));
  addRule('no_obvious_answer_question', checkObviousAnswerQuestion(text));
  addRule('no_disorganization_admission', checkDisorganizationAdmission(text));

  const failedRules = Object.entries(rules).filter(([, r]) => !r.pass).map(([name]) => name);
  return { pass: failedRules.length === 0, rules, failedRules };
}

module.exports = {
  checkPersonaAltitude,
  BASIC_TERM_PAIRS,
  EXPLAINER_CONNECTORS,
  OBVIOUS_ANSWER_QUESTION_PATTERNS,
  DISORGANIZATION_PATTERNS,
};
