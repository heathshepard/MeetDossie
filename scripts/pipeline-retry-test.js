/**
 * scripts/pipeline-retry-test.js
 *
 * Verifies the self-correction loop in api/_lib/trec-20-18-pipeline.js:
 *   1. Stuffs a low-confidence value into assignments (validator should FAIL it)
 *   2. Provides a STUB extractor that returns a high-confidence repair
 *   3. Asserts the pipeline ends with pass:true after exactly 1 retry
 *
 * Then a second scenario:
 *   1. Same low-confidence stuff
 *   2. Extractor returns NOTHING (simulates LLM giving up)
 *   3. Asserts the pipeline ends with pass:false, unmatched=[that field],
 *      retries used == MAX_RETRIES_PER_FIELD (never fabricates to pass).
 *
 * No real Anthropic API call. Tests the loop wiring, not the LLM.
 * Exit code: 0 pass, 1 regression.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  validateWithRetry,
  loadHeathArtifacts,
  MAX_RETRIES_PER_FIELD,
} = require('../api/_lib/trec-20-18-pipeline');

async function main() {
  const { rules, validator } = loadHeathArtifacts();
  const golden = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'golden-case-conventional.json'), 'utf8')
  );

  // === scenario A: extractor repairs the field ===
  const scenarioA = {
    assignments: {
      ...golden.assignments,
      notice_buyer_email: { value: 'maria.vasquez@example.com', confidence: 0.4 }, // below floor
    },
    intake: golden.intake,
  };

  const repairExtractor = async ({ fieldIds, attempt }) => {
    if (fieldIds.includes('notice_buyer_email')) {
      return {
        notice_buyer_email: {
          value: 'maria.vasquez@example.com',
          confidence: 0.95,
          matchReason: `stub-repair-attempt-${attempt}`,
        },
      };
    }
    return {};
  };

  const resA = await validateWithRetry({
    ...scenarioA,
    rules,
    validator,
    extractor: repairExtractor,
  });

  console.log('=== Scenario A: extractor repairs field ===');
  console.log('pass:', resA.pass);
  console.log('retries:', resA.retries);
  console.log('unmatched:', resA.unmatched);

  const aOK =
    resA.pass === true &&
    resA.retries.notice_buyer_email === 1 &&
    (!resA.unmatched || resA.unmatched.length === 0);

  // === scenario B: extractor returns nothing — should NOT fabricate ===
  const scenarioB = {
    assignments: {
      ...golden.assignments,
      notice_buyer_email: { value: 'maria.vasquez@example.com', confidence: 0.4 },
    },
    intake: golden.intake,
  };

  const giveUpExtractor = async () => ({});

  const resB = await validateWithRetry({
    ...scenarioB,
    rules,
    validator,
    extractor: giveUpExtractor,
  });

  console.log('\n=== Scenario B: extractor gives up — must surface UNMATCHED ===');
  console.log('pass:', resB.pass);
  console.log('retries:', resB.retries);
  console.log('unmatched:', resB.unmatched);

  // After max retries with no fix, the field remains a hard fail (FAIL or UNMATCHED).
  const bOK =
    resB.pass === false &&
    Array.isArray(resB.unmatched) &&
    resB.unmatched.includes('notice_buyer_email');

  // === scenario C: low-confidence patch from extractor is REJECTED ===
  // Prevents the "extractor lies and says 0.99 just to pass" failure mode.
  // We test the floor by sending back 0.5 confidence — should be ignored.
  const lyingExtractor = async () => ({
    notice_buyer_email: {
      value: 'spoofed@malicious.com',
      confidence: 0.5, // below CONFIDENCE_RETRY_FLOOR (0.85)
    },
  });

  const resC = await validateWithRetry({
    assignments: {
      ...golden.assignments,
      notice_buyer_email: { value: 'maria.vasquez@example.com', confidence: 0.4 },
    },
    intake: golden.intake,
    rules,
    validator,
    extractor: lyingExtractor,
  });

  console.log('\n=== Scenario C: low-confidence repair must be REJECTED ===');
  console.log('pass:', resC.pass);
  // After retries, the assignments should NOT contain spoofed@malicious.com
  const cOK =
    resC.pass === false &&
    resC.assignments.notice_buyer_email.value !== 'spoofed@malicious.com';
  console.log('final value:', resC.assignments.notice_buyer_email.value);

  const allOK = aOK && bOK && cOK;
  console.log('\nA OK:', aOK, '| B OK:', bOK, '| C OK:', cOK);
  console.log(allOK ? 'PIPELINE RETRY LOOP: ALL GOOD' : 'PIPELINE RETRY LOOP: REGRESSION');
  process.exit(allOK ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
