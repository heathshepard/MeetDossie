'use strict';

// scripts/_lib/listing-post-compliance-gate.js
//
// Compliance gate for Heath's own active-listing marketing copy. Checked
// AFTER generation (and again on any Heath edit), not just instructed in a
// prompt -- same philosophy as scripts/_lib/group-post-content-gate.js and
// api/_lib/fabrication-guard.js for the Dossie pipeline, applied to the
// real-estate-advertising rules that actually govern this content:
//   - TREC attribution required on every post
//   - Owner/agent disclosure required whenever the listing is agent-owned
//   - Virtual-staging label required whenever a staged image is used
//   - No fabricated urgency ("won't last", "act fast", invented offer
//     activity) unless a real milestone is explicitly flagged
//
// Owner: Carter, 2026-09-10.

const { TREC_ATTRIBUTION, OWNER_DISCLOSURE } = require('./listing-marketing-facts');

const FABRICATED_URGENCY_PATTERNS = [
  /won'?t last/i,
  /act fast/i,
  /priced to sell fast/i,
  /multiple offers?/i,
  /going fast/i,
  /don'?t (wait|miss (out|this))/i,
  /hurry/i,
  /last chance/i,
];

/**
 * @param {object} opts
 * @param {string} opts.body            the post copy to check
 * @param {boolean} opts.isAgentOwned   listing.isAgentOwned
 * @param {boolean} [opts.usesStagedImage] whether the image attached is virtually staged
 * @param {boolean} [opts.hasRealMilestone] true only when the generator has confirmed a
 *   genuine milestone (real price change, real new photo set) for this run
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
function checkListingPostCompliance(opts) {
  const body = String(opts.body || '');
  const reasons = [];

  if (!body.includes(TREC_ATTRIBUTION)) {
    reasons.push('missing_trec_attribution');
  }

  if (opts.isAgentOwned && !body.includes(OWNER_DISCLOSURE)) {
    reasons.push('missing_owner_disclosure');
  }

  if (opts.usesStagedImage && !/virtually staged/i.test(body)) {
    reasons.push('missing_virtual_staging_label');
  }

  if (!opts.hasRealMilestone) {
    for (const pattern of FABRICATED_URGENCY_PATTERNS) {
      if (pattern.test(body)) {
        reasons.push(`fabricated_urgency:${pattern.source}`);
        break;
      }
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

module.exports = { checkListingPostCompliance, FABRICATED_URGENCY_PATTERNS };
