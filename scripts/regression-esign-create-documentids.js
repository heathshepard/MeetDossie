#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-01 CARTER fix to Defect A1
 * (docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md §2.1-2.3):
 *
 * The DossieSign FormEditor Send button POSTed
 *   { transactionId, templateId: '4952172', fields: <object>, signers }
 * to /api/esign-create, which requires `documentId` — every send returned
 * 400 "documentId is required." The `fields` object would also have been
 * nulled by the endpoint's Array.isArray check, and templateId 4952172
 * routed into the abandoned pink-widget template path.
 *
 * Fix (two halves):
 *   - api/esign-create.js accepts `documentIds: [uuid]` alongside legacy
 *     `documentId` (multi-doc rejected loudly until Phase 3).
 *   - SendPacketButton.jsx bakes the live snapshot to storage via
 *     POST /api/interactive-editor-download-pdf { persist: true } and then
 *     POSTs { transactionId, documentIds, signers }; templateId + fields
 *     are gone from the payload, DEFAULT_TEMPLATE_ID deleted.
 *
 * Tests here:
 *   1. esign-create with { documentIds: ['x'], signers } gets PAST the
 *      "documentId is required." validation (auth + rate-limit stubbed;
 *      the request then fails deeper on the stubbed network, which is fine
 *      — the regression was the validation rejection).
 *   2. esign-create with 2 documentIds fails loudly with the
 *      multi-document message, not a silent drop.
 *   3. The OLD button payload (templateId + object fields, no documentId)
 *      still 400s — documenting that the old contract never existed.
 *   4. The shipped workspace bundle posts documentIds and no longer
 *      contains the '4952172' default template id.
 *   5. interactive-editor-download-pdf.js exposes the persist path the
 *      button depends on.
 *
 * Run manually:
 *   node scripts/regression-esign-create-documentids.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..');

// --- Environment + middleware stubs (must precede the handler require) ----
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub-key';

const authMod = require(path.join(REPO, 'api/_middleware/auth'));
authMod.verifySupabaseToken = async () => ({ userId: '00000000-0000-4000-8000-000000000001' });

const rateMod = require(path.join(REPO, 'api/_middleware/rateLimit'));
rateMod.checkRateLimit = async () => {};
rateMod.clientIpFromReq = () => '127.0.0.1';

// Block ALL network egress — this test must never reach Supabase/DocuSeal.
global.fetch = async () => {
  throw new Error('network blocked by regression test');
};

const handler = require(path.join(REPO, 'api/esign-create.js'));

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

async function post(body) {
  const req = {
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    body,
  };
  const res = mockRes();
  await handler(req, res);
  return res;
}

const SIGNERS = [{ name: 'Fixture Buyer', email: 'delivered@resend.dev', role: 'Buyer 1' }];

async function testDocumentIdsAccepted() {
  const res = await post({
    transactionId: 'tx-1',
    documentIds: ['11111111-1111-4111-8111-111111111111'],
    signers: SIGNERS,
  });
  const err = (res.body && res.body.error) || '';
  assert.ok(
    !(res.statusCode === 400 && /documentId is required/i.test(err)),
    `documentIds:[uuid] must pass documentId validation — got ${res.statusCode} "${err}"`
  );
  console.log(`  PASS: documentIds:[uuid] accepted past validation (proceeded to ${res.statusCode}: "${err.slice(0, 60)}")`);
}

async function testMultiDocumentRejectedLoudly() {
  const res = await post({
    transactionId: 'tx-1',
    documentIds: ['a', 'b'],
    signers: SIGNERS,
  });
  const err = (res.body && res.body.error) || '';
  assert.strictEqual(res.statusCode, 400, `expected 400 for 2 documentIds, got ${res.statusCode}`);
  assert.ok(
    /multi-document/i.test(err),
    `expected the multi-document message, got "${err}" — a silent first-doc pick or "documentId is required" are both wrong`
  );
  console.log('  PASS: two documentIds rejected loudly with the multi-document message');
}

async function testOldButtonPayloadStillRejected() {
  const res = await post({
    transactionId: 'tx-1',
    templateId: '4952172',
    fields: { sale_price: '100000' },
    signers: SIGNERS,
  });
  const err = (res.body && res.body.error) || '';
  assert.strictEqual(res.statusCode, 400, `expected 400 for the old payload, got ${res.statusCode}`);
  assert.ok(/documentId is required/i.test(err), `expected "documentId is required.", got "${err}"`);
  console.log('  PASS: the old { templateId, fields } payload still 400s (that contract never existed)');
}

async function testShippedBundlePostsDocumentIds() {
  const assetsDir = path.join(REPO, 'assets');
  const bundles = fs.readdirSync(assetsDir).filter((f) => /^workspace-.*\.js$/.test(f));
  assert.ok(bundles.length > 0, 'no workspace-*.js bundle found in assets/');
  for (const b of bundles) {
    const src = fs.readFileSync(path.join(assetsDir, b), 'utf8');
    assert.ok(src.includes('documentIds'), `${b} does not reference documentIds — Send button fix not in the shipped bundle`);
    assert.ok(!src.includes('4952172'), `${b} still contains the deleted DEFAULT_TEMPLATE_ID 4952172`);
  }
  console.log(`  PASS: shipped bundle(s) [${bundles.join(', ')}] post documentIds; 4952172 default is gone`);
}

async function testDownloadPdfPersistPathExists() {
  const src = fs.readFileSync(path.join(REPO, 'api/interactive-editor-download-pdf.js'), 'utf8');
  assert.ok(/params\.persist === true/.test(src), 'persist mode missing from interactive-editor-download-pdf.js');
  assert.ok(/persistFilledPdf/.test(src), 'persistFilledPdf missing from interactive-editor-download-pdf.js');
  console.log('  PASS: interactive-editor-download-pdf.js exposes the persist (bake-to-storage) path');
}

async function main() {
  console.log('esign-create documentIds regression — 2026-09-01 Defect A1 (Send button payload mismatch)');
  console.log('=========================================================================================');
  const tests = [
    ['documentIds:[uuid] passes validation', testDocumentIdsAccepted],
    ['multi-document rejected loudly', testMultiDocumentRejectedLoudly],
    ['old templateId+fields payload still 400s', testOldButtonPayloadStillRejected],
    ['shipped bundle posts documentIds, no 4952172', testShippedBundlePostsDocumentIds],
    ['download-pdf persist path exists', testDownloadPdfPersistPathExists],
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
