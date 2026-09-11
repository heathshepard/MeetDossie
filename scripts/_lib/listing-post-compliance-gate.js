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
const { isPostableActive, OFF_MARKET, UNDER_CONTRACT_ACTIVE_FAMILY } = require('./mls-status-taxonomy');

// How stale a listing_marketing_status row is allowed to be before the gate
// refuses to draft off it. Root cause of the 2026-09-10 23 Nopalito
// incident: the generator trusted a DB snapshot (list_price $1,195,000)
// that no longer matched live MLS ($999,000, status PCH) by the time the
// post drafted. "Skip the post" is always the correct failure mode over
// "advertise a wrong price" -- see CLAUDE.md license-exposure rule.
// Override via LISTING_STATUS_MAX_AGE_MINUTES for a longer-running local
// session; default is intentionally tight because this pipeline is meant
// to run status-sync and the generator back-to-back in the SAME process
// (scripts/listing-marketing-generate-live.js), not on a delay.
const MAX_STATUS_AGE_MINUTES = Number(process.env.LISTING_STATUS_MAX_AGE_MINUTES) || 30;

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

// 2026-09-11 (Carter, urgent fix): a Fawndale draft claimed "Make-ready
// repairs are wrapping up now"/"in progress" with NO verified source --
// Heath had emailed the property manager 20 minutes earlier asking for a
// completion date and had no answer yet. A claim about the CURRENT STATE of
// in-progress work (as opposed to a permanent, already-done fact like the
// 2024 renovation) is exactly the kind of thing that goes stale or gets
// invented between generation and posting. There is no verified field this
// pipeline tracks for "repairs complete" today (see listing-marketing-facts
// .js's conditionCaveat, which explicitly says "Confirm with Heath whether
// repairs are complete" before ANY such framing) -- so any claim matching
// these patterns is blocked outright. Once a real verified field exists
// (e.g. listing_marketing_status.repairs_verified_complete), gate on that
// instead of blocking unconditionally.
const UNVERIFIED_PROGRESS_CLAIM_PATTERNS = [
  /repairs?\s+(are|is|being)?\s*(wrapping up|winding down|almost (done|complete|finished)|nearly (done|complete|finished)|in progress|underway|ongoing|being finalized)/i,
  /(wrapping up|finishing up|almost (done|ready)|nearly (done|ready))\s+(now|soon|shortly)/i,
  /should be (ready|done|complete|finished)\s+(soon|shortly|any day)/i,
  /ready (any day|any time) now/i,
];

function moneyFmt(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

// Pulls every "big" dollar figure out of the body that's actually a CLAIM
// about the current list price, ignoring:
//   - small $/sqft-style figures (e.g. "$107/sqft"), always well under six
//     figures for this market
//   - derived/threshold figures explicitly flagged by a preceding
//     "under"/"below"/"less than" (buyer_fit's rounded budget framing --
//     true and non-misleading even though it isn't the exact price)
//   - a milestone line's prior price, flagged by a preceding "from"
//     ("... now $999,000 (down from $1,195,000)")
// Every mention that survives this filter must equal the live list price --
// this is what actually catches the 23 Nopalito incident (body said
// $1,195,000, the surviving mention, when live MLS was $999,000).
function extractPriceMentions(body) {
  const out = [];
  const re = /(under|below|less than|from)?\s*\$([\d,]{4,})(?!\s*\/\s*sqft)/gi;
  let m;
  while ((m = re.exec(body))) {
    if (m[1]) continue; // qualified reference, not a price claim
    const n = Number(m[2].replace(/,/g, ''));
    if (n >= 50000) out.push(n);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.body            the post copy to check
 * @param {boolean} opts.isAgentOwned   listing.isAgentOwned
 * @param {boolean} [opts.usesStagedImage] whether the image attached is virtually staged
 * @param {boolean} [opts.hasRealMilestone] true only when the generator has confirmed a
 *   genuine milestone (real price change, real new photo set) for this run
 * @param {object} [opts.status]        the listing_marketing_status row this body was
 *   built from -- { list_price, mls_status, last_verified_at }. When provided, the
 *   gate hard-verifies the body's price/status wording against it and checks
 *   freshness. Omitting this param is only acceptable for content that makes no
 *   MLS price/status claim; every listing post generator call must pass it.
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

  // Unverified in-progress work claim (see header comment) -- blocked
  // unless the caller explicitly passes a verified source for it.
  if (!opts.hasVerifiedRepairStatus) {
    for (const pattern of UNVERIFIED_PROGRESS_CLAIM_PATTERNS) {
      if (pattern.test(body)) {
        reasons.push(`unverified_progress_claim:${pattern.source}`);
        break;
      }
    }
  }

  const status = opts.status;
  if (status) {
    // Freshness: never draft off a snapshot older than the safe window.
    if (!status.last_verified_at) {
      reasons.push('mls_status_unverified');
    } else {
      const ageMinutes = (Date.now() - new Date(status.last_verified_at).getTime()) / 60000;
      if (!Number.isFinite(ageMinutes) || ageMinutes > MAX_STATUS_AGE_MINUTES) {
        reasons.push(`stale_mls_status:${Math.round(ageMinutes)}min_old`);
      }
    }

    // Price: every surviving price-claim mention (see extractPriceMentions)
    // must equal the current live list price. This is the actual fix for
    // the 23 Nopalito incident -- that body's one price-claim mention was
    // $1,195,000 against a live price of $999,000.
    if (status.list_price != null) {
      const mentions = extractPriceMentions(body);
      const expected = Number(status.list_price);
      const wrong = mentions.filter((n) => n !== expected);
      if (wrong.length) {
        reasons.push(`price_mismatch:body_has_${wrong.join('|')}_expected_${expected}`);
      }
    }

    // Status wording: don't claim "active"/"showing" language against an
    // off-market or under-contract-in-option status, and don't claim
    // sold/pending/under-contract language against an actually-active one.
    if (status.mls_status) {
      const postable = isPostableActive(status.mls_status);
      const claimsActive = /\bactive\b|\bshowing now\b|\bnow showing\b/i.test(body);
      const claimsOffMarket = /\bsold\b|\bunder contract\b|\bpending\b/i.test(body);
      if (claimsActive && !postable) {
        reasons.push(`status_mismatch:claims_active_but_mls_status_is_${status.mls_status}`);
      }
      if (claimsOffMarket && postable) {
        reasons.push(`status_mismatch:claims_offmarket_but_mls_status_is_${status.mls_status}`);
      }
      if (OFF_MARKET.has(status.mls_status) || UNDER_CONTRACT_ACTIVE_FAMILY.has(status.mls_status)) {
        // Belt-and-suspenders: this listing should never have reached the
        // generator at all (loadActiveListings filters is_active=false),
        // but if it somehow did, block it outright.
        reasons.push(`listing_not_postable:mls_status_${status.mls_status}`);
      }
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

module.exports = { checkListingPostCompliance, FABRICATED_URGENCY_PATTERNS, UNVERIFIED_PROGRESS_CLAIM_PATTERNS, extractPriceMentions, MAX_STATUS_AGE_MINUTES };
