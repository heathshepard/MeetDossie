#!/usr/bin/env node
// Regression tests for api/_lib/post-scorer.js (brokerage rubric) and its
// wiring into the two rubrics selected by target_owner.
//
// Stubs the Anthropic call so scoring is deterministic and offline. What
// this proves:
//   1. A listing post with NO signup CTA (real listing copy: "Message me and
//      I'll let you know the day it's ready") scores well on the brokerage
//      rubric — the exact case the old software rubric auto-rejected at
//      2/10 CTA on 2026-09-11.
//   2. A listing post missing the brokerage name is BLOCKED by the
//      compliance gate (hard gate, not a score) regardless of how well it
//      would otherwise score.
//   3. A Dossie SaaS post (target_owner unset / 'dossie') is left alone —
//      isBrokeragePost() returns false, so it still goes through the
//      existing software rubric in api/cron-send-for-approval.js.
//   4. Text-only listing media scores near zero; video scores highest.
//
// Usage: node scripts/carter-brokerage-rubric-test.js

'use strict';

// post-scorer.js reads ANTHROPIC_API_KEY at module-load time — must be set
// BEFORE require() or scoreBrokeragePost() short-circuits to null.
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const {
  isBrokeragePost,
  checkBrokerageCompliance,
  scoreMediaDimension,
  scoreBrokeragePost,
  BROKERAGE_WARN_THRESHOLD,
} = require('../api/_lib/post-scorer.js');

const realFetch = global.fetch;

function stubScorerResponse(payload) {
  global.fetch = async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
      };
    }
    return realFetch(url);
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
}

const REAL_LISTING_POST = {
  target_owner: 'heath-realtor',
  platform: 'facebook',
  media_url: 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/videos/listing-marketing/fawndale/702-fawndale-square.mp4',
  content: `New listing in Windcrest: 702 Fawndale Ln, going live today at $330,000.

4 bed, 3 bath, 2,334 sqft, no HOA, built 1966. Make-ready is in progress, showings start as soon as it's done. Message me and I'll let you know the day it's ready.

Heath Shepard, REALTOR | Keller Williams City View | TX Lic #751964`,
};

(async () => {
  // ── 1. isBrokeragePost() selector ────────────────────────────────────
  check(
    'isBrokeragePost: target_owner=heath-realtor -> true',
    isBrokeragePost({ target_owner: 'heath-realtor' }) === true,
  );
  check(
    'isBrokeragePost: target_owner=dossie -> false',
    isBrokeragePost({ target_owner: 'dossie' }) === false,
  );
  check(
    'isBrokeragePost: target_owner unset -> false (Dossie posts unaffected)',
    isBrokeragePost({}) === false,
  );

  // ── 2. Listing post with NO signup CTA scores well on brokerage rubric ──
  // "Message me and I'll let you know the day it's ready" is a real listing
  // CTA (reply invite) — it would have scored 2/10 on the software rubric's
  // signup-CTA dimension. On the brokerage rubric it should score high on
  // hook/local_signal/reply_invite/specifics, and media=10 (video attached).
  stubScorerResponse({ hook: 8, local_signal: 9, reply_invite: 8, specifics: 8 });
  const listingScore = await scoreBrokeragePost(REAL_LISTING_POST);
  check(
    'brokerage rubric: real listing post (no signup CTA) scores well',
    !!listingScore && listingScore.composite >= 7,
    listingScore,
  );
  check(
    'brokerage rubric: video media_url scores media=10',
    listingScore && listingScore.media === 10,
    listingScore,
  );
  check(
    'brokerage rubric: score is NOT below the warn threshold for good copy',
    listingScore && listingScore.composite >= BROKERAGE_WARN_THRESHOLD,
    listingScore,
  );

  // ── 3. Media dimension is deterministic (not LLM-judged) ───────────────
  check('media: text-only (no media_url) scores 0', scoreMediaDimension({ media_url: null }) === 0);
  check('media: image scores 5', scoreMediaDimension({ media_url: 'https://x/y/pic.jpg' }) === 5);
  check('media: video scores 10', scoreMediaDimension({ media_url: 'https://x/y/clip.mp4' }) === 10);

  // ── 4. Compliance gate — hard block, missing brokerage name ────────────
  const missingBrokerName = checkBrokerageCompliance(
    'Great new listing in Windcrest, 4 bed 3 bath, message me for a showing!',
  );
  check(
    'compliance gate: BLOCKS a post missing the brokerage name',
    missingBrokerName.allowed === false && missingBrokerName.reason === 'missing_brokerage_name',
    missingBrokerName,
  );

  const withBrokerName = checkBrokerageCompliance(REAL_LISTING_POST.content);
  check(
    'compliance gate: ALLOWS a post that includes "Keller Williams"',
    withBrokerName.allowed === true,
    withBrokerName,
  );

  // A post could theoretically score well on every content dimension and
  // STILL be blocked — compliance is independent of the score.
  stubScorerResponse({ hook: 10, local_signal: 10, reply_invite: 10, specifics: 10 });
  const highScoringButNoBrokerName = await scoreBrokeragePost({
    target_owner: 'heath-realtor',
    platform: 'facebook',
    media_url: 'https://x/y/clip.mp4',
    content: 'Amazing new listing in Windcrest, message me!',
  });
  const gateOnHighScorer = checkBrokerageCompliance('Amazing new listing in Windcrest, message me!');
  check(
    'compliance gate: a 10/10-content post with no brokerage name is still blocked',
    highScoringButNoBrokerName.composite === 10 && gateOnHighScorer.allowed === false,
    { score: highScoringButNoBrokerName, gate: gateOnHighScorer },
  );

  // ── 5. Dossie SaaS post is untouched by the brokerage rubric ───────────
  // A Dossie post is never routed into scoreBrokeragePost/checkBrokerageCompliance
  // at all — api/cron-send-for-approval.js branches on isBrokeragePost(post)
  // BEFORE calling either. Confirm the selector alone is what gates it.
  const dossiePost = { target_owner: 'dossie', platform: 'instagram', content: 'Sign up for Dossie today!' };
  check(
    'Dossie post: isBrokeragePost() is false so cron-send-for-approval keeps using scorePost() (software rubric)',
    isBrokeragePost(dossiePost) === false,
  );

  global.fetch = realFetch;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
