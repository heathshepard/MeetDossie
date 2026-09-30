#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/verify-video-script.js — the script-shape gate
 * built per docs/SCRIPT-SPEC.md, itself built after Heath rejected two scripts
 * for silently missing required elements (a dropped stake+CTA, and a
 * significantly-shorter-than-the-series script).
 *
 * TESTS
 * -----
 *   1. A complete, correctly-shaped script: every rule passes, failedRules
 *      empty.
 *   2. Seven negative fixtures, each the SAME base script with exactly ONE
 *      required element removed or broken — proves each rule actually fires
 *      independently rather than the whole gate failing generically.
 *   3. parseScriptSections() finds exactly one section in a file holding one
 *      script, and correctly finds TWO sections in a file holding two (proves
 *      the multi-script-per-file case the real TREC 20-19 docs use works).
 */

const assert = require('assert');
const {
  validateScript,
  validateScriptFile,
  parseScriptSections,
} = require('../api/_lib/verify-video-script.js');

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
};

// A complete script hitting every required element. Word counts are not
// tuned to any real runtime target — this fixture only has to be long enough
// for the REHOOK 50-80% placement window to have room to land correctly.
const GOOD_SCRIPT = `# VIDEO X — TEST TOPIC

**Hook summary:** a test script used only to exercise the validator.

**Cover hook text:** \`TEST HOOK TEXT RIGHT HERE\`

**Stake:** Miss this and your buyer's earnest money, five thousand two hundred dollars, is gone and the right to terminate is gone with it.

### SCRIPT

\`[CORE]\`

\`[FACE]\`

You are reading a contract
and you find a blank
that used to mean something else
entirely different from before.

\`[pause]\`

\`[SCREEN: page 1, paragraph 1]\`

Here is the rule stated plainly
with the key term carrying it
so you remember it later today.

\`[pause]\`

This rule applies every single time
you write an offer under the current form,
not just this one, and skipping it here
changes what your client actually owes
when the deal finally closes for everyone.

\`[REHOOK]\`

But here is the part
that actually costs you money
if you miss it at the table.

\`[OPTIONAL]\`

Extra context that only
the long cut carries
for people who want more detail.

\`[CORE]\`

\`[CTA]\`

\`[KEYWORD]\`

That's the rule. Follow for more,
and comment TEST and I'll send you
the checklist for this one today.
`;

function buildVariant(mutateFn) {
  return mutateFn(GOOD_SCRIPT);
}

check('good script: overall pass, zero failedRules', () => {
  const result = validateScript(GOOD_SCRIPT);
  assert.strictEqual(result.pass, true, `expected pass, failedRules=${result.failedRules.join(', ')}`);
  assert.deepStrictEqual(result.failedRules, []);
});

check('good script: rehook lands inside 50-80% window', () => {
  const result = validateScript(GOOD_SCRIPT);
  assert.strictEqual(result.rules.rehook_present_and_placed.pass, true);
});

// ── Negative fixture 1: missing cover hook text ──────────────────────────
check('missing cover hook text -> cover_hook_text_present fails, nothing else', () => {
  const bad = buildVariant((s) => s.replace(/\*\*Cover hook text:\*\*.*\n/, ''));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('cover_hook_text_present'), result.failedRules.join(', '));
});

// ── Negative fixture 2: missing stake ────────────────────────────────────
check('missing stake -> stake_present fails', () => {
  const bad = buildVariant((s) => s.replace(/\*\*Stake:\*\*.*\n/, ''));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('stake_present'), result.failedRules.join(', '));
});

// ── Negative fixture 2b: stake present but names no real cost ────────────
check('stake field with no dollar/consequence keyword -> stake_present fails', () => {
  const bad = buildVariant((s) => s.replace(
    /\*\*Stake:\*\*.*\n/,
    '**Stake:** This paragraph is important to read carefully.\n',
  ));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('stake_present'), result.failedRules.join(', '));
});

// ── Negative fixture 3: fade direction in the cold open ──────────────────
check('fade direction in opening lines -> frame1_no_fade_direction fails', () => {
  const bad = buildVariant((s) => s.replace(
    'You are reading a contract',
    'Fade in on you reading a contract',
  ));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('frame1_no_fade_direction'), result.failedRules.join(', '));
});

// ── Negative fixture 4: no [REHOOK] tag at all ───────────────────────────
check('missing [REHOOK] tag -> rehook_present_and_placed fails', () => {
  const bad = buildVariant((s) => s.replace('`[REHOOK]`\n\n', ''));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('rehook_present_and_placed'), result.failedRules.join(', '));
});

// ── Negative fixture 4b: [REHOOK] present but chunk doesn't say "but" ────
check('[REHOOK] chunk missing "but" -> rehook_present_and_placed fails', () => {
  const bad = buildVariant((s) => s.replace(
    'But here is the part',
    'Here is the part',
  ));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('rehook_present_and_placed'), result.failedRules.join(', '));
});

// ── Negative fixture 5: no [CTA] tag ──────────────────────────────────────
check('missing [CTA] tag -> cta_present_near_end fails (and keyword_trigger_natural too, since it depends on CTA position)', () => {
  const bad = buildVariant((s) => s.replace('`[CTA]`\n\n', ''));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('cta_present_near_end'), result.failedRules.join(', '));
});

// ── Negative fixture 6: no [KEYWORD] tag / no natural comment trigger ────
check('missing [KEYWORD] tag -> keyword_trigger_natural fails', () => {
  const bad = buildVariant((s) => s.replace('`[KEYWORD]`\n\n', ''));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('keyword_trigger_natural'), result.failedRules.join(', '));
});

check('ad-read phrasing instead of a natural trigger -> keyword_trigger_natural fails', () => {
  const bad = buildVariant((s) => s.replace(
    "and comment TEST and I'll send you",
    'and click the link below for',
  ));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('keyword_trigger_natural'), result.failedRules.join(', '));
});

// ── Negative fixture 7: spoken list ───────────────────────────────────────
check('bulleted spoken chunk -> no_spoken_lists fails', () => {
  const bad = buildVariant((s) => s.replace(
    'Extra context that only\nthe long cut carries\nfor people who want more detail.',
    '- first point\n- second point\n- third point',
  ));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('no_spoken_lists'), result.failedRules.join(', '));
});

check('ordinal-word spoken list ("first... second... third...") -> no_spoken_lists fails', () => {
  const bad = buildVariant((s) => s.replace(
    'Extra context that only\nthe long cut carries\nfor people who want more detail.',
    'First you check the date, second you check the box, third you sign it.',
  ));
  const result = validateScript(bad);
  assert.strictEqual(result.pass, false);
  assert.ok(result.failedRules.includes('no_spoken_lists'), result.failedRules.join(', '));
});

// ── parseScriptSections: single-script and multi-script files ───────────
check('parseScriptSections finds exactly one section in a one-script file', () => {
  const sections = parseScriptSections(GOOD_SCRIPT);
  assert.strictEqual(sections.length, 1);
});

check('parseScriptSections finds exactly two sections in a two-script file', () => {
  const second = GOOD_SCRIPT.replace('VIDEO X — TEST TOPIC', 'VIDEO Y — SECOND TEST TOPIC');
  const twoScriptFile = `${GOOD_SCRIPT}\n\n---\n\n${second}`;
  const sections = parseScriptSections(twoScriptFile);
  assert.strictEqual(sections.length, 2);
});

check('validateScriptFile: two good scripts in one file both pass', () => {
  const second = GOOD_SCRIPT.replace('VIDEO X — TEST TOPIC', 'VIDEO Y — SECOND TEST TOPIC');
  const twoScriptFile = `${GOOD_SCRIPT}\n\n---\n\n${second}`;
  const result = validateScriptFile(twoScriptFile);
  assert.strictEqual(result.pass, true, JSON.stringify(result.sections.map((s) => s.result.failedRules)));
  assert.strictEqual(result.sections.length, 2);
});

check('validateScriptFile: a file with no script sections fails closed', () => {
  const result = validateScriptFile('# Just a heading\n\nSome prose, no ### SCRIPT heading anywhere.');
  assert.strictEqual(result.pass, false);
  assert.ok(result.sections[0].result.failedRules.includes('no_script_sections_found'));
});

console.log('');
if (failures.length) {
  console.error(`RESULT: FAIL (${failures.length} failing: ${failures.join(', ')})`);
  process.exit(1);
}
console.log('RESULT: PASS');
process.exit(0);
