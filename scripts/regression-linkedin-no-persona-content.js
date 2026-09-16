#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-16 CONTENT-FORMAT-LIBRARY.md finding
 * (LinkedIn's March 2026 Authenticity Update penalizes templated AI-persona
 * content 30-55%): api/cron-generate-posts.js must never plan a
 * PERSONA_STORY (Brenda/Patricia/Victor) slot for LinkedIn — or any platform
 * — and LinkedIn's real slot must stay a brand-voice format with a link
 * allowed in the post body (no first-comment routing exists in this
 * pipeline to begin with).
 *
 * CONTEXT: POST_PLAN_BASE stopped generating PERSONA_STORY slots on
 * 2026-06-14 (commit 25aa1b02), and BRAND_VOICE_FORMATS_ENFORCED overrides
 * any PERSONA_STORY the model hallucinates back at insert time (2026-09-09
 * Bug 2 fix). This test pins the PLANNING side (getPostPlan()) so a future
 * edit can't silently reintroduce a persona slot for LinkedIn without
 * failing a test — the insert-time override is a second, independent net,
 * not a substitute for this one.
 *
 * Pure function test — no network, no DB, no Anthropic call.
 *
 * Run manually:
 *   node scripts/regression-linkedin-no-persona-content.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { getPostPlan } = require(path.join(REPO, 'api/cron-generate-posts.js'));

const BRAND_VOICE_FORMATS = ['CAPABILITY_ONELINER', 'TREC_EDUCATION', 'FOUNDER_STORY'];

(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  // A representative date + full active platform set (matches production —
  // see POST_PLAN_BASE's own platform list).
  const plan = getPostPlan(new Date('2026-09-16T11:00:00Z'), {
    activePlatforms: ['facebook', 'twitter', 'linkedin'],
  });

  console.log(`getPostPlan() returned ${plan.length} slot(s): ${plan.map((s) => `${s.platform}/${s.format}`).join(', ')}`);

  check('at least one linkedin slot exists (LinkedIn is not left empty)', () => {
    const linkedinSlots = plan.filter((s) => s.platform === 'linkedin');
    assert.ok(linkedinSlots.length >= 1, `expected >=1 linkedin slot, got ${linkedinSlots.length}`);
  });

  check('no slot anywhere in the plan uses format PERSONA_STORY', () => {
    const offenders = plan.filter((s) => String(s.format || '').toUpperCase() === 'PERSONA_STORY');
    assert.strictEqual(offenders.length, 0, `PERSONA_STORY slot(s) found: ${JSON.stringify(offenders)}`);
  });

  check('no slot anywhere in the plan carries a persona (brenda/patricia/victor)', () => {
    const offenders = plan.filter((s) => s.persona && s.persona !== null);
    assert.strictEqual(offenders.length, 0, `slot(s) with a persona set: ${JSON.stringify(offenders)}`);
  });

  check('every linkedin slot uses an enforced brand-voice format (real feature/news, not persona filler)', () => {
    const linkedinSlots = plan.filter((s) => s.platform === 'linkedin');
    for (const slot of linkedinSlots) {
      assert.ok(
        BRAND_VOICE_FORMATS.includes(slot.format),
        `linkedin slot format "${slot.format}" is not in ${JSON.stringify(BRAND_VOICE_FORMATS)}`,
      );
      assert.strictEqual(slot.persona, null, `linkedin slot persona should be null, got ${JSON.stringify(slot.persona)}`);
    }
  });

  check('linkedin is absent when not in activePlatforms (no accidental always-on slot)', () => {
    const planWithoutLinkedin = getPostPlan(new Date('2026-09-16T11:00:00Z'), {
      activePlatforms: ['facebook', 'twitter'],
    });
    const linkedinSlots = planWithoutLinkedin.filter((s) => s.platform === 'linkedin');
    assert.strictEqual(linkedinSlots.length, 0, `expected 0 linkedin slots when inactive, got ${linkedinSlots.length}`);
  });

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
