#!/usr/bin/env node
'use strict';

/**
 * Regression test for the closing-clause/dropped-lines-disclosure rules
 * added to api/_lib/verify-video-script.js 2026-10-01 — see
 * founder-video-production-standard.md §5: "The agent cut Heath's closing
 * benefit clause for runtime and left it off its own drop list... Heath
 * caught it as 'the last sentence gets cut off.'"
 *
 * TESTS
 * -----
 *   1-3. SYNTHETIC (self-contained, always runs): a minimal script section
 *        whose delivered transcript (a) fully matches -> both rules pass,
 *        (b) is truncated before the final clause with no disclosure ->
 *        both rules fail, (c) is truncated WITH a `**Dropped lines:**`
 *        field -> dropped_lines_disclosed passes (closing_clause_delivered
 *        still correctly fails — disclosure doesn't un-cut the clause).
 *   4. REAL fixtures (v7c_script.md / v7c_SPLICED.transcript.json, Heath's
 *      local workstation, not checked into git): the approved build's real
 *      script-of-record against its own real delivered transcript passes
 *      both rules at ~100% recall/coverage. A synthetic truncation of that
 *      SAME real transcript (simulating the actual incident) fails both.
 *      Skips with a clear message if the fixtures aren't present.
 */
const fs = require('fs');
const {
  validateScriptFile,
} = require('../api/_lib/verify-video-script.js');

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

const MIN_SCRIPT = `# TEST SCRIPT

**Cover hook text:** \`A TEST HOOK\`

**Stake:** You could lose the file. $5,000 on the line.

### SCRIPT

\`[HOOK]\`

This is the opening hook line that sets up the story for everyone watching.

\`[REHOOK]\`

But here is the pivot that re-hooks the viewer halfway through the video.

\`[CTA]\`

\`[KEYWORD]\`

Comment DEADLINE and I will send you the full paragraph reference for this rule.
`;

function wordsFrom(text) {
  return text.split(/\s+/).filter(Boolean).map((t) => ({ text: t, type: 'word' }));
}

function test123Synthetic() {
  console.log('\n=== Tests 1-3: synthetic script + synthetic delivered transcript ===');
  const fullDelivered = wordsFrom(
    'This is the opening hook line that sets up the story for everyone watching. '
    + 'But here is the pivot that re-hooks the viewer halfway through the video. '
    + 'Comment deadline and I will send you the full paragraph reference for this rule.',
  );
  const r1 = validateScriptFile(MIN_SCRIPT, { deliveredWords: fullDelivered });
  check('1. full delivered transcript: closing_clause_delivered passes', r1.sections[0].result.rules.closing_clause_delivered.pass);
  check('1. full delivered transcript: dropped_lines_disclosed passes', r1.sections[0].result.rules.dropped_lines_disclosed.pass);

  // Drop the final [KEYWORD] sentence entirely, no disclosure.
  const truncatedDelivered = wordsFrom(
    'This is the opening hook line that sets up the story for everyone watching. '
    + 'But here is the pivot that re-hooks the viewer halfway through the video.',
  );
  const r2 = validateScriptFile(MIN_SCRIPT, { deliveredWords: truncatedDelivered });
  check('2. truncated, no disclosure: closing_clause_delivered FAILS', r2.sections[0].result.rules.closing_clause_delivered.pass === false);
  check('2. truncated, no disclosure: dropped_lines_disclosed FAILS', r2.sections[0].result.rules.dropped_lines_disclosed.pass === false);

  const scriptWithDisclosure = MIN_SCRIPT.replace(
    '### SCRIPT',
    '**Dropped lines:** Cut the keyword sentence for runtime.\n\n### SCRIPT',
  );
  const r3 = validateScriptFile(scriptWithDisclosure, { deliveredWords: truncatedDelivered });
  check('3. truncated WITH disclosure: dropped_lines_disclosed passes', r3.sections[0].result.rules.dropped_lines_disclosed.pass === true);
  check('3. truncated WITH disclosure: closing_clause_delivered still FAILS (disclosure does not un-cut it)', r3.sections[0].result.rules.closing_clause_delivered.pass === false);
}

function test4RealFixtures() {
  console.log('\n=== Test 4: real fixtures (v7c_script.md / v7c_SPLICED.transcript.json) ===');
  const scriptPath = '/home/heath/mw/v7/v7c_script.md';
  const transcriptPath = '/home/heath/mw/v7/v7c_SPLICED.transcript.json';
  if (!fs.existsSync(scriptPath) || !fs.existsSync(transcriptPath)) {
    console.log(`  SKIP  real fixtures not present on this machine (${scriptPath})`);
    return;
  }
  const scriptText = fs.readFileSync(scriptPath, 'utf8');
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));

  const full = validateScriptFile(scriptText, { deliveredWords: transcript.words });
  const fullRules = full.sections[0].result.rules;
  check('real v7c: closing_clause_delivered passes', fullRules.closing_clause_delivered.pass, fullRules.closing_clause_delivered.note);
  check('real v7c: dropped_lines_disclosed passes', fullRules.dropped_lines_disclosed.pass, fullRules.dropped_lines_disclosed.note);

  // Simulate the actual incident: truncate the REAL transcript before its
  // final clause, no disclosure added.
  const truncatedWords = transcript.words.slice(0, transcript.words.length - 45);
  const truncated = validateScriptFile(scriptText, { deliveredWords: truncatedWords });
  const truncRules = truncated.sections[0].result.rules;
  check('real v7c truncated (simulated drop): closing_clause_delivered FAILS', truncRules.closing_clause_delivered.pass === false);
  check('real v7c truncated (simulated drop): dropped_lines_disclosed FAILS', truncRules.dropped_lines_disclosed.pass === false);
}

test123Synthetic();
test4RealFixtures();

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
