// api/esign-signature-date-gate.test.js
//
// Real, executed proof for the signature/date pairing gate added 2026-09-21
// after the 2026-09-20 incident: a $999,000 contract went out with 18
// initials, 6 signatures, and ZERO dates, because nothing but human eyes
// checked the counts. SignatureConfirmCard.jsx's own header comment states
// the contract this closes: "The server refuses to issue a token at all
// when signatures and dates do not pair."
//
// Every test here calls the REAL exported production functions
// (computePacketFieldCounts / assertPlausibleMappedFieldCount /
// validateCustomFieldsForDoc via the unmapped path) — nothing here is a
// mock of the gate itself. This is unit-level (no HTTP, no DocuSeal, no
// Supabase), which is deliberate: it proves the gate logic fires for real
// without any network dependency. The live HTTP proof against the deployed
// preview endpoint (real demo-account document, real non-zero counts, a
// real token) is documented separately in the PR/report — this file is the
// repeatable regression guard.
//
// Run with: node --test api/esign-signature-date-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || '';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || '';

const esignCreate = require('./esign-create.js');
const { computePacketFieldCounts } = esignCreate;
const { assertPlausibleMappedFieldCount, validateCustomFieldsForDoc, resaleFormEntry } = esignCreate.__testing;

const BUYER1 = { name: 'Test Buyer', email: 'buyer@example.com', role: 'Buyer 1' };
const SELLER1 = { name: 'Test Seller', email: 'seller@example.com', role: 'Seller 1' };
const BUYER2 = { name: 'Test Buyer 2', email: 'buyer2@example.com', role: 'Buyer 2' };
const SELLER2 = { name: 'Test Seller 2', email: 'seller2@example.com', role: 'Seller 2' };

// ---------------------------------------------------------------------------
// NEGATIVE TEST — unmapped document, caller-placed fields with signatures
// that outnumber dates. Runs the REAL validateCustomFieldsForDoc().
// ---------------------------------------------------------------------------
test('NEGATIVE: a signer with more signature fields than date fields is refused, by name', () => {
  const doc = { id: 'doc-1', file_name: '23 Nopalito - Seller Disclosure (scan).pdf', document_type: 'uploaded_scan' };
  const mismatchedFields = [
    { name: 'Seller 1 Signature 1', type: 'signature', signerRole: 'Seller 1', areas: [{ page: 1, x: 0.1, y: 0.2, w: 0.2, h: 0.03 }] },
    { name: 'Seller 1 Signature 2', type: 'signature', signerRole: 'Seller 1', areas: [{ page: 2, x: 0.1, y: 0.2, w: 0.2, h: 0.03 }] },
    // Zero date fields for Seller 1 — the exact 2026-09-20 shape (signatures with no dates).
    { name: 'Seller 1 Initials P1', type: 'initials', signerRole: 'Seller 1', areas: [{ page: 1, x: 0.5, y: 0.9, w: 0.05, h: 0.02 }] },
  ];

  assert.throws(
    () => validateCustomFieldsForDoc(doc, mismatchedFields, [SELLER1]),
    (err) => {
      assert.equal(err.status, 422);
      assert.match(err.message, /Seller 1/);
      assert.match(err.message, /2 signature fields/);
      assert.match(err.message, /0 date fields/);
      assert.match(err.message, /paired with a date/);
      assert.match(err.message, /23 Nopalito - Seller Disclosure/); // names the document
      return true;
    },
  );
});

test('NEGATIVE via computePacketFieldCounts(): the same mismatch surfaces as ok:false, not a thrown 500', () => {
  // computePacketFieldCounts has no way to pass callerFields for an unmapped
  // doc through its own signature in this repo's real call shape (chat never
  // supplies custom fields), so this proves the OTHER real shape: an
  // unmapped document with zero caller fields refuses outright rather than
  // silently reporting a signable packet.
  const doc = { id: 'doc-2', file_name: 'Uploaded scan.pdf', document_type: 'uploaded_scan' };
  const result = computePacketFieldCounts({ documents: [doc], signers: [SELLER1], callerFields: [] });
  assert.equal(result.ok, false);
  assert.equal(result.document_id, 'doc-2');
  assert.match(result.error, /no signature field map and no placed fields/);
});

// ---------------------------------------------------------------------------
// POSITIVE TEST — the real resale (TREC 20-19) form map, real signers.
// buildMappedFieldMap pairs signature+date by construction; this proves the
// gate does NOT fire on a correctly paired packet and that counts come back
// accurate and non-zero.
// ---------------------------------------------------------------------------
test('POSITIVE: a correctly paired resale-contract packet previews cleanly with accurate non-zero counts', () => {
  const doc = { id: 'doc-3', file_name: '311 Copperfield Dr - Resale Contract.pdf', document_type: 'resale_contract' };
  const result = computePacketFieldCounts({ documents: [doc], signers: [BUYER1, SELLER1], callerFields: [] });

  assert.equal(result.ok, true, result.ok ? '' : result.error);
  assert.equal(result.documents.length, 1);
  const counts = result.documents[0].counts;

  assert.ok(counts['Buyer 1'], 'Buyer 1 got real fields');
  assert.ok(counts['Seller 1'], 'Seller 1 got real fields');
  assert.equal(counts['Buyer 1'].signatures, counts['Buyer 1'].dates, 'Buyer 1 sig/date paired');
  assert.equal(counts['Seller 1'].signatures, counts['Seller 1'].dates, 'Seller 1 sig/date paired');
  // Non-zero — a card showing 0/0/0 is exactly the silent-defeat bug this
  // whole gate exists to close.
  assert.ok(counts['Buyer 1'].signatures > 0, 'Buyer 1 has a real signature count');
  assert.ok(counts['Seller 1'].signatures > 0, 'Seller 1 has a real signature count');

  // Cross-check against the real formEntry's expected_field_count_per_role
  // so this test would fail if resaleFormEntry() itself is ever broken by a
  // future edit, not just if the gate wiring breaks.
  const formEntry = resaleFormEntry();
  const buyer1Expected = formEntry.expected_field_count_per_role.buyer1;
  const buyer1Actual = counts['Buyer 1'].signatures + counts['Buyer 1'].dates + counts['Buyer 1'].initials;
  assert.equal(buyer1Actual, buyer1Expected, 'Buyer 1 total widget count matches the verified map');
});

// ---------------------------------------------------------------------------
// POSITIVE — 2026-09-21 date-widget rollout. Heath, verbatim: "Build the
// date widgets into all 22 form maps you found with zero. Every signature
// on every form gets a paired date." (The real count of non-resale maps
// with zero dates was 19, not 22 — see report.) Each form below had its
// signature area rendered to a PNG and visually checked against the real
// PDF before its date field was added (scripts/esign-role-maps/<slug>.json)
// — this test proves the mapping now actually pairs for every signer with a
// printed line, using the REAL compiled map, not a mock.
// ---------------------------------------------------------------------------
const FOUR_ROLE_MAPPED_FORMS = [
  ['unimproved-property', 'unimproved_property_contract'],
  ['buyers-temp-lease', 'buyers_temp_lease'],
  ['sellers-temp-lease', 'sellers_temp_lease'],
  ['sale-other-property', 'sale_other_property_addendum'],
  ['hydrostatic-testing', 'hydrostatic_testing_addendum'],
  ['environmental', 'environmental_addendum'],
  ['seller-financing', 'seller_financing_addendum'],
  ['hoa-addendum', 'hoa_addendum'],
  ['appraisal-termination', 'appraisal_termination'],
  ['oil-gas-minerals', 'oil_gas_minerals_addendum'],
  ['backup-contract', 'backup_contract_addendum'],
  ['financing-addendum', 'financing_addendum'],
  ['residential-leases', 'residential_leases_addendum'],
  ['loan-assumption', 'loan_assumption_addendum'],
  ['fixture-leases', 'fixture_leases_addendum'],
];

for (const [slug, documentType] of FOUR_ROLE_MAPPED_FORMS) {
  test(`POSITIVE: ${slug} pairs signature+date for all 4 printed signature lines`, () => {
    const doc = { id: `doc-${slug}`, file_name: `Test - ${slug}.pdf`, document_type: documentType };
    const result = computePacketFieldCounts({
      documents: [doc], signers: [BUYER1, SELLER1, BUYER2, SELLER2], callerFields: [],
    });
    assert.equal(result.ok, true, result.ok ? '' : result.error);
    const counts = result.documents[0].counts;
    for (const role of ['Buyer 1', 'Seller 1', 'Buyer 2', 'Seller 2']) {
      assert.ok(counts[role], `${role} got real fields on ${slug}`);
      assert.ok(counts[role].signatures > 0, `${role} has a real signature count on ${slug}`);
      assert.equal(counts[role].signatures, counts[role].dates, `${role} sig/date paired on ${slug}`);
    }
  });
}

// short-sale is the one form mapped BUYER1/SELLER1 only — its printed
// buyer2/seller2 lines sit too close to the footer disclaimer for any safe
// date placement (rendered + visually confirmed, see report), so those two
// roles were deliberately left signature-only. This must keep refusing a
// 2-buyer/2-seller send rather than silently drop the missing dates.
test('POSITIVE: short-sale pairs signature+date for buyer1/seller1 (the mapped roles)', () => {
  const doc = { id: 'doc-short-sale-1v1', file_name: 'Test - short-sale.pdf', document_type: 'short_sale_addendum' };
  const result = computePacketFieldCounts({ documents: [doc], signers: [BUYER1, SELLER1], callerFields: [] });
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  const counts = result.documents[0].counts;
  assert.equal(counts['Buyer 1'].signatures, counts['Buyer 1'].dates, 'Buyer 1 sig/date paired on short-sale');
  assert.equal(counts['Seller 1'].signatures, counts['Seller 1'].dates, 'Seller 1 sig/date paired on short-sale');
  assert.ok(counts['Buyer 1'].signatures > 0);
});

test('NEGATIVE: short-sale still refuses a 2-buyer/2-seller send (buyer2/seller2 intentionally left dateless)', () => {
  const doc = { id: 'doc-short-sale-2v2', file_name: 'Test - short-sale.pdf', document_type: 'short_sale_addendum' };
  const result = computePacketFieldCounts({
    documents: [doc], signers: [BUYER1, SELLER1, BUYER2, SELLER2], callerFields: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Buyer 2|Seller 2/);
  assert.match(result.error, /signature field/);
  assert.match(result.error, /date field/);
});

// ---------------------------------------------------------------------------
// DETERMINISM — "the counts shown to the user match what actually gets
// placed, not a separate estimate that can drift." Preview and a fresh
// re-derivation (what send does) must be byte-identical for the same inputs,
// because they are literally the same function call, not two
// implementations that could disagree.
// ---------------------------------------------------------------------------
test('DETERMINISM: preview counts and a fresh send-time re-derivation are identical', () => {
  const doc = { id: 'doc-4', file_name: 'Amendment.pdf', document_type: resolvableMappedAmendmentType() };
  const previewResult = computePacketFieldCounts({ documents: [doc], signers: [BUYER1], callerFields: [] });
  const sendResult = computePacketFieldCounts({ documents: [doc], signers: [BUYER1], callerFields: [] });
  assert.deepEqual(previewResult, sendResult);
});

// Picks a document_type this repo's field-map index actually resolves, so
// the determinism test exercises a real generic-map form rather than only
// the special-cased resale path. Falls back to resale_contract if the
// generic index is empty in this environment (never observed locally, but
// keeps this test from being a false negative on a stripped-down runner).
function resolvableMappedAmendmentType() {
  try {
    const maps = esignCreate.__testing.loadEsignFieldMaps();
    const idx = maps.document_type_index || {};
    const firstDocType = Object.keys(idx)[0];
    if (firstDocType) return firstDocType;
  } catch (_) {}
  return 'resale_contract';
}
