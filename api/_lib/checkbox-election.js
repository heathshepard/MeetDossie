'use strict';

// api/_lib/checkbox-election.js
//
// Generic "check-one-of-three (or -two)" election parser for TREC contract
// paragraphs captured verbatim by the model with [X]/[ ] marks preserved —
// same shape as debugParagraph6C (survey), and the same shape ¶7D
// (financing condition) and the financing-type checkboxes in ¶3B would need
// if/when those get the same deterministic treatment. One parser, reused,
// instead of a fourth copy of the same regex drifting slightly each time.
//
// THE STANDING LESSON THIS EXISTS FOR: AcroForm field names lie on these
// PDFs (see acroform-field-names-lie memory — a checkbox once silently made
// a false legal attestation because a field name was trusted over the
// rendered page). The fix pattern that survived that: ask the model to
// preserve verbatim text WITH the checkbox marks, then parse deterministically
// in code — never ask the model to also interpret which option that means in
// the same JSON field. This module is that deterministic half, factored out
// so survey isn't the only paragraph that gets it.
//
// Owner: Carter, 2026-09-21 (23 Nopalito survey-election fix).

// Returns the checked option's number (1-based) as a string, or null if no
// option is marked (or more than one claims to be — see below). Expects
// text shaped like "[X] (1) ... [ ] (2) ... [ ] (3) ...".
function parseCheckedOption(verbatimText) {
  if (typeof verbatimText !== 'string' || !verbatimText) return null;
  const matches = [...verbatimText.matchAll(/\[X\]\s*\((\d)\)/gi)];
  if (matches.length === 1) return matches[0][1];
  // Zero marks (nothing checked — e.g. a blank ¶7D, the exact shape of the
  // Pfeiffers near-miss the coordinator named) or more than one mark
  // (contradictory capture) are both "we don't actually know" — returning
  // null here rather than guessing the first/last match is deliberate; a
  // caller must treat null as "couldn't determine," not "option 1."
  return null;
}

module.exports = { parseCheckedOption };
