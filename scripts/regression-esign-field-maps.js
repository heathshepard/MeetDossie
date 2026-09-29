#!/usr/bin/env node
// scripts/regression-esign-field-maps.js
//
// Regression net for the per-form e-sign field maps (Phase 2,
// docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md) — the fix for the
// 2026-08-30 Ridge Bluff failure class where every non-resale form went out
// with one auto-placed signature and zero initials.
//
// Proven to FAIL on a pre-fix worktree (2026-09-08): without
// api/_assets/esign-field-maps.json and the esign-create wiring, checks 1/5/6
// fail immediately.
//
// What it guards:
//  1. api/_assets/esign-field-maps.json exists, parses, covers all 23 forms.
//  2. HASH PINS — each form's blank_pdf_sha256 matches the live base64 asset
//     fill-form.js fills today. A form-revision commit that swaps a PDF
//     without regenerating the maps fails HERE instead of running stale
//     geometry (the 20-18-coords-on-20-19 failure mode).
//  3. Structural geometry: exactly 1 signature per principal role, coords in
//     bounds, pages in range.
//  4. INITIALS COVERAGE — the per-page initials each multi-page form is known
//     to print (verified by rendering every page and reading it, 2026-09-08)
//     are present for every principal role.
//  5. esign-create resolution + assignment: document_type and
//     filled_form+form_type both resolve; buyer1 gets the first line,
//     co-buyer the second; agent only gets widgets where a printed broker
//     line exists (OP-L).
//  6. THE 422 GATE: too many signers, duplicate roles, unclassifiable roles,
//     and undercount tampering all throw ValidationError — a packet that
//     can't be placed correctly must never reach DocuSeal.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}: ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertThrows422(fn, msg) {
  try { fn(); } catch (err) {
    assert(err && (err.status === 422 || err.statusCode === 422), `${msg} — threw but not 422: ${err.message}`);
    return;
  }
  throw new Error(`${msg} — did not throw`);
}

const EXPECTED_FORMS = [
  'amendment', 'appraisal-termination', 'backup-contract', 'buyers-temp-lease',
  'coastal-area', 'environmental', 'financing-addendum', 'fixture-leases',
  'gulf-waterway', 'hoa-addendum', 'hydrostatic-testing', 'improvement-district',
  'lead-paint-addendum', 'loan-assumption', 'oil-gas-minerals', 'propane-gas',
  'residential-leases', 'sale-other-property', 'seller-financing',
  'sellers-disclosure', 'sellers-temp-lease', 'short-sale', 'unimproved-property',
];

// Pages that print an "Initialed for identification..." footer, verified by
// RENDERING every page of every form and reading it (2026-09-08). If a form
// revision adds/removes a footer, regenerate the role map and update this.
const EXPECTED_INITIALS_PAGES = {
  'financing-addendum': [1],
  'backup-contract': [1],
  'loan-assumption': [1],
  'buyers-temp-lease': [1],
  'sellers-temp-lease': [1],
  'seller-financing': [1],
  'unimproved-property': [1, 2, 3, 4, 5, 6, 7],
};

const MAPS_PATH = path.join(REPO, 'api', '_assets', 'esign-field-maps.json');

console.log('regression-esign-field-maps');

let maps = null;
check('1. esign-field-maps.json exists and covers all 23 mapped forms', () => {
  assert(fs.existsSync(MAPS_PATH), 'api/_assets/esign-field-maps.json is missing');
  maps = JSON.parse(fs.readFileSync(MAPS_PATH, 'utf8'));
  for (const slug of EXPECTED_FORMS) {
    assert(maps.forms[slug], `form ${slug} missing from field maps`);
    assert(maps.document_type_index[maps.forms[slug].document_type] === slug,
      `document_type_index broken for ${slug}`);
  }
});

check('2. hash pins match the live blank assets fill-form fills', () => {
  assert(maps, 'maps not loaded');
  const { FORM_CONFIGS } = require(path.join(REPO, 'api', 'fill-form.js')).__testing;
  for (const slug of EXPECTED_FORMS) {
    const entry = maps.forms[slug];
    const raw = FORM_CONFIGS[slug].getBase64();
    const b64 = typeof raw === 'string' ? raw : (raw.base64Pdf || raw.base64 || raw.b64);
    const sha = crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
    assert(sha === entry.blank_pdf_sha256,
      `${slug}: blank asset sha256 changed but the field map was not regenerated — `
      + `rerun scripts/build-esign-field-maps.js after re-verifying geometry by render`);
  }
});

check('3. structural geometry: one signature per principal, coords/pages in bounds', () => {
  for (const slug of EXPECTED_FORMS) {
    const entry = maps.forms[slug];
    for (const r of ['buyer1', 'buyer2', 'seller1', 'seller2']) {
      const sigs = (entry.roles[r] || []).filter((f) => f.type === 'signature');
      assert(sigs.length === 1, `${slug}/${r}: ${sigs.length} signatures (expected 1)`);
    }
    for (const [role, fields] of Object.entries(entry.roles)) {
      for (const f of fields) {
        const a = f.areas[0];
        assert(a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1 && a.w > 0 && a.h > 0
          && a.x + a.w <= 1.005 && a.y + a.h <= 1.005,
          `${slug}/${role}/${f.name}: area out of bounds`);
        assert(Number.isInteger(a.page) && a.page >= 1 && a.page <= entry.page_count,
          `${slug}/${role}/${f.name}: page ${a.page} outside 1..${entry.page_count}`);
      }
    }
  }
});

check('4. per-page initials coverage matches the printed footers', () => {
  for (const [slug, pages] of Object.entries(EXPECTED_INITIALS_PAGES)) {
    const entry = maps.forms[slug];
    for (const r of ['buyer1', 'buyer2', 'seller1', 'seller2']) {
      const iniPages = (entry.roles[r] || []).filter((f) => f.type === 'initials').map((f) => f.areas[0].page);
      for (const p of pages) {
        assert(iniPages.includes(p), `${slug}/${r}: no initials widget on page ${p} (printed footer verified by render)`);
      }
    }
  }
});

const T = require(path.join(REPO, 'api', 'esign-create.js')).__testing;

check('5. esign-create resolves + assigns: first buyer -> first line, no crossing', () => {
  assert(typeof T.resolveEsignFieldMapForDoc === 'function', 'esign-create is missing the field-map wiring');
  // Resolution by document_type (fill-form docs) and by form_type (dossiesign-prepare previews).
  const byDocType = T.resolveEsignFieldMapForDoc({ document_type: 'financing_addendum', form_type: null });
  assert(byDocType && byDocType.form_type === 'financing-addendum', 'document_type resolution failed');
  const byFormType = T.resolveEsignFieldMapForDoc({ document_type: 'filled_form', form_type: 'financing-addendum' });
  assert(byFormType && byFormType.form_type === 'financing-addendum', 'filled_form+form_type resolution failed');
  assert(T.resolveEsignFieldMapForDoc({ document_type: 'resale_contract', form_type: null }) === null
    || maps.document_type_index.resale_contract === undefined,
    'resale_contract must NOT be in the generic maps (it has its own coords path)');

  const signers = [
    { name: 'B1', email: 'delivered@resend.dev', role: 'Buyer' },
    { name: 'B2', email: 'delivered@resend.dev', role: 'Co-Buyer' },
    { name: 'S1', email: 'delivered@resend.dev', role: 'Seller' },
  ];
  const { fieldMap } = T.buildMappedFieldMap(byDocType, signers);
  // financing-addendum: each principal = 1 initials (p1) + 1 signature (p2).
  for (const role of ['Buyer', 'Co-Buyer', 'Seller']) {
    assert(fieldMap[role] && fieldMap[role].length === 2, `${role}: expected 2 widgets`);
    assert(fieldMap[role].some((f) => f.type === 'signature'), `${role}: no signature`);
    assert(fieldMap[role].some((f) => f.type === 'initials'), `${role}: no initials`);
  }
  // buyer1 (Buyer) and buyer2 (Co-Buyer) must be on DIFFERENT rects — no sharing.
  const b1Sig = fieldMap['Buyer'].find((f) => f.type === 'signature').areas[0];
  const b2Sig = fieldMap['Co-Buyer'].find((f) => f.type === 'signature').areas[0];
  assert(b1Sig.x !== b2Sig.x || b1Sig.y !== b2Sig.y, 'Buyer and Co-Buyer share a signature rect');
  // buyer1's line is printed ABOVE buyer2's on the 40-11 signature page.
  assert(b1Sig.y < b2Sig.y, 'Buyer 1 must take the first (upper) printed line');
  T.assertPlausibleMappedFieldCount(byDocType, fieldMap, signers);

  // Agent handling: no printed agent line on 40-11 -> no widgets (legacy
  // fallback applies); OP-L HAS broker lines -> agent gets them.
  const withAgent = T.buildMappedFieldMap(byDocType, [...signers, { name: 'A', email: 'delivered@resend.dev', role: 'Agent' }]);
  assert(!withAgent.fieldMap['Agent'], '40-11 has no agent line; Agent must not get mapped widgets');
  const opl = maps.forms['lead-paint-addendum'];
  const oplBuilt = T.buildMappedFieldMap(opl, [...signers, { name: 'A', email: 'delivered@resend.dev', role: 'Agent' }]);
  assert(oplBuilt.fieldMap['Agent'] && oplBuilt.fieldMap['Agent'].some((f) => f.type === 'signature'),
    'OP-L prints a Buyer\'s Broker line; Agent must get it');
});

check('6. the 422 gate blocks unplaceable packets', () => {
  const entry = maps.forms['financing-addendum'];
  const two = [
    { name: 'B1', email: 'delivered@resend.dev', role: 'Buyer' },
    { name: 'S1', email: 'delivered@resend.dev', role: 'Seller' },
  ];
  // (a) more buyers than printed lines
  assertThrows422(() => T.buildMappedFieldMap(entry, [
    ...two,
    { name: 'B2', email: 'delivered@resend.dev', role: 'Co-Buyer' },
    { name: 'B3', email: 'delivered@resend.dev', role: 'Co-Buyer 3' },
  ]), 'third buyer on a 2-buyer form must 422');
  // (b) duplicate role strings would cross-assign fields
  assertThrows422(() => T.buildMappedFieldMap(entry, [
    { name: 'B1', email: 'delivered@resend.dev', role: 'Buyer' },
    { name: 'B2', email: 'delivered@resend.dev', role: 'Buyer' },
  ]), 'duplicate signer roles must 422');
  // (c) unclassifiable role
  assertThrows422(() => T.buildMappedFieldMap(entry, [
    { name: 'X', email: 'delivered@resend.dev', role: 'Escrow Officer' },
  ]), 'unclassifiable role must 422');
  // (d) tampered/undercounted field map (simulates assignment logic dropping widgets)
  const { fieldMap } = T.buildMappedFieldMap(entry, two);
  const tampered = { ...fieldMap, Buyer: fieldMap.Buyer.slice(0, 1) };
  assertThrows422(() => T.assertPlausibleMappedFieldCount(entry, tampered, two),
    'undercounted field map must 422');
  // (e) signer with no signature widget
  const noSig = { ...fieldMap, Buyer: fieldMap.Buyer.filter((f) => f.type !== 'signature') };
  assertThrows422(() => T.assertPlausibleMappedFieldCount(entry, noSig, two),
    'signer without a signature widget must 422');
});

check('7. build script --check: committed output is current', () => {
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'build-esign-field-maps.js'), '--check'], { stdio: 'pipe' });
});

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll checks passed.');
