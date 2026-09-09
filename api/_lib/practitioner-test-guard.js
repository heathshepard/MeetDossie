'use strict';

// api/_lib/practitioner-test-guard.js
//
// Enforces memory/heath-marketing-must-pass-practitioner-test.md, verbatim
// from Heath 2026-09-09: "Please just make sure that the posts... are
// things that a realtor would suggest or work... I would never advise one
// of my clients to waive their option fee to get a house unless it was
// like a foreign investor... or very savvy contractors... who really knew
// what they were doing."
//
// THE RULE: any post taking a position on practice ("X is a bad idea",
// "you should never Y") has to carry the legitimate exception, not ship as
// a flat absolute. A flat "waiving is bad" marks the writer as someone who
// doesn't actually practice -- and this audience does. The nuance IS the
// credibility. Caught in the wild: a generated DFW post arguing waiving
// the option period "isn't brave, it's just moving risk from the seller
// to you" with zero carve-out for a sophisticated buyer -- Heath's real
// position, and it's a common one, is that waiving is wrong for a typical
// retail buyer and legitimately fine for a cash investor doing a gut
// renovation or a contractor who can price the risk himself.
//
// Same shape/spirit as fabrication-guard.js: a pattern scanner, not a
// legal-accuracy checker. It can't verify the CONTENT of an exception is
// correct, only that the post BOTHERS to state one whenever it takes an
// advice-flavored position. A hit blocks the post and forces a
// retry/fallback to a different format -- never a warning-only pass.
//
// Owner: Sage, 2026-09-09.

// Formats whose whole point is taking a position on practice ("X is a good
// idea", "here's how the mechanics actually work and what that implies").
// Every format added here in the future that argues a practice point
// should be added to this list too -- see group-post5-formats.js.
const POSITION_TAKING_FORMATS = ['contrarian', 'process_observation'];

// Signals the post is making an evaluative/advice claim (as opposed to a
// neutral question or a plain factual restatement of a TREC mechanic).
const ADVICE_MARKERS = [
  /\bbad idea\b/i,
  /\bgood idea\b/i,
  /\bshouldn'?t\b/i,
  /\bshould not\b/i,
  /\bshould\b/i,
  /\bisn'?t (brave|smart|wise|safe)\b/i,
  /\bis (reckless|risky|foolish|unwise)\b/i,
  /\bdon'?t recommend\b/i,
  /\bwouldn'?t recommend\b/i,
  /\bnever (waive|advise|sign|do)\b/i,
  /\balways (waive|advise|sign|do)\b/i,
  /\bmistake to\b/i,
  /\bsmarter to\b/i,
  /\bsafer to\b/i,
  /\bnot worth it\b/i,
  /\bwrong (move|call|idea)\b/i,
];

// Signals the post actually carries the exception/nuance -- names WHO or
// WHEN the flat position doesn't hold. Deliberately broad (a false
// positive just means a human reviews a post that happened to be fine
// anyway; a false negative ships a flat absolute).
const EXCEPTION_MARKERS = [
  /\bunless\b/i,
  /\bexcept (for|when)\b/i,
  /\bthe exception is\b/i,
  /\bfor a (sophisticated|cash|savvy|experienced|seasoned)\b/i,
  /\bif you'?re a\b/i,
  /\bfor someone who\b/i,
  /\bdepends on (who|whether|what)\b/i,
  /\bnot always\b/i,
  /\bsometimes it\b/i,
  /\bin the right situation\b/i,
  /\bfor the right buyer\b/i,
  /\bwho (can|knows how to) price (that|the) risk\b/i,
  /\bgutting it anyway\b/i,
  /\bplanning a (full )?gut\b/i,
  /\bcontractor who\b/i,
  /\binvestor who\b/i,
];

function hasAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {string|null} [opts.formatId]  only formats in POSITION_TAKING_FORMATS
 *   are checked at all -- a genuine question or a personal-anecdote post
 *   isn't "taking a position" in this sense.
 * @returns {{ ok: boolean, violations: string[] }}
 */
function checkPractitionerTest(text, { formatId = null } = {}) {
  const t = String(text || '');
  if (!POSITION_TAKING_FORMATS.includes(formatId)) return { ok: true, violations: [] };
  if (!hasAny(t, ADVICE_MARKERS)) return { ok: true, violations: [] }; // no evaluative claim made, nothing to hold to this bar
  if (!hasAny(t, EXCEPTION_MARKERS)) {
    return { ok: false, violations: ['no_stated_exception: post takes a position on practice with no named legitimate exception -- reads as a flat absolute a working agent would dismiss'] };
  }
  return { ok: true, violations: [] };
}

module.exports = { POSITION_TAKING_FORMATS, ADVICE_MARKERS, EXCEPTION_MARKERS, checkPractitionerTest };
