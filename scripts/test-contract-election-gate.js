#!/usr/bin/env node
// scripts/test-contract-election-gate.js
// =============================================================================
// Tests for the contract election gate — the "check one box only" gate.
//
// Run: node scripts/test-contract-election-gate.js
//
// DEMO/SYNTHETIC DATA ONLY. Nothing here touches Supabase, DocuSeal, a real
// transaction, or a real signer. No PDF is sent and no document is created.
//
// The cases that matter, in the words of the failures that caused them:
//   - blank must FAIL          (29046 Pfeiffers Gate, paragraph 7D, 2026-09-09)
//   - exactly one must PASS
//   - two selected must FAIL
//   - the string 'true' must FAIL, because it renders as an empty box
//   - an election the form permits to be inapplicable must NOT block
//   - an unreachable control must be REPORTED, never silently passed
// =============================================================================

'use strict';

const assert = require('assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'api', '_lib');
const {
  evaluateElections,
  blockingMessage,
  formCodeForFormType,
} = require(path.join(LIB, 'contract-election-gate'));
const {
  validate,
  canonicalKey,
  parseMutexMembers,
  requiredElectionKeys,
} = require(path.join(LIB, 'trec-validator'));
const RULES_20_18 = require(path.join(LIB, 'trec-20-18-field-rules.json'));

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, message: e && e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e && e.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// A synthetic 20-19 field-value set with everything EXCEPT the elections.
// Values are obviously fake on purpose.
function baseFv(overrides) {
  return Object.assign({
    buyer_name: 'DEMO BUYER',
    seller_name: 'DEMO SELLER',
    property_address: '000 Demo Street',
    sale_price: '100000',
    earnest_money: '1000',
    option_fee: '100',
    option_days: '7',
    closing_date: '2026-12-31',
  }, overrides || {});
}

function blockingIds(result) {
  return result.blocking.map((b) => b.id).sort();
}

// =============================================================================
section('1. Paragraph 7D — the Pfeiffers failure mode');
// =============================================================================

test('BLANK 7D fails — neither As-Is box selected', () => {
  const r = evaluateElections({ formCode: '20-19', fieldValues: baseFv() });
  assert.strictEqual(r.pass, false, 'expected the gate to block on a blank 7D');
  assert.ok(
    blockingIds(r).includes('acceptance_of_property_condition'),
    `expected 7D in blocking, got ${JSON.stringify(blockingIds(r))}`
  );
  const msg = r.blocking.find((b) => b.id === 'acceptance_of_property_condition').message;
  assert.ok(/¶7D/.test(msg), 'blocking message must name the paragraph');
  assert.ok(/no box is selected/i.test(msg), 'blocking message must say what is wrong');
});

test('EXACTLY ONE passes — 7D(1) As Is selected', () => {
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({ accepts_as_is: true }),
  });
  assert.strictEqual(r.pass, true, `expected pass, blocked on ${JSON.stringify(blockingIds(r))}`);
  assert.ok(r.ok.some((s) => /¶7D/.test(s)), '7D should be listed as satisfied');
});

test('EXACTLY ONE passes — 7D(2) As Is with repairs, repairs listed', () => {
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({
      accepts_as_is_with_repairs: true,
      required_repairs: 'Replace the water heater.',
    }),
  });
  assert.strictEqual(r.pass, true, `expected pass, blocked on ${JSON.stringify(blockingIds(r))}`);
});

test('TWO selected fails — both 7D boxes', () => {
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({
      accepts_as_is: true,
      accepts_as_is_with_repairs: true,
      required_repairs: 'Replace the water heater.',
    }),
  });
  assert.strictEqual(r.pass, false, 'two boxes on a one-box election must fail');
  const b = r.blocking.find((x) => x.id === 'acceptance_of_property_condition');
  assert.ok(b, 'expected 7D to be the blocking election');
  assert.strictEqual(b.problem, 'multiple_selected');
});

test('7D(2) checked with NO repairs listed fails — the empty-obligation defect', () => {
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({ accepts_as_is_with_repairs: true }),
  });
  assert.strictEqual(r.pass, false, 'a repair box with no repairs must block');
  const dep = r.blocking.find((b) => b.problem === 'dependent_missing');
  assert.ok(dep, `expected a dependent_missing block, got ${JSON.stringify(r.blocking.map((b) => b.problem))}`);
  assert.ok(/required_repairs/.test(dep.fields.join(',')), 'must name the empty field');
});

test('repairs typed in the EDITOR field do not block — the member already did their part', () => {
  // specific_repairs_line1 is a real member field (transactions.repairs_summary)
  // and nothing copies it into required_repairs. Blocking here would be a trap:
  // the member has written the repairs and has no way to satisfy the rule.
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({
      accepts_as_is_with_repairs: true,
      specific_repairs_line1: 'Replace the water heater.',
    }),
  });
  assert.strictEqual(r.pass, true, 'a member who typed repairs must NOT be blocked');
});

test('...but the dropped repair text is raised as a loud warning', () => {
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({
      accepts_as_is_with_repairs: true,
      specific_repairs_line1: 'Replace the water heater.',
    }),
  });
  const w = r.warnings.find((x) => x.problem === 'value_not_rendered');
  assert.ok(w, 'the render gap must be reported, never silent');
  assert.ok(/will\s+NOT appear/.test(w.message), 'must say the text will not appear');
});

test('the string "true" does NOT satisfy 7D — it renders as an empty box', () => {
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({ accepts_as_is: 'true' }),
  });
  assert.strictEqual(r.pass, false, 'string "true" must not satisfy an election');
  const b = r.blocking.find((x) => x.id === 'acceptance_of_property_condition');
  assert.ok(/renders as an empty box/i.test(b.message),
    'the message must explain the string-boolean cause, got: ' + b.message);
});

// =============================================================================
section('2. Blocking is narrow — inapplicable and unreachable never block');
// =============================================================================

test('a fully blank contract blocks on 7D ONLY, not on every election', () => {
  const r = evaluateElections({ formCode: '20-19', fieldValues: baseFv() });
  const ids = [...new Set(blockingIds(r).map((id) => id.split(':')[0]))];
  assert.deepStrictEqual(ids, ['acceptance_of_property_condition'],
    `only 7D may block a blank contract, got ${JSON.stringify(ids)}`);
});

test('paragraph 7B blank is reported as a WARNING, not a block', () => {
  const r = evaluateElections({ formCode: '20-19', fieldValues: baseFv({ accepts_as_is: true }) });
  assert.strictEqual(r.pass, true, '7B must never block a send');
  const w = r.warnings.find((x) => x.id === 'sellers_disclosure_notice');
  assert.ok(w, 'expected a 7B warning');
  assert.ok(/¶7B/.test(w.message), 'warning must name the paragraph');
});

test('paragraph 7I is reported as UNREACHABLE and never blocks', () => {
  const r = evaluateElections({ formCode: '20-19', fieldValues: baseFv({ accepts_as_is: true }) });
  const u = r.unreachable.find((x) => x.paragraph === '7I');
  assert.ok(u, `expected 7I in unreachable, got ${JSON.stringify(r.unreachable.map((x) => x.paragraph))}`);
  assert.ok(!r.blocking.some((b) => b.paragraph === '7I'), '7I must never block');
});

test('paragraph 12B brokerage compensation is reported as unreachable', () => {
  const r = evaluateElections({ formCode: '20-19', fieldValues: baseFv({ accepts_as_is: true }) });
  assert.ok(r.unreachable.some((x) => x.paragraph === '12B'), 'expected 12B reported');
});

test('paragraph 4C is SKIPPED when 4C itself is not checked', () => {
  const r = evaluateElections({ formCode: '20-19', fieldValues: baseFv({ accepts_as_is: true }) });
  assert.ok(r.skipped.some((s) => s.id === 'natural_resource_lease_delivery'),
    'an inapplicable paragraph must be skipped, not warned about');
});

test('an unknown form is reported as NOT evaluated, never as a silent pass', () => {
  const r = evaluateElections({ formCode: '20-17', fieldValues: baseFv() });
  assert.strictEqual(r.evaluated, false, 'unknown form must report evaluated:false');
  assert.ok(/NOT checked/i.test(r.note), 'must say elections were not checked');
});

test('blockingMessage names the paragraph and reads like a human wrote it', () => {
  const r = evaluateElections({ formCode: '20-19', fieldValues: baseFv() });
  const msg = blockingMessage(r);
  assert.ok(/¶7D/.test(msg), 'must name the paragraph');
  assert.ok(/not sent/i.test(msg), 'must say the send did not happen');
  assert.ok(!/undefined|\[object/.test(msg), 'no formatting leaks');
});

// =============================================================================
section('3. trec-validator mutex repair (form 20-18)');
// =============================================================================

test('crossRef parsing recovers the named members', () => {
  assert.deepStrictEqual(parseMutexMembers('MUTEX(accept_as_is)'), ['accept_as_is']);
  assert.deepStrictEqual(
    parseMutexMembers('MUTEX(rep_intermediary,rep_subagent,rep_seller_only)'),
    ['rep_intermediary', 'rep_subagent', 'rep_seller_only']
  );
});

test('both halves of a pair canonicalise to the SAME group key', () => {
  const a = canonicalKey(['accept_as_is', ...parseMutexMembers('MUTEX(accept_as_is_with_repairs)')]);
  const b = canonicalKey(['accept_as_is_with_repairs', ...parseMutexMembers('MUTEX(accept_as_is)')]);
  assert.strictEqual(a, b, 'the pair must share one group key — this was defect #1');
});

test('18 singleton groups collapse into 8 real groups', () => {
  const keys = new Set();
  for (const f of RULES_20_18.fields) {
    if (!f.crossRef || !String(f.crossRef).startsWith('MUTEX')) continue;
    if (f.valueType !== 'checkbox') continue;
    keys.add(canonicalKey([f.fieldId, ...parseMutexMembers(f.crossRef)]));
  }
  assert.strictEqual(keys.size, 8, `expected 8 groups, got ${keys.size}`);
  assert.ok(keys.has('accept_as_is|accept_as_is_with_repairs'), 'As-Is pair must be one group');
});

test('the As-Is pair is the only group marked required on 20-18', () => {
  const req = [...requiredElectionKeys('20-18').keys()];
  assert.deepStrictEqual(req, ['accept_as_is|accept_as_is_with_repairs']);
});

// Minimal rule set exercising the validator end to end without the full 263.
function miniRules() {
  return {
    formCode: '20-18',
    fields: [
      { fieldId: 'accept_as_is', valueType: 'checkbox', fillPriority: 'optional', crossRef: 'MUTEX(accept_as_is_with_repairs)' },
      { fieldId: 'accept_as_is_with_repairs', valueType: 'checkbox', fillPriority: 'optional', crossRef: 'MUTEX(accept_as_is)' },
      { fieldId: 'hoa_is_subject', valueType: 'checkbox', fillPriority: 'optional', crossRef: 'MUTEX(hoa_is_not_subject)' },
      { fieldId: 'hoa_is_not_subject', valueType: 'checkbox', fillPriority: 'optional', crossRef: 'MUTEX(hoa_is_subject)' },
    ],
  };
}

test('validator: blank required election FAILS (zero selected)', () => {
  const r = validate(miniRules(), {}, {});
  assert.strictEqual(r.pass, false, 'blank 7D must fail — "at most one" was defect #2');
  assert.ok(
    r.report.some((x) => x.status === 'FAIL' && /no box selected/i.test(x.reason || '')),
    'expected a none_selected failure'
  );
});

test('validator: exactly one selected PASSES', () => {
  const r = validate(miniRules(), { accept_as_is: { value: true, confidence: 1 } }, {});
  assert.strictEqual(r.pass, true, `expected pass, report: ${JSON.stringify(r.report.filter((x) => x.status === 'FAIL'))}`);
});

test('validator: two selected FAILS', () => {
  const r = validate(miniRules(), {
    accept_as_is: { value: true, confidence: 1 },
    accept_as_is_with_repairs: { value: true, confidence: 1 },
  }, {});
  assert.strictEqual(r.pass, false, 'two boxes must fail');
  assert.ok(r.flags.includes('accept_as_is'), 'both members should be flagged');
});

test('validator: a NON-required blank group does not fail the document', () => {
  const r = validate(miniRules(), { accept_as_is: { value: true, confidence: 1 } }, {});
  assert.strictEqual(r.pass, true, 'blank HOA must not block on 20-18');
  const hoa = r.elections.find((e) => e.key === 'hoa_is_not_subject|hoa_is_subject');
  assert.strictEqual(hoa.status, 'BLANK', 'blank non-required group should be reported as BLANK');
});

test('validator: string "true" does not satisfy a required election', () => {
  const r = validate(miniRules(), { accept_as_is: { value: 'true', confidence: 1 } }, {});
  assert.strictEqual(r.pass, false, 'string "true" must not satisfy');
  assert.ok(
    r.report.some((x) => /does not render/i.test(x.reason || '')),
    'the reason must explain the string-boolean cause'
  );
});

// =============================================================================
section('4. Wiring — every send path actually calls the gate');
// =============================================================================

const fs = require('fs');
const API = path.join(__dirname, '..', 'api');

function sourceOf(f) {
  return fs.readFileSync(path.join(API, f), 'utf8');
}

for (const file of [
  'esign-create.js',
  'fill-form.js',
  'interactive-editor-download-pdf.js',
  'interactive-editor-validate.js',
]) {
  test(`${file} requires and calls the election gate`, () => {
    const src = sourceOf(file);
    assert.ok(/contract-election-gate/.test(src), `${file} does not require the gate`);
    assert.ok(/evaluateElections\s*\(/.test(src), `${file} never calls evaluateElections`);
  });
}

test('esign-create blocks the send (422) rather than only logging', () => {
  const src = sourceOf('esign-create.js');
  assert.ok(/blocked:\s*true/.test(src), 'esign-create must return a blocked response');
  assert.ok(
    /firstBlockingElectionReport\(singleElectionReports\)/.test(src),
    'the single-document path must be gated — it is the most common send'
  );
  assert.ok(
    /firstBlockingElectionReport\(packetElectionReports\)/.test(src),
    'the packet path must be gated'
  );
});

test('esign-create gates BEFORE the DocuSeal call, not after', () => {
  const src = sourceOf('esign-create.js');
  const gateAt = src.indexOf('firstBlockingElectionReport(packetElectionReports)');
  const sendAt = src.indexOf('await docusealCreateFromPacket({');
  assert.ok(gateAt > 0 && sendAt > 0, 'both markers must exist');
  assert.ok(gateAt < sendAt, 'the gate must run before the envelope is created');
});

test('the editor download path blocks persist but NOT a plain download', () => {
  const src = sourceOf('interactive-editor-download-pdf.js');
  assert.ok(
    /params\.persist === true && !electionReport\.pass/.test(src),
    'persist (the Send button) must be blocked on a failed election'
  );
  assert.ok(/X-Dossie-Elections/.test(src), 'a plain download must still report the verdict');
});

test('form_type mapping resolves the real stored document types', () => {
  assert.strictEqual(formCodeForFormType('resale-contract'), '20-19');
  assert.strictEqual(formCodeForFormType('resale_contract'), '20-19');
  assert.strictEqual(formCodeForFormType('hoa-addendum'), null, 'unmapped forms must return null');
});

// =============================================================================
section('5. Regression — would this have caught the real defects?');
// =============================================================================

test('PFEIFFERS GATE 2026-09-09: 7D blank on an otherwise complete contract', () => {
  // The contract as executed: everything filled, 7D untouched.
  const pfeiffers = baseFv({
    buyer_name: 'DEMO BUYER',
    seller_name: 'DEMO SELLER',
    property_address: '29046 DEMO GATE',
    sale_price: '575000',
    seller_disclosure_received: true,
    title_seller_expense: true,
    hoa_mandatory: false,
    survey_option: '1',
  });
  const r = evaluateElections({ formCode: '20-19', fieldValues: pfeiffers });
  assert.strictEqual(r.pass, false, 'THE regression: this contract must not be sendable');
  assert.ok(blockingIds(r).includes('acceptance_of_property_condition'));
});

test('7B blank is surfaced on that same contract rather than passing silently', () => {
  const r = evaluateElections({
    formCode: '20-19',
    fieldValues: baseFv({ accepts_as_is: true }),
  });
  const surfaced = r.warnings.some((w) => w.paragraph === '7B')
    || r.unreachable.some((u) => u.paragraph === '7B');
  assert.ok(surfaced, '7B must appear somewhere in the verdict, never be silently dropped');
});

test('a correctly-completed contract sends clean', () => {
  const good = baseFv({
    accepts_as_is: true,
    seller_disclosure_received: true,
    title_seller_expense: true,
    hoa_mandatory: false,
    survey_option: '1',
    shortages_in_area_amended: false,
  });
  const r = evaluateElections({ formCode: '20-19', fieldValues: good });
  assert.strictEqual(r.pass, true, `a complete contract must send: ${JSON.stringify(r.blocking)}`);
  assert.strictEqual(r.blocking.length, 0);
});

// =============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
}
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
