// api/_lib/fill-ledger.js
// =============================================================================
// Shared write-ledger for every form-filling code path (AcroForm text/checkbox
// writes in fill-form.js, and coordinate-drawn text/checkbox writes in
// fill-trec-20-19.js for the flat TREC 20-19 PDF).
//
// WHY SHARED: before this, fill-form.js's safeSetText/safeCheck tracked
// attempted/written/failures for AcroForm forms only. The flat-PDF coordinate
// filler (fill-trec-20-19.js, used for the TREC 20-19 resale contract — the
// single most-used form in the product) had ZERO tracking: page.drawText()
// either drew something or silently drew nothing if the coordinate map didn't
// have the field, with no record either way. A single shared module lets both
// writers report into the same ledger for one request, so the pre-send field
// audit (api/_lib/pre-send-field-audit.js) sees the whole picture regardless
// of which filler ran.
//
// Module-scope state, reset per request via resetFillLedger(). Safe under
// Vercel's instance reuse because each request is handled by one synchronous
// call chain (fill-form.js resets at the top of the handler before doing any
// filling), same assumption the original fill-form.js ledger already relied on.
//
// Owner: Carter, 2026-08-27 (dossie-esign-productization-plan step 3)
// =============================================================================

'use strict';

function freshLedger() {
  return { attempted: 0, written: 0, failures: [], attemptedFields: new Set() };
}

let ledger = freshLedger();

function resetFillLedger() {
  ledger = freshLedger();
  return ledger;
}

function getFillLedger() {
  return ledger;
}

// `name` is optional so existing call sites that only cared about the count
// keep working, but every writer added since 2026-08-27 passes it — it's
// what lets api/_lib/pre-send-field-audit.js tell "this field was actually
// attempted and just happens to have no failure recorded" apart from "this
// field was never attempted at all", which a failures-only ledger can't
// distinguish.
function recordAttempt(name) {
  ledger.attempted++;
  if (name != null) ledger.attemptedFields.add(String(name));
}

function recordWritten() {
  ledger.written++;
}

// Cap retained detail — a fully drifted template can fail hundreds of fields
// and we only need a representative sample for the ask / error response.
function recordFailure(kind, name, reason) {
  if (ledger.failures.length < 60) {
    ledger.failures.push({ kind, field: String(name), reason: String(reason || 'unknown') });
  }
}

module.exports = {
  resetFillLedger,
  getFillLedger,
  recordAttempt,
  recordWritten,
  recordFailure,
};
