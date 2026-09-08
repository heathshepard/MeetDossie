#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-01 CARTER fix to Defect A2
 * (docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md §4, Fix 2):
 *
 * transactions.contract_field_drafts was WRITTEN by the Interactive Editor's
 * autosave (interactive-editor-update-field.js) and READ BACK by the editor
 * (interactive-editor-init.js) — but never by the fill pipeline. A member's
 * saved edits showed up in the editor and its preview, then silently
 * vanished from every PDF fill-form.js / dossiesign-prepare.js produced.
 * ~170 orphaned draft fields existed across 3 live transactions.
 *
 * Fix: api/_lib/merge-contract-field-drafts.js, called at the fill-form
 * choke point (txDefaults < drafts < caller field_values, translated via
 * trec-20-19-editor-field-translate exactly like the preview path) and in
 * dossiesign-prepare's per-form fill.
 *
 * Tests:
 *   1. FULL-PIPELINE FIXTURE (no network, all Supabase/storage stubbed):
 *      invoke the real fill-form handler with a fixture transaction whose
 *      contract_field_drafts['20-19'] holds editor-keyed drafts
 *      (survey_existing_days + broker_disclosure_line1), capture the PDF
 *      the handler uploads to storage, run pdftotext, and assert both
 *      sentinel values appear in the rendered document text.
 *   2. Precedence: caller field_values beats a stored draft; a stored
 *      draft beats the canonical column value.
 *   3. Empty-draft semantics: ''/null draft values are skipped (canonical
 *      value survives), matching the preview's mergeFieldValues.
 *   4. No-draft transactions produce a byte-identical merge to the old
 *      Object.assign({}, txDefaults, fieldValues).
 *
 * Run manually:
 *   node scripts/regression-contract-field-drafts-merge.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const REPO = path.join(__dirname, '..');

// --- Environment + middleware stubs (must precede handler require) --------
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub-key';

const authMod = require(path.join(REPO, 'api/_middleware/auth'));
authMod.verifySupabaseToken = async () => ({ userId: '00000000-0000-4000-8000-0000000000aa' });

const rateMod = require(path.join(REPO, 'api/_middleware/rateLimit'));
rateMod.checkRateLimit = async () => {};
rateMod.clientIpFromReq = () => '127.0.0.1';

// Short sentinels on purpose: broker_relationship_disclosure has ~106pt of
// real drawing room in ¶8A (fill-trec-20-19 clamps + truncates to one
// line), and '87' does not occur in the blank 20-19's own printed text
// (verified via pdftotext on the blank asset).
const SENTINEL_SURVEY_DAYS = '87';
const SENTINEL_DISCLOSURE = 'SENTINEL9917';

const FIXTURE_TX = {
  id: '00000000-0000-4000-8000-00000000tx01',
  user_id: '00000000-0000-4000-8000-0000000000aa',
  property_address: '123 Fixture Lane',
  city_state_zip: 'San Antonio, TX 78200',
  buyer_name: 'Fixture Buyer',
  seller_name: 'Fixture Seller',
  sale_price: 350000,
  earnest_money: 3500,
  option_fee: 200,
  option_days: 7,
  closing_date: '2026-10-15',
  title_company: 'Fixture Title Co',
  financing_type: 'conventional',
  transaction_type: 'buyer_purchase',
  role: 'buyer',
  // The agent already answered the SDN question — keeps
  // seller-disclosure-check off the network entirely.
  sellers_disclosure_received_at: '2026-08-30T00:00:00Z',
  sdn_received: true,
  // THE POINT: saved Interactive Editor drafts, editor legacy key names.
  contract_field_drafts: {
    '20-19': {
      survey_existing_days: SENTINEL_SURVEY_DAYS,     // -> survey_days_seller
      broker_disclosure_line1: SENTINEL_DISCLOSURE,   // -> broker_relationship_disclosure
    },
  },
};

const FIXTURE_PROFILE = {
  full_name: 'Fixture Agent',
  brokerage: 'Fixture Realty',
  phone: '210-555-0100',
  email: 'agent@example.test',
  agent_license_number: '000000',
};

// --- Network stub: serve fixture rows, capture the storage upload ---------
let uploadedPdf = null;
global.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  const jsonRes = (obj, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  if (u.includes('/rest/v1/transactions?') && method === 'GET') return jsonRes([FIXTURE_TX]);
  if (u.includes('/rest/v1/profiles?') && method === 'GET') return jsonRes([FIXTURE_PROFILE]);
  if (u.includes('/storage/v1/object/sign/')) return jsonRes({ signedURL: '/sign/stub.pdf' });
  if (u.includes('/storage/v1/object/') && method === 'POST') {
    uploadedPdf = Buffer.from(init.body);
    return jsonRes({ Key: 'stub' });
  }
  if (u.includes('/rest/v1/documents') && method === 'POST') {
    return jsonRes([{ id: '00000000-0000-4000-8000-00000000doc1' }]);
  }
  // Anything else (documents lookups, dossie_asks, etc.) — empty OK.
  return jsonRes([]);
};

const fillFormHandler = require(path.join(REPO, 'api/fill-form.js'));
const { mergeContractFieldDrafts } = (() => {
  try {
    return require(path.join(REPO, 'api/_lib/merge-contract-field-drafts.js'));
  } catch (_e) {
    return { mergeContractFieldDrafts: null }; // pre-fix code — tests will FAIL loudly
  }
})();

function mockRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { return this; },
  };
}

function pdfToText(pdfBytes) {
  const tmp = path.join(os.tmpdir(), 'regression-drafts-' + Date.now() + '.pdf');
  fs.writeFileSync(tmp, pdfBytes);
  try {
    return execSync(`pdftotext "${tmp}" -`).toString();
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function testDraftsReachTheFilledPdf() {
  uploadedPdf = null;
  const req = {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    body: {
      transaction_id: FIXTURE_TX.id,
      form_type: 'resale-contract',
      field_values: {},
    },
  };
  const res = mockRes();
  await fillFormHandler(req, res);
  assert.strictEqual(res.statusCode, 200,
    `fill-form should succeed on the fixture, got ${res.statusCode}: ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.ok(uploadedPdf && uploadedPdf.length > 1000, 'no PDF captured from the storage upload');
  const text = pdfToText(uploadedPdf);
  assert.ok(
    text.includes(SENTINEL_DISCLOSURE),
    `broker-disclosure draft ("${SENTINEL_DISCLOSURE}") did not reach the filled PDF — contract_field_drafts still ignored by the fill pipeline`
  );
  assert.ok(
    text.includes(SENTINEL_SURVEY_DAYS),
    `survey-days draft ("${SENTINEL_SURVEY_DAYS}") did not reach the filled PDF`
  );
  console.log('  PASS: both saved editor drafts render in the PDF the fill pipeline uploads');
}

async function testPrecedence() {
  assert.ok(mergeContractFieldDrafts, 'api/_lib/merge-contract-field-drafts.js missing (pre-fix code)');
  const tx = {
    id: 'tx-p',
    contract_field_drafts: { '20-19': { title_company: 'Draft Title Co', survey_existing_days: '9' } },
  };
  const out = mergeContractFieldDrafts({
    tx,
    formType: 'resale-contract',
    baseValues: { title_company: 'Canonical Title Co', buyer_name: 'B' },
    callerValues: { survey_existing_days: '12' },
  });
  assert.strictEqual(out.title_company, 'Draft Title Co', 'stored draft must beat the canonical column value');
  assert.strictEqual(out.survey_days_seller, '12', 'caller field_values must beat the stored draft (translated)');
  assert.strictEqual(out.buyer_name, 'B', 'untouched canonical values must survive');
  console.log('  PASS: precedence is canonical < draft < caller field_values');
}

async function testEmptyDraftValuesSkipped() {
  const tx = {
    id: 'tx-e',
    contract_field_drafts: { '20-19': { title_company: '', option_fee: null, survey_existing_days: '5' } },
  };
  const out = mergeContractFieldDrafts({
    tx,
    formType: 'resale-contract',
    baseValues: { title_company: 'Canonical Title Co', option_fee: '200' },
  });
  assert.strictEqual(out.title_company, 'Canonical Title Co', "'' draft must not clobber the canonical value");
  assert.strictEqual(out.option_fee, '200', 'null draft must not clobber the canonical value');
  assert.strictEqual(out.survey_days_seller, '5', 'real draft still lands');
  console.log('  PASS: empty draft values are skipped (matches the preview merge semantics)');
}

async function testNoDraftsIsIdentity() {
  const base = { a: '1', b: '2' };
  const caller = { b: '3' };
  const out = mergeContractFieldDrafts({ tx: { id: 'tx-n' }, formType: 'resale-contract', baseValues: base, callerValues: caller });
  assert.deepStrictEqual(out, { a: '1', b: '3' }, 'no-draft merge must equal Object.assign({}, base, caller)');
  const out2 = mergeContractFieldDrafts({
    tx: { id: 'tx-n2', contract_field_drafts: { '20-19': { x: '1' } } },
    formType: 'improvement-district',
    baseValues: base,
  });
  assert.deepStrictEqual(out2, base, 'forms without an editor draft key must be untouched');
  console.log('  PASS: draft-less transactions and non-editor forms are byte-identical to the old merge');
}

async function main() {
  console.log('contract_field_drafts merge regression — 2026-09-01 Defect A2 (drafts written, never read)');
  console.log('=========================================================================================');
  const tests = [
    ['saved editor drafts render in the filled PDF (full pipeline, fixture tx)', testDraftsReachTheFilledPdf],
    ['merge precedence', testPrecedence],
    ['empty draft values skipped', testEmptyDraftValuesSkipped],
    ['no-drafts identity', testNoDraftsIsIdentity],
  ];
  let failed = 0;
  for (const [label, fn] of tests) {
    try {
      console.log('\n' + label);
      await fn();
    } catch (e) {
      failed++;
      console.error('  FAIL:', e && e.message);
    }
  }
  console.log('\n=========================================================================================');
  if (failed) {
    console.log(failed + ' test(s) FAILED');
    process.exit(1);
  }
  console.log('All tests passed');
}

main().catch((e) => {
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
});
