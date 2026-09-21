// api/_lib/base64-asset.js
//
// 2026-09-21 CARTER — every api/_assets/*-base64.js module is SUPPOSED to
// export a plain base64 string, but 4 of them (trec-unimproved-property,
// trec-farm-ranch, trec-new-home-complete, trec-new-home-incomplete — the
// un-suffixed legacy files) export { base64Pdf: '...' } instead. fill-form.js
// already normalizes this inline; api/_lib/resolve-blank-template-pdf.js and
// api/dossiesign-prepare.js did NOT, and both silently returned null (no
// crash, no error — the form just quietly failed to resolve) for
// unimproved-property, a live TREC 9-17 form a member could reach. Found
// during the 2026-09-21 date-widget rollout when a scratch tool that assumed
// a plain string broke on this file, which raised the question of what else
// in production makes the same assumption.
//
// Single source of truth for "turn a required base64 asset module into the
// actual base64 string" so this shape can only need fixing in one place.

/**
 * @param {string|{base64Pdf?: string, base64?: string}|null|undefined} mod
 *   The value of `require('../_assets/<slug>-base64.js')`.
 * @returns {string|null} the base64 string, or null if the module's shape
 *   is not recognized (never throws — callers already treat null as
 *   "this asset could not be resolved" and fall through safely).
 */
function extractBase64(mod) {
  if (typeof mod === 'string') return mod;
  if (mod && typeof mod === 'object') {
    if (typeof mod.base64Pdf === 'string') return mod.base64Pdf;
    if (typeof mod.base64 === 'string') return mod.base64;
  }
  return null;
}

module.exports = { extractBase64 };
