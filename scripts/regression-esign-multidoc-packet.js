#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-08 CARTER multi-document packet build
 * (Phase 3 of docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md).
 *
 * What shipped:
 *   - esign-create accepts documentIds:[2..10] and builds ONE DocuSeal
 *     submission from ONE transient template carrying every PDF as its own
 *     document (verified live: fields bind per-document, areas[].page stays
 *     local + 1-indexed per document).
 *   - Field maps + BOTH 422 gates (buildMappedFieldMap +
 *     assertPlausibleMappedFieldCount) run on EVERY document in the packet.
 *   - Unmapped documents (e.g. an MLS-pulled seller's disclosure upload)
 *     ride in a packet via caller-placed fields routed by fields[].documentId,
 *     validated by validateCustomFieldsForDoc.
 *   - Field names get a per-document prefix (D1/D2/...) because same-name
 *     fields on one DocuSeal template share a single value.
 *   - esign-webhook stores EVERY signed document (not just documents[0]),
 *     downloads the completion certificate, hashes everything, and snapshots
 *     submission_events.
 *
 * Pre-fix behavior (proven in a disposable worktree of the prior commit):
 *   - 2 documentIds → 400 "Multi-document packets are not supported yet".
 *   - esign-create.__testing had no packet machinery at all.
 *   - esign-webhook stored only submission.documents[0] and dropped
 *     audit_log_url + submission_events on the floor.
 *
 * Run manually:
 *   node scripts/regression-esign-multidoc-packet.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'stub-key';

// Block ALL network egress — this test must never reach Supabase/DocuSeal.
global.fetch = async (url) => {
  throw new Error(`network blocked by regression test (${String(url).slice(0, 60)})`);
};

const esignCreate = require(path.join(REPO, 'api/esign-create.js'));
const T = esignCreate.__testing;
const webhook = require(path.join(REPO, 'api/esign-webhook.js'));
const WT = webhook.__testing;

const BUYER1 = { name: 'Fixture Buyer', email: 'delivered@resend.dev', role: 'Buyer 1' };
const BUYER2 = { name: 'Fixture Buyer Two', email: 'delivered@resend.dev', role: 'Buyer 2' };
const SELLER1 = { name: 'Fixture Seller', email: 'delivered@resend.dev', role: 'Seller 1' };

function expect422(fn, re, label) {
  try {
    fn();
  } catch (e) {
    assert.strictEqual(e.status || e.statusCode || 422, 422, `${label}: expected 422, got ${e.status}`);
    assert.ok(re.test(e.message), `${label}: message "${e.message}" did not match ${re}`);
    return;
  }
  assert.fail(`${label}: expected a 422 ValidationError, nothing thrown`);
}

// ---------------------------------------------------------------------------
function testPacketMachineryExported() {
  for (const k of ['buildPacketDocEntry', 'validateCustomFieldsForDoc', 'assertPacketSignable',
    'docusealCreateFromPacket', 'sha256Hex', 'MAX_PACKET_DOCUMENTS']) {
    assert.ok(T[k], `esign-create.__testing.${k} missing — packet machinery not shipped`);
  }
  assert.strictEqual(T.MAX_PACKET_DOCUMENTS, 10);
  console.log('  PASS: packet machinery exported (pre-fix this fails — no such exports)');
}

// Mapped form in a packet position gets its full verified widget set with a
// per-document name prefix, per signer, via the SAME machinery as single
// sends.
function testMappedDocInPacket() {
  const doc = {
    id: 'doc-tpfa', file_name: 'TPFA.pdf', document_type: 'financing_addendum',
    form_type: null, status: 'filled',
  };
  const { fields } = T.buildPacketDocEntry({
    doc, docIndex: 1, packetSize: 3,
    allSigners: [BUYER1, SELLER1],
    callerFields: null,
  });
  assert.ok(fields.length > 0, 'no fields built for mapped packet doc');
  assert.ok(fields.every((f) => f.name.startsWith('D2 ')),
    `every field must carry the D2 prefix — got ${fields.map((f) => f.name).join(', ')}`);
  const buyerSig = fields.filter((f) => f.role === 'Buyer 1' && f.type === 'signature');
  const sellerSig = fields.filter((f) => f.role === 'Seller 1' && f.type === 'signature');
  assert.ok(buyerSig.length >= 1, 'Buyer 1 has no signature widget on the TPFA');
  assert.ok(sellerSig.length >= 1, 'Seller 1 has no signature widget on the TPFA');
  for (const f of fields) {
    for (const a of f.areas) {
      assert.ok(Number.isInteger(a.page) && a.page >= 1, `non-1-indexed page on ${f.name}`);
      assert.ok(a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1, `bad coords on ${f.name}`);
    }
  }
  console.log(`  PASS: mapped TPFA in packet slot 2 built ${fields.length} widgets, D2-prefixed, both parties signed`);
}

// The 422 gate must fire on EVERY document in the packet — a 3rd buyer the
// form has no printed line for kills the whole packet no matter which slot
// the form occupies.
function testGateFiresPerPacketDocument() {
  const doc = {
    id: 'doc-491', file_name: '49-1.pdf', document_type: 'appraisal_termination',
    form_type: null, status: 'filled',
  };
  const buyer3 = { name: 'Third Buyer', email: 'delivered@resend.dev', role: 'Buyer 3' };
  expect422(
    () => T.buildPacketDocEntry({
      doc, docIndex: 2, packetSize: 3,
      allSigners: [BUYER1, BUYER2, buyer3],
      callerFields: null,
    }),
    /signature lines for/i,
    '3rd buyer on a 2-line form in packet slot 3'
  );
  console.log('  PASS: 422 gate fires on a later packet document (3rd buyer, no printed line)');
}

// Unmapped upload (the MLS seller's-disclosure case): caller-placed fields
// are required, validated, routed by documentId, and prefixed.
function testUnmappedUploadPlacement() {
  const doc = {
    id: 'doc-upload', file_name: 'MLS Sellers Disclosure.pdf',
    document_type: 'uploaded', form_type: null, status: 'uploaded',
  };

  // No placed fields → 422.
  expect422(
    () => T.buildPacketDocEntry({ doc, docIndex: 0, packetSize: 2, allSigners: [BUYER1], callerFields: [] }),
    /no signature field map and no placed fields/i,
    'unmapped doc without placements'
  );

  // Field for a role that isn't a signer → 422.
  expect422(
    () => T.validateCustomFieldsForDoc(doc, [{
      name: 'Signature (Seller 1)', type: 'signature', signerRole: 'Seller 1',
      areas: [{ page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.04 }],
    }], [BUYER1]),
    /not one of this packet's signers/i,
    'placement for a non-signer role'
  );

  // 0-indexed / invalid page → 422 (DocuSeal write convention is 1-indexed).
  expect422(
    () => T.validateCustomFieldsForDoc(doc, [{
      name: 'Signature (Buyer 1)', type: 'signature', signerRole: 'Buyer 1',
      areas: [{ page: 0, x: 0.1, y: 0.8, w: 0.3, h: 0.04 }],
    }], [BUYER1]),
    /invalid placement area/i,
    'page 0 placement'
  );

  // Text-only placements (nothing to sign) → 422.
  expect422(
    () => T.validateCustomFieldsForDoc(doc, [{
      name: 'Note', type: 'text', signerRole: 'Buyer 1',
      areas: [{ page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.04 }],
    }], [BUYER1]),
    /at least one signature or initials/i,
    'text-only placement set'
  );

  // Valid placement builds prefixed fields.
  const { fields } = T.buildPacketDocEntry({
    doc, docIndex: 1, packetSize: 2, allSigners: [BUYER1],
    callerFields: [
      { documentId: 'doc-upload', name: 'Signature (Buyer 1)', type: 'signature', signerRole: 'Buyer 1',
        areas: [{ page: 6, x: 0.1, y: 0.82, w: 0.32, h: 0.04 }] },
      { documentId: 'doc-upload', name: 'Date (Buyer 1)', type: 'date', signerRole: 'Buyer 1',
        areas: [{ page: 6, x: 0.55, y: 0.82, w: 0.18, h: 0.03 }] },
      { documentId: 'some-OTHER-doc', name: 'Must not leak', type: 'signature', signerRole: 'Buyer 1',
        areas: [{ page: 1, x: 0.1, y: 0.1, w: 0.3, h: 0.04 }] },
    ],
  });
  assert.strictEqual(fields.length, 2, `expected 2 routed fields, got ${fields.length} — documentId routing leaked`);
  assert.ok(fields.every((f) => f.name.startsWith('D2 ')), 'upload fields missing the per-doc prefix');
  assert.strictEqual(fields[0].areas[0].page, 6, 'placement page must pass through untouched (1-indexed local)');
  console.log('  PASS: unmapped upload placement — routing by documentId, validation gates, prefixing');
}

// Packet-wide gate: a principal signer with no signature anywhere is refused.
function testPacketSignableGate() {
  const packetDocs = [
    { fields: [{ role: 'Buyer 1', type: 'signature' }] },
    { fields: [{ role: 'Buyer 1', type: 'initials' }] },
  ];
  expect422(
    () => T.assertPacketSignable(packetDocs, [BUYER1, SELLER1]),
    /no signature field anywhere/i,
    'seller with no signature in packet'
  );
  // Agent without fields is fine (no printed agent line on TREC forms).
  T.assertPacketSignable(packetDocs, [BUYER1, { name: 'A', email: 'delivered@resend.dev', role: 'Agent' }]);
  console.log('  PASS: packet-wide signable gate (principal without signature refused; agent exempt)');
}

// Webhook completion leg: every signed document stored, certificate fetched
// and hashed, events snapshotted — from one submission payload.
async function testWebhookStoresAllArtifacts() {
  const stored = [];   // storage uploads
  const docRows = [];  // documents inserts
  const fetched = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    fetched.push(u);
    if (u.startsWith('https://files.example/')) {
      // Signed PDFs + audit certificate downloads.
      return { ok: true, arrayBuffer: async () => Buffer.from(`PDF-BYTES:${u}`).buffer };
    }
    if (u.includes('/storage/v1/object/')) {
      stored.push(u);
      return { ok: true, text: async () => '' };
    }
    if (u.includes('/rest/v1/documents')) {
      docRows.push(JSON.parse(opts.body));
      return { ok: true, json: async () => [{ id: `doc-row-${docRows.length}` }] };
    }
    throw new Error(`unexpected fetch in webhook test: ${u}`);
  };

  const sr = { user_id: 'user-1', transaction_id: 'tx-1', docuseal_submission_id: '999001' };
  const submission = {
    id: 999001,
    documents: [
      { name: 'Contract', url: 'https://files.example/contract.pdf' },
      { name: 'TPFA', url: 'https://files.example/tpfa.pdf' },
      { name: 'Appraisal Addendum', url: 'https://files.example/49-1.pdf' },
    ],
    audit_log_url: 'https://files.example/audit.pdf',
    submission_events: [
      { event_type: 'view_form', email: 'delivered@resend.dev', event_timestamp: '2026-09-08T00:00:00Z' },
      { event_type: 'complete_form', email: 'delivered@resend.dev', event_timestamp: '2026-09-08T00:05:00Z' },
    ],
  };

  const out = await WT.storeSignedArtifacts(sr, submission);
  assert.strictEqual(out.signedDocs.length, 3,
    `expected ALL 3 signed documents stored, got ${out.signedDocs.length} — pre-fix only documents[0] was kept`);
  assert.ok(out.signedDocs.every((d) => /^[0-9a-f]{64}$/.test(d.sha256)), 'signed PDFs must be sha256-hashed');
  assert.ok(out.auditDocId, 'completion certificate was not stored as a documents row');
  assert.ok(/^[0-9a-f]{64}$/.test(out.auditSha256), 'audit certificate must be sha256-hashed');
  assert.strictEqual(out.auditFetchFailed, false, 'audit fetch wrongly marked failed');
  assert.strictEqual(out.events.length, 2, 'submission_events snapshot missing');
  const certRow = docRows.find((d) => d.document_type === 'signing_certificate');
  assert.ok(certRow, 'no signing_certificate documents row inserted');
  assert.strictEqual(docRows.filter((d) => d.document_type === 'signed').length, 3, 'expected 3 signed documents rows');
  console.log('  PASS: webhook stores all 3 signed PDFs + certificate, hashes everything, snapshots events');

  // Missing audit_log_url (sandbox) → flow continues, failure stamped.
  const out2 = await WT.storeSignedArtifacts(sr, { ...submission, audit_log_url: null });
  assert.strictEqual(out2.auditFetchFailed, true, 'missing audit_log_url must stamp auditFetchFailed');
  assert.strictEqual(out2.signedDocs.length, 3, 'signed docs must still store when the certificate is unavailable');
  console.log('  PASS: certificate unavailability does not block completion; audit_fetch_failed stamped');
}

async function main() {
  console.log('esign multi-document packet regression — 2026-09-08 (one envelope, per-doc gates, audit trail)');
  console.log('==============================================================================================');
  const tests = [
    ['packet machinery exported', testPacketMachineryExported],
    ['mapped form in packet slot', testMappedDocInPacket],
    ['422 gate fires per packet document', testGateFiresPerPacketDocument],
    ['unmapped upload placement path', testUnmappedUploadPlacement],
    ['packet-wide signable gate', testPacketSignableGate],
    ['webhook stores all artifacts', testWebhookStoresAllArtifacts],
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
  console.log('\n==============================================================================================');
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
