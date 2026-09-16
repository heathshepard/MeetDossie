#!/usr/bin/env node
'use strict';

/**
 * Regression test for the auto-reply-with-veto risk classifier + content
 * gates (scripts/_lib/auto-reply-risk-classifier.js +
 * scripts/_lib/auto-reply-content-gates.js — Heath's explicit approval,
 * 2026-09-16, supabase/migrations/20260916_auto_reply_veto.sql +
 * 20260916b_auto_reply_model_verdict.sql).
 *
 * ARCHITECTURE NOTE — READ BEFORE EDITING THIS FILE
 * --------------------------------------------------
 * The classifier is now a Claude Haiku 4.5 model call (rewritten
 * 2026-09-16, 3rd QA round — a fixed regex list kept losing to genuinely
 * semantic categories: named third parties and comparative/implied pricing
 * take unbounded surface forms a pattern list can't enumerate). This suite
 * stays ZERO-NETWORK, so it can only prove two things offline:
 *   1. THE HARNESS is correct: the hard pre-filter can only escalate and
 *      never calls the model, the confidence gate downgrades anything
 *      short of "high" to not-eligible, and every failure mode (missing
 *      key, network error, timeout, malformed JSON, schema-invalid field)
 *      fails closed. This is exercised against the REAL classifyWithModel
 *      code by monkey-patching global.fetch — not just asserting a
 *      contract.
 *   2. THE PROMPT still contains the specific semantic instructions that
 *      fixed each previously-reported miss (comparative pricing, indirect
 *      demo asks, named third party in ANY phrasing) — a silent prompt
 *      edit that drops one of these lines is caught here even though the
 *      suite can't call the real model to prove the rubric still WORKS.
 * It CANNOT prove the model will classify any given sentence correctly in
 * production — that is Quinn's job, running live adversarial cases against
 * the real API (see scripts/classify-sanity-check.js for the opt-in,
 * real-network tool built for exactly that). Fixtures below that represent
 * "cases Quinn found" inject a STUBBED model verdict of what a correctly-
 * instructed model should return, to prove the harness relays it right —
 * they are not proof the model actually will. Don't mistake a green run
 * here for "the classifier is right"; it only means "the harness isn't
 * broken and the rubric still says the right things."
 *
 * Run manually:
 *   node scripts/regression-auto-reply-classifier.js
 */

const assert = require('assert');
const {
  classifyCommentRisk,
  classifyWithModel,
  CLASSIFY_PROMPT,
  CLASSIFY_MODEL,
  PRE_FILTER_PATTERNS,
  KNOWN_CATEGORIES,
} = require('./_lib/auto-reply-risk-classifier.js');
const { checkContentGates } = require('./_lib/auto-reply-content-gates.js');

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// ─── Stub helpers ────────────────────────────────────────────────────────────

/** A model call that resolves to a fixed verdict — never touches the network. */
function stubVerdict(verdict) {
  return async () => ({ source: 'model', ...verdict });
}

/** A model call that FAILS the test if invoked at all — for pre-filter tests. */
function throwingClassify() {
  return async () => { throw new Error('classify() must never be called — the pre-filter should have short-circuited'); };
}

async function main() {
  console.log('auto-reply risk classifier (model-based) + content gates');

  // ─── 1. Hard pre-filter — ESCALATE-ONLY, never calls the model ──────────

  await check('pre-filter: an explicit $ figure escalates WITHOUT calling the model', async () => {
    const r = await classifyCommentRisk('what do you use for TC work?', 'runs about $29/mo honestly', { classify: throwingClassify() });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.category, 'pricing');
    assert.strictEqual(r.source, 'pre_filter');
  });

  await check('pre-filter: the word "demo" escalates WITHOUT calling the model', async () => {
    const r = await classifyCommentRisk('can I see a demo?', 'sure, happy to show you', { classify: throwingClassify() });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.category, 'demo_request');
    assert.strictEqual(r.source, 'pre_filter');
  });

  await check('pre-filter: the word "trial" escalates WITHOUT calling the model', async () => {
    const r = await classifyCommentRisk('is there a free trial?', 'not currently', { classify: throwingClassify() });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.category, 'demo_request');
  });

  await check('pre-filter: a $ figure leaking into the DRAFT (not the comment) still escalates', async () => {
    const r = await classifyCommentRisk('what do you use for TC work?', 'honestly it costs about $30/mo and worth it', { classify: throwingClassify() });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.category, 'pricing');
  });

  await check('pre-filter can NEVER certify eligible, even if it matched nothing — only escalate paths use it', () => {
    // Structural check on the module itself: PRE_FILTER_PATTERNS has no
    // notion of "eligible" — it's a flat escalate-category list.
    assert.ok(Array.isArray(PRE_FILTER_PATTERNS) && PRE_FILTER_PATTERNS.length > 0);
    for (const p of PRE_FILTER_PATTERNS) {
      assert.ok(p.category && p.category !== 'auto_eligible', 'a pre-filter entry must never be the eligible category');
    }
  });

  // ─── 2. Confidence gate — model eligible=true is necessary, NOT sufficient ─

  await check('model says eligible=true, confidence="high" -> final eligible=true', async () => {
    const r = await classifyCommentRisk('thanks, that helps!', 'anytime', {
      classify: stubVerdict({ eligible: true, category: 'auto_eligible', confidence: 'high', reason: 'clean thanks' }),
    });
    assert.strictEqual(r.eligible, true);
    assert.strictEqual(r.category, 'auto_eligible');
    assert.strictEqual(r.confidence, 'high');
  });

  await check('model says eligible=true, confidence="medium" -> final eligible=FALSE (gate)', async () => {
    const r = await classifyCommentRisk('thanks I guess', 'anytime', {
      classify: stubVerdict({ eligible: true, category: 'auto_eligible', confidence: 'medium', reason: 'mostly clean' }),
    });
    assert.strictEqual(r.eligible, false);
  });

  await check('model says eligible=true, confidence="low" -> final eligible=FALSE (gate)', async () => {
    const r = await classifyCommentRisk('sure', 'ok', {
      classify: stubVerdict({ eligible: true, category: 'auto_eligible', confidence: 'low', reason: 'uncertain' }),
    });
    assert.strictEqual(r.eligible, false);
  });

  await check('model says eligible=false regardless of confidence -> final eligible=FALSE, category propagated', async () => {
    const r = await classifyCommentRisk('what does it cost?', 'depends', {
      classify: stubVerdict({ eligible: false, category: 'pricing', confidence: 'high', reason: 'asks about cost' }),
    });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.category, 'pricing');
  });

  await check('reason and confidence from the model are always forwarded onto the row (diagnosability)', async () => {
    const r = await classifyCommentRisk('anything', 'anything', {
      classify: stubVerdict({ eligible: false, category: 'low_confidence', confidence: 'low', reason: 'the exact reason string' }),
    });
    assert.strictEqual(r.reason, 'the exact reason string');
    assert.strictEqual(r.confidence, 'low');
  });

  // ─── 3. Fail-closed paths — real classifyWithModel, network monkey-patched ─

  const realFetch = global.fetch;
  function restoreFetch() { global.fetch = realFetch; }

  await check('fail-closed: missing ANTHROPIC_API_KEY escalates without any network call', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; throw new Error('must not be called'); };
    try {
      // Re-require with a clean module cache so the module-level
      // ANTHROPIC_API_KEY constant re-reads the (now-deleted) env var.
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
      assert.ok(/API_KEY/.test(verdict.reason));
      assert.strictEqual(fetchCalled, false);
    } finally {
      restoreFetch();
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: a network error (fetch throws) escalates as model_error', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: a timeout (AbortError) escalates as model_error with a timeout reason', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
      assert.ok(/timed out/i.test(verdict.reason));
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: a non-200 API response escalates as model_error', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'internal error' });
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
      assert.ok(/500/.test(verdict.reason));
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: a response with no JSON block at all escalates as model_error', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'sorry, I cannot help with that request' }] }),
    });
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: JSON present but eligible is not a boolean (schema-invalid) escalates as model_error', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"eligible": "yes", "category": "auto_eligible", "confidence": "high", "reason": "ok"}' }] }),
    });
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: an unknown/invented category (schema-invalid) escalates as model_error', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"eligible": true, "category": "totally_fine", "confidence": "high", "reason": "ok"}' }] }),
    });
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
      assert.ok(KNOWN_CATEGORIES.size > 0);
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: an invalid confidence value (schema-invalid) escalates as model_error', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"eligible": true, "category": "auto_eligible", "confidence": "very-high", "reason": "ok"}' }] }),
    });
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('hi', 'hi');
      assert.strictEqual(verdict.eligible, false);
      assert.strictEqual(verdict.source, 'model_error');
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: a genuinely valid, well-formed response IS accepted (positive control for the parser)', async () => {
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: '{"eligible": true, "category": "auto_eligible", "confidence": "high", "reason": "clean agreement"}' }] }),
    });
    try {
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
      const fresh = require('./_lib/auto-reply-risk-classifier.js');
      const verdict = await fresh.classifyWithModel('100% agree', 'yeah same here');
      assert.strictEqual(verdict.eligible, true);
      assert.strictEqual(verdict.source, 'model');
      assert.strictEqual(verdict.reason, 'clean agreement');
    } finally {
      restoreFetch();
      delete require.cache[require.resolve('./_lib/auto-reply-risk-classifier.js')];
    }
  });

  await check('fail-closed: an empty draft escalates before any model call, source=pre_filter', async () => {
    const r = await classifyCommentRisk('thanks!', '', { classify: throwingClassify() });
    assert.strictEqual(r.eligible, false);
  });

  // ─── 4. Rubric content — the specific instructions that fixed each     ────
  // reported miss must still be IN the prompt. This can't prove the model
  // obeys them; it catches a silent edit that deletes the instruction.

  await check('rubric: comparative/implied pricing is explicitly named (not just a $ figure)', () => {
    const prompt = CLASSIFY_PROMPT('x', 'y');
    assert.ok(/comparative|implied/i.test(prompt), 'prompt must instruct escalating comparative/implied pricing');
    assert.ok(/cheaper than what I pay now|worth it|pay for itself/i.test(prompt), 'prompt should give a concrete comparative-pricing example');
  });

  await check('rubric: a named third party escalates "at all", "any phrasing", "any verb", regardless of capitalization', () => {
    const prompt = CLASSIFY_PROMPT('x', 'y');
    assert.ok(/named third party/i.test(prompt));
    assert.ok(/any phrasing/i.test(prompt) && /any verb/i.test(prompt), 'prompt must generalize beyond a fixed verb list');
    assert.ok(/any capitalization/i.test(prompt), 'prompt must cover a lowercase name, not just Title-Case');
  });

  await check('rubric: indirect demo/access requests are covered, not just the literal word "demo"', () => {
    const prompt = CLASSIFY_PROMPT('x', 'y');
    assert.ok(/walked through|any phrasing/i.test(prompt));
  });

  await check('rubric: eligible=true requires confidence="high" explicitly stated', () => {
    const prompt = CLASSIFY_PROMPT('x', 'y');
    assert.ok(/ONLY with confidence="high"/i.test(prompt));
  });

  await check('rubric: default posture is to escalate, stated explicitly', () => {
    const prompt = CLASSIFY_PROMPT('x', 'y');
    assert.ok(/Default to ESCALATE/i.test(prompt));
  });

  await check(`model choice is the pinned small/fast model (${CLASSIFY_MODEL})`, () => {
    assert.strictEqual(CLASSIFY_MODEL, 'claude-haiku-4-5');
  });

  // ─── 5. Quinn's reported misses, all three QA rounds — harness-level   ────
  // regression via a stubbed "what a correctly-instructed model should say"
  // verdict. See the file header: this proves the harness relays the
  // verdict correctly, NOT that the live model will produce it — that's
  // scripts/classify-sanity-check.js's job against the real API.

  const REPORTED_MISS_FIXTURES = [
    // Round 1 (e4201198)
    ['pricing, indirect ("worth the money")', 'Is it worth the money though?', 'yeah honestly it has paid for itself', 'pricing'],
    ['pricing, indirect, harder ("pay for itself")', 'Would this pay for itself for someone only doing 3 deals a month?', 'for sure, especially at that volume', 'pricing'],
    ['demo request, indirect ("walk me through... back end")', 'Could you walk me through what it actually looks like on the back end?', 'sure, happy to show you sometime', 'demo_request'],
    ['demo request, indirect, harder ("behind the scenes")', 'What happens behind the scenes when a contract comes in?', 'happy to walk through it sometime', 'demo_request'],
    ['backhanded thanks carrying doubt', 'Thanks, I guess, not sure it actually works though', 'fair enough, it works for me', 'low_confidence'],
    ['legal/compliance, indirect (earnest money forfeiture)', 'If a buyer backs out after the option period ends, is the earnest money automatically forfeited?', 'depends on the contract terms honestly', 'legal_compliance'],
    ['legal/compliance, indirect, harder (pronoun instead of "forfeited")', 'Can the buyer just walk away and keep their earnest money too?', 'not usually, no', 'legal_compliance'],
    ['named third party via possessive ("Sarah\'s closing")', "How did you handle it for Sarah's closing?", 'we just extended the option period a few days', 'specific_client'],
    // Round 2 (c57c6c69 / 97210f17)
    ['named third party, unlisted-verb shape ("sharing this with Miguel")', "Sharing this with Miguel since he's been asking about exactly this for his group.", 'happy to chat with him too', 'specific_client'],
    ['named third party, name-before-verb ("my buddy Ray asked")', 'my buddy Ray asked about this too the other day', 'small world, happens a lot', 'specific_client'],
    // Round 3 (this pass) — Quinn's 4 newest misses, 3 with exact text given
    ['named third party, unlisted verb + first person plural ("Miguel and I were just talking")', 'Miguel and I were just talking about TC stuff the other day, small world.', 'yeah it comes up more than you would think', 'specific_client'],
    ['named third party, LOWERCASE name + unlisted verb ("dana loved the checklist feature")', 'dana loved the checklist feature when I showed her', 'glad it landed well', 'specific_client'],
    ['pricing by comparison, no $ and no listed keyword ("way cheaper than what I pay now")', 'honestly this looks way cheaper than what I pay now', 'depends on your current setup', 'pricing'],
    // Round 3, 4th miss: Cole's message reported "a live miss on a real row
    // in production data" but did not include the row's text. NOT
    // fabricated here — flagged instead so Quinn/Cole can supply the exact
    // text for a real fixture rather than this suite inventing one.
  ];

  for (const [label, comment, draft, expectCategory] of REPORTED_MISS_FIXTURES) {
    await check(`Quinn miss (${label}): harness escalates given a correctly-instructed verdict`, async () => {
      const r = await classifyCommentRisk(comment, draft, {
        classify: stubVerdict({ eligible: false, category: expectCategory, confidence: 'high', reason: `stubbed: ${label}` }),
      });
      assert.strictEqual(r.eligible, false);
      assert.strictEqual(r.category, expectCategory);
    });
  }

  console.log('\n  NOTE: the 4th reported miss (a real production row) has no fixture here —');
  console.log('  Cole\'s report did not include the row\'s text, and this suite does not');
  console.log('  fabricate production data. Ask Quinn/Cole for the exact row content to');
  console.log('  add it as a permanent fixture.');

  // ─── 6. Auto-eligible archetypes, still covered end to end ─────────────

  const ELIGIBLE_FIXTURES = [
    ['a clean thanks', 'Thanks, that helps a lot!', 'anytime'],
    ['a clean agreement', '100% agree with this', 'yeah, same here'],
    ['a neutral peer question about general practice', 'did you have to switch title companies too?', 'no, kept the same one the whole time'],
    ['a plain factual TC/transaction answer', 'what tripped mine up was the option period deadline', 'yeah that one gets people every time'],
  ];
  for (const [label, comment, draft] of ELIGIBLE_FIXTURES) {
    await check(`eligible archetype (${label}) passes through end to end given a high-confidence model verdict`, async () => {
      const r = await classifyCommentRisk(comment, draft, {
        classify: stubVerdict({ eligible: true, category: 'auto_eligible', confidence: 'high', reason: `stubbed: ${label}` }),
      });
      assert.strictEqual(r.eligible, true);
      assert.strictEqual(r.category, 'auto_eligible');
    });
  }

  // ─── Real fixture: the exact row scripts/regression-tc-reply-approval.js
  // treats as a real harvested tc_discovery_responses comment ─────────────

  await check('real fixture ("TC went dark for 9 days mid-option") passes through given a high-confidence eligible verdict', async () => {
    const realComment = 'Communication. My last TC went dark for 9 days mid-option.';
    const cleanDraft = 'yeah, mine went dark on me too once mid-option. built in a backup contact after that.';
    const r = await classifyCommentRisk(realComment, cleanDraft, {
      classify: stubVerdict({ eligible: true, category: 'auto_eligible', confidence: 'high', reason: 'clean shared-experience reply' }),
    });
    assert.strictEqual(r.eligible, true, `expected eligible, got category=${r.category} reason=${r.reason}`);
    const gates = checkContentGates(cleanDraft);
    assert.strictEqual(gates.pass, true, `expected gates to pass, got failures=${JSON.stringify(gates.failures)}`);
  });

  await check('real fixture with an UNVERIFIED anecdote fails the war-story gate regardless of classifier verdict', async () => {
    const fabricatedDraft = 'ha, reminds me of a client of mine who waived the option period and hit a foundation issue in the hill country.';
    // Content gates are independent of the classifier and untouched by this
    // rewrite — still checked directly.
    const gates = checkContentGates(fabricatedDraft);
    assert.strictEqual(gates.pass, false);
    assert.ok(gates.failures.some((f) => f.code === 'unverified_war_story'));
  });

  // ─── Content gates, one failure per gate (unchanged by this rewrite) ──────

  await check('gate: pricing figure in the draft fails', () => {
    const g = checkContentGates('it runs $7.50/mo on the founding rate');
    assert.strictEqual(g.pass, false);
    assert.ok(g.failures.some((f) => f.code === 'pricing_figure'));
  });

  await check('gate: unverified capability claim fails', () => {
    const g = checkContentGates('yeah she pulls comps straight from MLS for you');
    assert.strictEqual(g.pass, false);
    assert.ok(g.failures.some((f) => f.code === 'unverified_capability_claim'));
  });

  await check('gate: AI-tell opener fails (reuses heath-voice-guard)', () => {
    const g = checkContentGates('Haha love that, such a great point!');
    assert.strictEqual(g.pass, false);
    assert.ok(g.failures.some((f) => f.code === 'voice_violation'));
  });

  await check('gate: too-long draft fails length', () => {
    const g = checkContentGates('this is a very long draft. '.repeat(20));
    assert.strictEqual(g.pass, false);
    assert.ok(g.failures.some((f) => f.code === 'length_out_of_range'));
  });

  await check('gate: a short, clean, on-voice draft passes every gate', () => {
    const g = checkContentGates('yeah, same. built in a backup contact after that.');
    assert.strictEqual(g.pass, true, JSON.stringify(g.failures));
  });

  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
  if (!process.exitCode) console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
