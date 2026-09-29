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

// Returns 'Seller', 'Buyer', or null for a "which party pays" election shaped
// like TREC ¶6A ("Seller shall furnish ... at [X] Seller's [ ] Buyer's
// expense") or the nested ¶6C fallback clause ("obtain a new survey at
// [ ] Seller's [X] Buyer's expense" — the real, confirmed 23 Nopalito text
// in checkbox-election.test.js). The mark always immediately PRECEDES the
// word it belongs to on these forms — "[X] Seller's", never "Seller's [X]" —
// same convention the model is instructed to preserve verbatim for this
// paragraph, matching debugParagraph6C's established convention. Checking
// only that ordering (rather than also matching mark-after-word) is
// deliberate: a "Seller's [X]" match would actually be the NEXT word's own
// preceding mark, not Seller's — matching both orderings produces false
// positives on exactly this text shape.
//
// Same discipline as parseCheckedOption: zero marks or contradictory marks
// (both parties read as checked) both return null rather than guessing.
function parseCheckedParty(verbatimText) {
  if (typeof verbatimText !== 'string' || !verbatimText) return null;
  const sellerChecked = /\[X\]\s*Seller'?s?\b/i.test(verbatimText);
  const buyerChecked = /\[X\]\s*Buyer'?s?\b/i.test(verbatimText);
  if (sellerChecked && !buyerChecked) return 'Seller';
  if (buyerChecked && !sellerChecked) return 'Buyer';
  return null;
}

// Parses a "checkbox for a flat dollar amount OR checkbox for a percentage"
// election — the exact shape of TREC ¶12B(1) and ¶12B(2) brokerage
// compensation: "⬜ $_____ or ⬜ ____% of the Sales Price". Returns
// { amount, percentage } where exactly one is a number and the other is
// null when the election is legible, or both null when nothing is checked
// (the sub-paragraph genuinely doesn't apply — e.g. ¶12B(2) is commonly
// blank) or when both boxes are checked (a contradictory capture — never
// guess which one is "real").
function parseDollarOrPercentElection(verbatimText) {
  if (typeof verbatimText !== 'string' || !verbatimText) return { amount: null, percentage: null };
  const dollarMatch = verbatimText.match(/\[X\]\s*\$\s*([\d][\d,]*(?:\.\d{1,2})?)/i);
  const pctMatch = verbatimText.match(/\[X\]\s*([\d]+(?:\.\d{1,3})?)\s*%/i);
  if (dollarMatch && pctMatch) return { amount: null, percentage: null }; // contradictory
  if (dollarMatch) {
    const n = parseFloat(dollarMatch[1].replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? { amount: n, percentage: null } : { amount: null, percentage: null };
  }
  if (pctMatch) {
    const n = parseFloat(pctMatch[1]);
    return Number.isFinite(n) && n > 0 ? { amount: null, percentage: n } : { amount: null, percentage: null };
  }
  return { amount: null, percentage: null };
}

module.exports = { parseCheckedOption, parseCheckedParty, parseDollarOrPercentElection };
