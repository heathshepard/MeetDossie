'use strict';

// scripts/_lib/listing-post-compliance-gate.test.js
//
// Regression coverage added 2026-09-11 after the 23 Nopalito incident:
// a group_posts draft advertised $1,195,000 while live MLS was $999,000
// (status PCH). Root cause: the generator trusted a listing_marketing_status
// DB snapshot with no price/status verification against the copy it wrote,
// and no limit on how old that snapshot could be. These tests lock in the
// two independent gates added to fix it:
//   1. checkListingPostCompliance() price/status mismatch + staleness
//   2. no accidental regression of the pre-existing TREC/disclosure checks
//
// Run: node scripts/_lib/listing-post-compliance-gate.test.js
// (plain node:test, no framework dependency)

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkListingPostCompliance } = require('./listing-post-compliance-gate');
const { TREC_ATTRIBUTION, OWNER_DISCLOSURE } = require('./listing-marketing-facts');

function freshStatus(overrides = {}) {
  return {
    list_price: 999000,
    mls_status: 'PCH',
    last_verified_at: new Date().toISOString(),
    ...overrides,
  };
}

test('BLOCKS the exact 23 Nopalito incident: body price stale vs current MLS price', () => {
  const body = `23 Nopalito, San Antonio TX - active, $1,195,000, 4,495 sqft, Sendero Ranch.\n\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({
    body,
    isAgentOwned: false,
    status: freshStatus({ list_price: 999000, mls_status: 'PCH' }),
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.startsWith('price_mismatch')), `expected price_mismatch, got ${result.reasons}`);
});

test('ALLOWS a post whose price matches the current MLS list price exactly', () => {
  const body = `23 Nopalito, San Antonio TX - active, $999,000, 4,495 sqft, Sendero Ranch.\n\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({
    body,
    isAgentOwned: false,
    status: freshStatus({ list_price: 999000, mls_status: 'PCH' }),
  });
  assert.equal(result.allowed, true, `expected allowed, got reasons ${result.reasons}`);
});

test('ALLOWS a genuine milestone post referencing BOTH the old and new price', () => {
  const body = `Price update on 23 Nopalito: now $999,000 (down from $1,195,000).\n\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({
    body,
    isAgentOwned: false,
    hasRealMilestone: true,
    status: freshStatus({ list_price: 999000, mls_status: 'PCH' }),
  });
  assert.equal(result.allowed, true, `expected allowed, got reasons ${result.reasons}`);
});

test('BLOCKS a stale status snapshot regardless of price match (staleness gate)', () => {
  const body = `23 Nopalito, San Antonio TX - active, $999,000, 4,495 sqft, Sendero Ranch.\n\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({
    body,
    isAgentOwned: false,
    status: freshStatus({ list_price: 999000, mls_status: 'PCH', last_verified_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }), // 60min old
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.startsWith('stale_mls_status')), `expected stale_mls_status, got ${result.reasons}`);
});

test('BLOCKS status wording mismatch -- claims active against an off-market status', () => {
  const body = `23 Nopalito, San Antonio TX - active, $999,000, 4,495 sqft.\n\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({
    body,
    isAgentOwned: false,
    status: freshStatus({ list_price: 999000, mls_status: 'PEN' }),
  });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.includes('status_mismatch') || r.includes('listing_not_postable')), `expected a status reason, got ${result.reasons}`);
});

test('unchanged: still blocks missing TREC attribution', () => {
  const result = checkListingPostCompliance({ body: 'no attribution here', isAgentOwned: false });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('missing_trec_attribution'));
});

test('unchanged: still blocks missing owner disclosure on an agent-owned listing', () => {
  const body = `702 Fawndale Dr - $500,000.\n\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({ body, isAgentOwned: true });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('missing_owner_disclosure'));
});

test('integration: every real generator template passes the gate at the correct live price, for every tracked listing', () => {
  // Requires the real generator + fact pack -- catches template-vs-gate
  // false positives (e.g. buyer_fit's rounded "under $X" budget framing,
  // price_value's $/sqft comp figure) that a synthetic body wouldn't.
  const { buildOwnedPost, buildGroupPost } = require('../listing-marketing-generator');
  const { LISTINGS } = require('./listing-marketing-facts');
  const OWNED_ANGLES = ['room_feature', 'price_value', 'neighborhood_lifestyle', 'buyer_fit', 'agent_to_agent', 'showing_availability'];
  const GROUP_ANGLES = ['agent_to_agent', 'buyer_fit', 'price_value', 'room_feature'];
  for (const mls of Object.keys(LISTINGS)) {
    const listing = LISTINGS[mls];
    const status = freshStatus({ list_price: 123456, mls_status: 'ACT' }); // arbitrary but internally consistent
    for (const angle of OWNED_ANGLES) {
      const { body, hasMilestone } = buildOwnedPost(listing, status, angle);
      const gate = checkListingPostCompliance({ body, isAgentOwned: listing.isAgentOwned, hasRealMilestone: hasMilestone, status });
      assert.equal(gate.allowed, true, `${listing.key}/${angle} (owned) should pass at its own live price, got ${gate.reasons}`);
    }
    for (const angle of GROUP_ANGLES) {
      const body = buildGroupPost(listing, status, angle, {});
      const gate = checkListingPostCompliance({ body, isAgentOwned: listing.isAgentOwned, status });
      assert.equal(gate.allowed, true, `${listing.key}/${angle} (group) should pass at its own live price, got ${gate.reasons}`);
    }
  }
});

test('integration: every real generator template BLOCKS when the status price differs from what the body was built with', () => {
  const { buildOwnedPost } = require('../listing-marketing-generator');
  const { LISTINGS } = require('./listing-marketing-facts');
  const listing = LISTINGS['1916402'];
  const builtWith = freshStatus({ list_price: 999000, mls_status: 'PCH' });
  const claimedLive = freshStatus({ list_price: 1195000, mls_status: 'ACT' }); // the DB says something else now
  for (const angle of ['room_feature', 'price_value', 'agent_to_agent']) {
    const { body, hasMilestone } = buildOwnedPost(listing, builtWith, angle);
    const gate = checkListingPostCompliance({ body, isAgentOwned: listing.isAgentOwned, hasRealMilestone: hasMilestone, status: claimedLive });
    assert.equal(gate.allowed, false, `${angle} should block on a price mismatch`);
    assert.ok(gate.reasons.some((r) => r.startsWith('price_mismatch')));
  }
});

// ─── Regression coverage added 2026-09-11 (urgent fix) ─────────────────────
// A Fawndale draft claimed "Make-ready repairs are wrapping up now" / "are
// in progress" -- unsourced. Heath had emailed the property manager 20 min
// earlier asking for a completion date and had no answer. No field this
// pipeline reads verifies repair-completion state, so any such claim must
// be blocked outright until one exists.

test('BLOCKS the exact 702 Fawndale incident: unsourced "repairs wrapping up now" claim', () => {
  const body = `702 Fawndale Ln, Windcrest. Make-ready repairs are wrapping up now.\n\n${OWNER_DISCLOSURE}\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({ body, isAgentOwned: true });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.startsWith('unverified_progress_claim')), `expected unverified_progress_claim, got ${result.reasons}`);
});

test('BLOCKS the alternate phrasing actually queued to Telegram: "repairs are in progress"', () => {
  const body = `Make-ready repairs are in progress, showings start once they're complete.\n\n${OWNER_DISCLOSURE}\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({ body, isAgentOwned: true });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.some((r) => r.startsWith('unverified_progress_claim')), `expected unverified_progress_claim, got ${result.reasons}`);
});

test('ALLOWS the same body once a caller passes an explicit verified source', () => {
  const body = `Make-ready repairs are in progress, showings start once they're complete.\n\n${OWNER_DISCLOSURE}\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({ body, isAgentOwned: true, hasVerifiedRepairStatus: true });
  assert.equal(result.allowed, true, `expected allowed once verified, got ${result.reasons}`);
});

test('unchanged: a permanent, already-done renovation fact is NOT caught by the progress-claim guard', () => {
  const body = `Fully renovated 2024 -- LVP flooring, ceramic tile, fresh paint, modern cabinetry.\n\n${OWNER_DISCLOSURE}\n${TREC_ATTRIBUTION}`;
  const result = checkListingPostCompliance({ body, isAgentOwned: true });
  assert.equal(result.allowed, true, `expected allowed, got ${result.reasons}`);
});
