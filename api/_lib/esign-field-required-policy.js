'use strict';
// api/_lib/esign-field-required-policy.js
//
// Single source of truth for which DocuSeal field TYPES are `required`, and
// which mapped FORMS additionally require `initials`. Shared by:
//   - api/esign-create.js's dsFieldRequired() (runtime — what actually ships
//     to DocuSeal on every send)
//   - scripts/build-esign-field-maps.js (build-time — what's baked into the
//     committed api/_assets/esign-field-maps.json)
//   - scripts/regression-esign-field-maps.js's Barry Whyte gate (check 8),
//     which imports this instead of re-deriving its own expectation so the
//     runtime and the committed JSON can never silently drift apart.
//
// 2026-09-26 CARTER — Barry Whyte incident. A DocuSeal packet went out with
// every non-signature field (23 checkbox/radio elections on a Seller's
// Disclosure correction, incl. floodplain/occupied/tax-exemption groups)
// silently forced `required: true` because DocuSeal's own default for an
// omitted `required` key is `true`. Fix: compute `required` centrally, from
// `type` alone, never trust/propagate a caller- or map-supplied value. Per
// the incident review: the only defensible required widgets are the
// signature and its paired date; radio groups, checkboxes, initials, and
// free text render optional UNLESS a form is explicitly reviewed and added
// below.
//
// 2026-09-28 CARTER — TREC 9-17 Unimproved Property Contract. Heath's rule
// ("all initials are required" on contracts) applies to initials as a
// party-owned SIGNING WIDGET (same class as the signature next to it) — not
// to the checkbox/radio LEGAL ELECTIONS the Barry Whyte incident was about
// (those are baked into the PDF by the fill engine and never reach DocuSeal
// on a Mode-A mapped form; they are never `type: 'initials'`). Per-form
// allowlist, not a global flip of `type==='initials'` -> true, because a
// blanket flip is exactly the failure class the incident review flagged.
// Add a form here only after confirming, against the rendered form, that
// its initials lines are a real signing requirement.
const INITIALS_REQUIRED_FORMS = new Set(['unimproved-property']);

function dsFieldRequired(type, formType) {
  if (type === 'signature' || type === 'date') return true;
  if (type === 'initials' && formType && INITIALS_REQUIRED_FORMS.has(formType)) return true;
  return false;
}

module.exports = { INITIALS_REQUIRED_FORMS, dsFieldRequired };
