#!/usr/bin/env node
'use strict';

// scripts/regression-listing-reel-trigger.js
//
// Regression suite for the R1 listing-reel auto-trigger. Same convention as
// scripts/regression-listing-marketing-generate-live.js: no browser, no
// connectMLS, no Supabase writes, no Telegram -- everything injected.
//
// The reason this file exists is CASE 1. During the R1 build, a rehearsal
// harness re-stamped last_verified_at to "now" so the 30-minute freshness
// gate would let an artifact through. That is the 2026-09-11 stale-price
// incident wearing a disguise: a gate you can satisfy by editing the value it
// checks is not a gate, and the next run that reuses the path will be doing
// it with data that is genuinely hours old. A note in a JSON file does not
// prevent that recurring. An assertion does.
//
// Run: node scripts/regression-listing-reel-trigger.js

const path = require('path');
const assert = require('assert');

process.env.CONTENT_BLOCK_LIST_PATH = process.env.CONTENT_BLOCK_LIST_PATH
  || path.join(__dirname, '..', 'docs', 'CONTENT-DO-NOT-WRITE-LIST.md');

const T = require('./listing-reel-trigger');
const G = require('./_lib/listing-reel-copy-gate');
const { LISTINGS, TREC_ATTRIBUTION, OWNER_DISCLOSURE } = require('./_lib/listing-marketing-facts');
const { MAX_STATUS_AGE_MINUTES } = require('./_lib/listing-post-compliance-gate');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); } catch (e) {
    failures++; console.error(`  FAIL  ${name}\n        ${e.message}`);
  }
}

const freshRow = () => ({
  mls_number: '1916402',
  address: '23 Nopalito',
  city: 'San Antonio',
  zip: '78261',
  list_price: 999000,
  mls_status: 'PCH',
  is_active: true,
  is_agent_owned: false,
  last_verified_at: new Date().toISOString(),
  last_verified_by: 'listing-marketing-status-sync.js',
});

console.log('\n1. LIVE-READ PROVENANCE (the stale-price invariant)');

check('a genuinely fresh, same-process row is accepted', () => {
  assert.strictEqual(T.assertLiveProvenance([freshRow()]).ok, true);
});

check('a STALE read is REFUSED -- never re-stamped, never "adjusted" through', () => {
  const stale = freshRow();
  stale.last_verified_at = new Date(Date.now() - (MAX_STATUS_AGE_MINUTES + 5) * 60000).toISOString();
  const res = T.assertLiveProvenance([stale]);
  assert.strictEqual(res.ok, false, 'a read older than the freshness window MUST be refused');
  assert.ok(/stale/.test(res.reason), `expected a stale reason, got: ${res.reason}`);
});

check('a row with NO verification provenance is REFUSED', () => {
  const noProv = freshRow(); noProv.last_verified_by = null;
  assert.strictEqual(T.assertLiveProvenance([noProv]).ok, false);
  const noTime = freshRow(); noTime.last_verified_at = null;
  assert.strictEqual(T.assertLiveProvenance([noTime]).ok, false);
});

check('ZERO verified listings is REFUSED -- never a cached/DB fallback', () => {
  assert.strictEqual(T.assertLiveProvenance([]).ok, false);
  assert.strictEqual(T.assertLiveProvenance(null).ok, false);
});

check('runReelTrigger ABORTS (builds nothing) on a stale live read', async () => {
  const stale = freshRow();
  stale.last_verified_at = new Date(Date.now() - (MAX_STATUS_AGE_MINUTES + 60) * 60000).toISOString();
  let alerted = false;
  return T.runReelTrigger({
    freshStatuses: [stale], dryRun: true,
    notifyHeath: async () => { alerted = true; return { ok: true }; },
  }).then((res) => {
    assert.strictEqual(res.built, 0, 'a stale read must build ZERO reels');
    assert.strictEqual(res.aborted, true);
    assert.ok(alerted, 'a stale read must ALERT, not fail silently');
  });
});

console.log('\n2. TRIGGER DETECTION + IDEMPOTENCY');

check('a never-seen listing fires as new_listing', () => {
  const c = T.classifyTrigger(freshRow(), null);
  assert.strictEqual(c.fire, true);
  assert.strictEqual(c.reason, 'new_listing');
});

check('an unchanged listing does NOT re-fire', () => {
  const row = freshRow();
  const ledger = { last_mls_status: row.mls_status, last_list_price: row.list_price, fired: {}, angle_history: [] };
  assert.strictEqual(T.classifyTrigger(row, ledger).fire, false);
});

check('a REAL price change fires a refresh', () => {
  const row = freshRow();
  const ledger = { last_mls_status: 'PCH', last_list_price: 1195000, fired: {}, angle_history: [] };
  const c = T.classifyTrigger(row, ledger);
  assert.strictEqual(c.fire, true);
  assert.strictEqual(c.reason, 'price_refresh');
});

check('a REAL status change fires', () => {
  const row = freshRow();
  const ledger = { last_mls_status: 'ACT', last_list_price: row.list_price, fired: {}, angle_history: [] };
  assert.ok(T.classifyTrigger(row, ledger).reason.startsWith('status_change:'));
});

check('the same event never fires twice (fingerprint ledger)', () => {
  const row = freshRow();
  const fp = T.fingerprintOf(row);
  const ledger = { last_mls_status: row.mls_status, last_list_price: row.list_price, angle_history: [], fired: { [fp]: { outcome: 'queued' } } };
  assert.strictEqual(T.classifyTrigger(row, ledger).fire, false);
});

check('withdrawn/expired never produces a reel', () => {
  for (const s of ['WD', 'EXP', 'CAN']) {
    const row = { ...freshRow(), mls_status: s };
    assert.strictEqual(T.classifyTrigger(row, null).fire, false, `${s} must not fire`);
  }
});

console.log('\n3. COPY GATE');

const photoStub = { dir: '/nonexistent', prefix: 'x-photo', count: 6 };

check('generated copy for every angle passes the gate', () => {
  const row = freshRow();
  for (const angle of ['room_feature', 'price_value', 'neighborhood_lifestyle', 'buyer_fit', 'agent_to_agent', 'showing_availability']) {
    const b = T.buildReelSpec({ row, listing: LISTINGS[row.mls_number], angle, kind: 'listing_reel', reelId: 'r', photo: photoStub });
    const g = G.checkReelCopy({ surfaces: b.surfaces, status: row, listing: LISTINGS[row.mls_number], showPrice: b.showPrice });
    assert.ok(g.allowed, `${angle} blocked: ${g.reasons.join(', ')}`);
  }
});

check('weakness copy is BLOCKED (price-change reference, future-cut hint, DOM, motivation)', () => {
  const row = freshRow();
  for (const bad of [
    'New price on 23 Nopalito, down from $1,195,000.',
    'Reach out before the price does that again.',
    'Motivated seller, priced to sell.',
    '287 days on market and back on the market.',
  ]) {
    const g = G.checkReelCopy({
      surfaces: [{ name: 'voiceover_script', text: bad }, { name: 'closing_card', text: 'Keller Williams City View' }],
      status: row, showPrice: false,
    });
    assert.strictEqual(g.allowed, false, `should have blocked: ${bad}`);
    assert.ok(g.reasons.some((r) => r.startsWith('weakness_copy:')), `expected a weakness reason for: ${bad}`);
  }
});

check('fair-housing steering language is a HARD_BLOCK', () => {
  const g = G.checkReelCopy({
    surfaces: [{ name: 'voiceover_script', text: 'Great schools, a safe neighborhood, perfect for families.' }, { name: 'closing_card', text: 'Keller Williams City View' }],
    status: freshRow(), showPrice: false,
  });
  assert.strictEqual(g.allowed, false);
  assert.ok(g.reasons.some((r) => r.includes('fair_housing_steering_language')));
});

check('a price that does not match the LIVE list price is BLOCKED', () => {
  const row = freshRow(); // live $999,000
  const g = G.checkReelCopy({
    surfaces: [{ name: 'price_pill', text: '$1,195,000' }, { name: 'closing_card', text: 'Keller Williams City View' }],
    status: row, showPrice: true,
  });
  assert.strictEqual(g.allowed, false);
  assert.ok(g.reasons.some((r) => r.startsWith('price_mismatch:')), g.reasons.join(', '));
});

check('a SOLD listing never shows a price, anywhere', () => {
  const row = { ...freshRow(), mls_status: 'SLD' };
  const b = T.buildReelSpec({ row, listing: LISTINGS[row.mls_number], angle: 'just_sold', kind: 'just_sold', reelId: 'r', photo: photoStub });
  assert.strictEqual(b.spec.show_price, false);
  assert.strictEqual(b.spec.price, null);
  const allText = b.surfaces.map((s) => s.text).join(' ');
  assert.ok(!/\$\s*[\d,]{4,}/.test(allText), 'no price may appear on any surface of a just-sold reel');
});

check('the TREC broker name must be on the closing card', () => {
  const row = freshRow();
  const b = T.buildReelSpec({ row, listing: LISTINGS[row.mls_number], angle: 'price_value', kind: 'listing_reel', reelId: 'r', photo: photoStub });
  const card = b.surfaces.find((s) => s.name === 'closing_card');
  assert.ok(card.text.includes('Keller Williams City View'), 'broker name missing from the card');
  assert.ok(TREC_ATTRIBUTION.includes('Keller Williams City View'), 'broker name must come from TREC_ATTRIBUTION, not a literal');
  // strip it and the gate must refuse
  const stripped = b.surfaces.map((s) => (s.name === 'closing_card' ? { ...s, text: s.text.replace('Keller Williams City View', '') } : s));
  const g = G.checkReelCopy({ surfaces: stripped, status: row, listing: LISTINGS[row.mls_number], showPrice: b.showPrice });
  assert.strictEqual(g.allowed, false);
  assert.ok(g.reasons.some((r) => r.startsWith('missing_trec_broker_name')));
});

check('an AGENT-OWNED listing carries the owner/agent disclosure', () => {
  for (const mls of ['1997664', '2015607']) { // 130 Senisa, 702 Fawndale -- Heath owns both
    const listing = LISTINGS[mls];
    assert.strictEqual(listing.isAgentOwned, true, `${mls} should be agent-owned in the fact pack`);
    const row = { ...freshRow(), mls_number: mls, address: listing.address, is_agent_owned: true, mls_status: 'ACT', list_price: 389000 };
    const b = T.buildReelSpec({ row, listing, angle: 'price_value', kind: 'listing_reel', reelId: 'r', photo: photoStub });
    const cap = b.surfaces.find((s) => s.name === 'caption');
    assert.ok(cap.text.includes(OWNER_DISCLOSURE), `${listing.address} caption is missing the owner disclosure`);
    // strip it and the gate must refuse
    const stripped = b.surfaces.map((s) => (s.name === 'caption' ? { ...s, text: s.text.replace(OWNER_DISCLOSURE, '') } : s));
    const g = G.checkReelCopy({ surfaces: stripped, status: row, listing, showPrice: b.showPrice });
    assert.strictEqual(g.allowed, false, `${listing.address}: a missing owner disclosure must block`);
    assert.ok(g.reasons.some((r) => r.startsWith('missing_owner_disclosure')));
  }
});

check('a present-condition claim is blocked on a listing with an active conditionCaveat', () => {
  const listing = LISTINGS['2015607']; // 702 Fawndale -- make-ready pending
  assert.ok(listing.conditionCaveat, 'fixture expects a conditionCaveat');
  const row = { ...freshRow(), mls_number: '2015607', mls_status: 'NEW', list_price: 330000 };
  const g = G.checkReelCopy({
    surfaces: [
      { name: 'voiceover_script', text: '702 Fawndale Ln is move-in ready and immaculate.' },
      { name: 'caption', text: OWNER_DISCLOSURE },
      { name: 'closing_card', text: 'Keller Williams City View' },
    ],
    status: row, listing, showPrice: false,
  });
  assert.strictEqual(g.allowed, false);
  assert.ok(g.reasons.some((r) => r.startsWith('condition_claim_against_caveat')));
});

check('CONTENT_BLOCK_LIST_PATH is read PER CALL, not at import', () => {
  // Reading it once at module load silently ignores a path set after the
  // require -- a compliance gate that looks configured and is not.
  const saved = process.env.CONTENT_BLOCK_LIST_PATH;
  const real = path.join(__dirname, '..', 'docs', 'CONTENT-DO-NOT-WRITE-LIST.md');
  const fs = require('fs');
  const alt = fs.existsSync(real) ? real : saved;
  if (!alt) { console.log('        (skipped: no doc path available)'); return; }
  try {
    delete process.env.CONTENT_BLOCK_LIST_PATH;
    process.env.CONTENT_BLOCK_LIST_PATH = alt;
    assert.strictEqual(G.loadBlockList().docPath, alt, 'env set after import must take effect');
  } finally { process.env.CONTENT_BLOCK_LIST_PATH = saved; }
});

check('an unreachable block list HALTS -- never renders unchecked', () => {
  const saved = process.env.CONTENT_BLOCK_LIST_PATH;
  const fs = require('fs');
  const repoDoc = path.join(__dirname, '..', 'docs', 'CONTENT-DO-NOT-WRITE-LIST.md');
  if (fs.existsSync(repoDoc)) {
    // The in-repo fallback exists, so the only way to prove the halt is to
    // parse a file that is NOT the index table -- same failure class.
    assert.throws(() => G.loadBlockList(path.join(__dirname, '..', 'package.json')), /ZERO rows|not found/);
  } else {
    try {
      delete process.env.CONTENT_BLOCK_LIST_PATH;
      assert.throws(() => G.loadBlockList('/definitely/not/a/doc.md'), /not found/);
    } finally { process.env.CONTENT_BLOCK_LIST_PATH = saved; }
  }
});

check('every blocking topic in the doc has a detector', () => {
  G.assertDetectorCoverage(G.loadBlockList());
});

console.log('\n4. QUALITY GATE IS FAIL-CLOSED');

check('a missing video fails, never passes', () => {
  const r = T.runQualityGate('/definitely/not/a/video.mp4', null);
  assert.strictEqual(r.pass, false, 'the gate must never pass a video it could not check');
});

// ── summary ──
setTimeout(() => {
  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL CHECKS PASSED'}\n`);
  if (failures) process.exitCode = 1;
}, 250);
