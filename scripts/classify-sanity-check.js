#!/usr/bin/env node
'use strict';

// scripts/classify-sanity-check.js
//
// OPT-IN, REAL-NETWORK sanity check for the auto-reply risk classifier
// (scripts/_lib/auto-reply-risk-classifier.js). NOT part of the regular
// regression suite — regression files in this repo stay zero-network by
// convention, and an LLM's actual judgment can't be pinned down offline
// anyway (see the header of scripts/regression-auto-reply-classifier.js).
// This is the tool that actually re-validates the model's real behavior:
// run it whenever the rubric prompt changes, or whenever Quinn wants a
// fresh adversarial pass against the live API instead of a stubbed one.
//
// Costs real money (a few cents at most — see the summary line) and takes
// a few seconds per case. Requires a REAL ANTHROPIC_API_KEY in the
// environment.
//
// Usage:
//   node scripts/classify-sanity-check.js
//   node scripts/classify-sanity-check.js --verbose   # print every reason string
//
// Owner: Carter, 2026-09-16

const { classifyCommentRisk, CLASSIFY_MODEL } = require('./_lib/auto-reply-risk-classifier.js');

// Published Claude Haiku 4.5 rates at the time this was written (see the
// claude-api skill's model table) — $1.00/$5.00 per 1M tokens. Update this
// pair if pricing changes; it's an estimate for the printed summary only,
// never used for real billing decisions.
const INPUT_RATE_PER_MTOK = 1.0;
const OUTPUT_RATE_PER_MTOK = 5.0;
// Rough per-call token estimate (this prompt + a short comment/draft pair
// in, a one-line JSON verdict out) — good enough for an order-of-magnitude
// cost line, not a real usage read.
const EST_INPUT_TOKENS_PER_CALL = 350;
const EST_OUTPUT_TOKENS_PER_CALL = 60;

// [label, comment, draft, expectedEligible, expectedCategoryOrNull]
// expectedCategoryOrNull is checked loosely (a near-miss category on an
// escalate case is still a pass for "did it escalate", logged as a note).
const CASES = [
  // Auto-eligible archetypes — should all come back eligible=true, high confidence.
  ['clean thanks', 'Thanks, that helps a lot!', 'anytime', true, 'auto_eligible'],
  ['clean agreement', '100% agree with this', 'yeah, same here', true, 'auto_eligible'],
  ['neutral peer question', 'did you have to switch title companies too?', 'no, kept the same one the whole time', true, 'auto_eligible'],
  ['plain factual TC answer', 'what tripped mine up was the option period deadline', 'yeah that one gets people every time', true, 'auto_eligible'],
  ['real fixture — TC went dark', 'Communication. My last TC went dark for 9 days mid-option.', 'yeah, mine went dark on me too once mid-option. built in a backup contact after that.', true, 'auto_eligible'],

  // Pricing — explicit and comparative/implied.
  ['pricing — explicit cost question', 'What does it cost?', 'depends on the plan honestly', false, 'pricing'],
  ['pricing — indirect ("worth the money")', 'Is it worth the money though?', 'yeah honestly it has paid for itself', false, 'pricing'],
  ['pricing — comparative, no $ ("way cheaper")', 'honestly this looks way cheaper than what I pay now', 'depends on your current setup', false, 'pricing'],
  ['pricing — "pay for itself"', 'Would this pay for itself for someone only doing 3 deals a month?', 'for sure, especially at that volume', false, 'pricing'],

  // Demo requests — explicit and indirect.
  ['demo — explicit ask', 'This sounds cool, can I see a demo?', 'sure, send me your email', false, 'demo_request'],
  ['demo — indirect ("walk me through... back end")', 'Could you walk me through what it actually looks like on the back end?', 'sure, happy to show you sometime', false, 'demo_request'],
  ['demo — indirect ("behind the scenes")', 'What happens behind the scenes when a contract comes in?', 'happy to walk through it sometime', false, 'demo_request'],

  // Complaint / backhanded doubt.
  ['complaint — negative sentiment', 'honestly this whole thing sounds like a scam, my last TC ripped me off', 'sorry to hear that', false, 'complaint'],
  ['complaint — backhanded thanks', 'Thanks, I guess, not sure it actually works though', 'fair enough, it works for me', false, null],

  // Legal/compliance — explicit and indirect.
  ['legal — explicit TREC question', 'does TREC require the buyer to sign that same day?', 'good question, I always double check with my broker', false, 'legal_compliance'],
  ['legal — indirect (earnest money forfeiture)', 'If a buyer backs out after the option period ends, is the earnest money automatically forfeited?', 'depends on the contract terms honestly', false, 'legal_compliance'],

  // Named third party — every reported shape.
  ['third party — possessive ("Sarah\'s closing")', "How did you handle it for Sarah's closing?", 'we just extended the option period a few days', false, 'specific_client'],
  ['third party — unlisted verb ("sharing this with Miguel")', "Sharing this with Miguel since he's been asking about exactly this for his group.", 'happy to chat with him too', false, 'specific_client'],
  ['third party — name before verb ("my buddy Ray asked")', 'my buddy Ray asked about this too the other day', 'small world, happens a lot', false, 'specific_client'],
  ['third party — "X and I" shape', 'Miguel and I were just talking about TC stuff the other day, small world.', 'yeah it comes up more than you would think', false, 'specific_client'],
  ['third party — LOWERCASE name', 'dana loved the checklist feature when I showed her', 'glad it landed well', false, 'specific_client'],

  // Contact request + competitor mention.
  ['contact request — DM ask', 'can you DM me the details?', 'sure thing', false, 'contact_request'],
  ['competitor mention', 'we switched to dotloop last year, way better', 'good to know, thanks', false, 'competitor_mention'],

  // Ambiguous / off-topic — should stay conservative.
  ['off-topic, no clear shape', 'anyway, hope everyone has a good weekend', 'you too', false, null],
];

function estimateCost(numCalls) {
  const inCost = (numCalls * EST_INPUT_TOKENS_PER_CALL / 1e6) * INPUT_RATE_PER_MTOK;
  const outCost = (numCalls * EST_OUTPUT_TOKENS_PER_CALL / 1e6) * OUTPUT_RATE_PER_MTOK;
  return inCost + outCost;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — this tool hits the real API and needs a real key.');
    process.exitCode = 1;
    return;
  }
  const verbose = process.argv.includes('--verbose');
  console.log(`classify-sanity-check: ${CASES.length} live calls against ${CLASSIFY_MODEL}, est. cost $${estimateCost(CASES.length).toFixed(4)}\n`);

  let pass = 0;
  let fail = 0;
  for (const [label, comment, draft, expectedEligible, expectedCategory] of CASES) {
    let r;
    try {
      r = await classifyCommentRisk(comment, draft);
    } catch (err) {
      console.log(`  ERROR - ${label}: ${err.message}`);
      fail++;
      continue;
    }
    const eligibleOk = r.eligible === expectedEligible;
    const categoryOk = expectedCategory === null || r.category === expectedCategory;
    const ok = eligibleOk && categoryOk;
    if (ok) pass++; else fail++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${label} -> eligible=${r.eligible} category=${r.category} confidence=${r.confidence}${ok ? '' : ` (expected eligible=${expectedEligible}${expectedCategory ? ` category=${expectedCategory}` : ''})`}`);
    if (verbose || !ok) console.log(`         reason: ${r.reason}`);
  }

  console.log(`\n${pass}/${CASES.length} passed, ${fail} failed. Est. cost this run: $${estimateCost(CASES.length).toFixed(4)}.`);
  if (fail > 0) process.exitCode = 1;
}

main();
