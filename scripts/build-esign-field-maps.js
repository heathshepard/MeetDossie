#!/usr/bin/env node
// scripts/build-esign-field-maps.js
//
// Build-time converter: semantic role maps -> DocuSeal-ready e-sign field maps.
//
// Productionizes the proven PoC (.tmp/docuseal-poc/rolemap-to-docuseal.js,
// verified live 2026-09-01 against DocuSeal template 5682622: values landed
// exactly on their printed lines in a real browser; see
// docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md §0).
//
// INPUT:  scripts/esign-role-maps/<form>.json — checked-in role maps. Each
//         field carries coordinates measured from the live AcroForm widget
//         rects (top-left-origin PERCENTAGES 0-100), a semantic role
//         (buyer1/seller1/listing_agent/property/deal/...), a semantic
//         field_key, field_type, and (for checkboxes) the printed meaning.
//         Roles/keys were derived by RENDERING the form and reading it —
//         never from AcroForm field names (see memory: acroform-field-names-lie).
//
// OUTPUT: api/_assets/esign-field-maps.json — ONE combined file (statically
//         require-able so Vercel's file tracing bundles it; a directory of
//         dynamically-named files would not be traced). Mode A per the
//         integration plan §1.4: only PARTY-owned signing widgets are
//         emitted — signatures, per-page initials, and printed date lines.
//         Everything else (deal/property text, checkboxes) is baked into the
//         PDF by the fill engine before send; emitting it here would recreate
//         the pink-editable-widget bug the v13 rollback killed.
//
// COORDINATE TRANSFORM (proven live in the PoC):
//         area = { x: x_pct/100, y: y_pct/100, w: w_pct/100, h: h_pct/100,
//                  page }   // role maps and DocuSeal are BOTH top-left
//         origin; page passes through unchanged (role maps are 1-indexed,
//         DocuSeal areas[].page "Starts from 1" on WRITE; GET echoes it
//         0-indexed — never "correct" a page from a read-back).
//
// HASH PINNING: each form embeds blank_pdf_sha256 — the sha256 of the decoded
//         base64 asset fill-form.js actually fills (verified byte-identical to
//         FORM_CONFIGS[slug].getBase64() at build time). The regression suite
//         (scripts/regression-esign-field-maps.js) re-verifies the pin on
//         every run, so a form-revision commit that swaps an asset without
//         regenerating the map fails QA loudly instead of silently running
//         stale geometry (the exact 20-18-coords-on-20-19 failure mode).
//
// Usage:  node scripts/build-esign-field-maps.js          # writes the map
//         node scripts/build-esign-field-maps.js --check  # verify only (no write)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const ROLE_MAP_DIR = path.join(REPO, 'scripts', 'esign-role-maps');
const OUT_FILE = path.join(REPO, 'api', '_assets', 'esign-field-maps.json');

// Asset module (in api/_assets/) each role map was measured against — MUST be
// the same file fill-form.js fills, because the filled PDF esign-create sends
// is produced from it. Verified below against FORM_CONFIGS.getBase64().
const SLUG_TO_ASSET = {
  'financing-addendum': 'trec-financing-40-11-base64.js',
  'hoa-addendum': 'trec-hoa-addendum-36-11-base64.js',
  'amendment': 'trec-amendment-39-11-base64.js',
  'seller-financing': 'trec-seller-financing-base64.js',
  'lead-paint-addendum': 'trec-lead-paint-base64.js',
  'sellers-disclosure': 'trec-sellers-disclosure-55-1-base64.js',
  'appraisal-termination': 'trec-49-1-base64.js',
  'unimproved-property': 'trec-unimproved-property-base64.js',
  'buyers-temp-lease': 'trec-buyers-temp-lease-base64.js',
  'sellers-temp-lease': 'trec-sellers-temp-lease-base64.js',
  'sale-other-property': 'trec-sale-other-property-base64.js',
  'oil-gas-minerals': 'trec-oil-gas-minerals-base64.js',
  'backup-contract': 'trec-backup-contract-base64.js',
  'coastal-area': 'trec-coastal-area-base64.js',
  'hydrostatic-testing': 'trec-hydrostatic-testing-base64.js',
  'environmental': 'trec-environmental-base64.js',
  'short-sale': 'trec-short-sale-base64.js',
  'gulf-waterway': 'trec-gulf-waterway-base64.js',
  'propane-gas': 'trec-propane-gas-base64.js',
  'residential-leases': 'trec-residential-leases-base64.js',
  'fixture-leases': 'trec-fixture-leases-base64.js',
  'loan-assumption': 'trec-loan-assumption-base64.js',
  'improvement-district': 'trec-improvement-district-base64.js',
};

// Party roles = roles that map to a DocuSeal submitter who signs. Everything
// else (property/deal) is fill-engine territory in Mode A.
const PARTY_ROLES = new Set([
  'buyer1', 'buyer2', 'seller1', 'seller2',
  'buyer_agent', 'selling_agent', 'listing_agent', 'escrow_agent',
]);

// Fields with role UNKNOWN normally FAIL the build (plan §1.2: fail loudly,
// never skip silently). Each entry here is a reviewed, named exception —
// a field a human looked at and decided is NOT a Mode-A signing widget, so
// excluding it from the signing overlay is safe. The fill engine still never
// touches it (it stays blank on the PDF).
const ACKNOWLEDGED_UNKNOWN = {
  // 5th checkbox WIDGET in TREC 41-3 ¶A where the printed form shows only 4
  // checkbox items. Deal-area checkbox, not a signing widget; role-map notes
  // say do-not-guess. Left unwired until verified against the live PDF.
  'loan-assumption': ['unmapped_credit_doc_checkbox_5'],
};

const INITIALS_RE = /_initials(?:_as_[a-z_]+)?_p\d+$/;
const DATE_RE = /_(?:signature_)?date$/;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function titleForRole(role) {
  return {
    buyer1: 'Buyer 1', buyer2: 'Buyer 2', seller1: 'Seller 1', seller2: 'Seller 2',
    buyer_agent: "Buyer's Agent", selling_agent: "Buyer's Agent",
    listing_agent: 'Listing Agent', escrow_agent: 'Escrow Agent',
  }[role] || role;
}

// Which DocuSeal widget (if any) a party-owned role-map field becomes in Mode A.
function modeAType(f) {
  if (f.field_type === 'signature') return 'signature';
  if (f.field_type === 'text' && INITIALS_RE.test(f.field_key)) return 'initials';
  if (f.field_type === 'text' && DATE_RE.test(f.field_key)) return 'date';
  return null; // names, notice lines, phone/fax etc. — fill engine bakes these
}

function convertForm(slug, roleMap, assetModule, blankPdfSha256, problems) {
  const roles = {};
  const excluded = [];
  for (const f of roleMap.fields) {
    // Coordinate sanity — these are percentages 0-100 of the page.
    for (const [k, max] of [['x_pct', 100], ['y_pct', 100], ['w_pct', 100], ['h_pct', 100]]) {
      if (typeof f[k] !== 'number' || f[k] < 0 || f[k] > max) {
        problems.push(`${slug}: field ${f.field_key} has bad ${k}=${f[k]}`);
      }
    }
    if (f.x_pct + f.w_pct > 100.5 || f.y_pct + f.h_pct > 100.5) {
      problems.push(`${slug}: field ${f.field_key} extends past page edge`);
    }
    if (!Number.isInteger(f.page) || f.page < 1 || f.page > roleMap.pageCount) {
      problems.push(`${slug}: field ${f.field_key} page ${f.page} outside 1..${roleMap.pageCount}`);
    }

    if (f.role === 'UNKNOWN' || !f.role) {
      const allowed = (ACKNOWLEDGED_UNKNOWN[slug] || []).includes(f.field_key);
      if (!allowed || f.field_type === 'signature') {
        problems.push(`${slug}: UNKNOWN-role field ${f.field_key} (${f.field_type}) — needs a human call before wiring (plan §1.2)`);
      }
      continue;
    }
    if (!PARTY_ROLES.has(f.role)) continue; // property/deal -> fill engine
    const dsType = modeAType(f);
    if (!dsType) { excluded.push(`${f.role}:${f.field_key}`); continue; }

    if (!roles[f.role]) roles[f.role] = [];
    roles[f.role].push({
      name: f.field_key,
      title: `${titleForRole(f.role)} ${dsType === 'signature' ? 'Signature' : dsType === 'initials' ? `Initials P${f.page}` : 'Date'}`,
      type: dsType,
      required: dsType !== 'date', // dates auto-fill on sign; sig/initials mandatory
      ...(dsType === 'date' ? { preferences: { format: 'MM/DD/YYYY' } } : {}),
      areas: [{
        x: +(f.x_pct / 100).toFixed(6),
        y: +(f.y_pct / 100).toFixed(6),
        w: +(f.w_pct / 100).toFixed(6),
        h: +(f.h_pct / 100).toFixed(6),
        page: f.page, // 1-indexed on write to DocuSeal
      }],
    });
  }

  // Structural checks: each of the 4 principal parties must have exactly one
  // signature, on the LAST widget-bearing page of the form.
  for (const r of ['buyer1', 'buyer2', 'seller1', 'seller2']) {
    const sigs = (roles[r] || []).filter((x) => x.type === 'signature');
    if (sigs.length !== 1) {
      problems.push(`${slug}: role ${r} has ${sigs.length} signature fields (expected exactly 1)`);
    }
  }
  // No two emitted widgets may share the same rect (cross-assignment trap).
  const seen = new Map();
  for (const [r, list] of Object.entries(roles)) {
    for (const f of list) {
      const a = f.areas[0];
      const key = `${a.page}:${a.x.toFixed(4)}:${a.y.toFixed(4)}`;
      if (seen.has(key)) problems.push(`${slug}: ${r}:${f.name} shares a rect with ${seen.get(key)}`);
      seen.set(key, `${r}:${f.name}`);
    }
  }

  const expected = {};
  for (const [r, list] of Object.entries(roles)) expected[r] = list.length;

  return {
    form_type: slug,
    trec_no: roleMap.trecNo || null,
    page_count: roleMap.pageCount,
    mode: 'A',
    asset_module: assetModule,
    blank_pdf_sha256: blankPdfSha256,
    source_role_map: `scripts/esign-role-maps/${slug}.json`,
    source_role_map_generated_at: roleMap.generated_at || null,
    roles,
    expected_field_count_per_role: expected,
    excluded_party_fields: excluded, // party-owned but baked by fill engine
  };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const problems = [];

  // FORM_CONFIGS is the authority on documentType + which asset gets filled.
  const { FORM_CONFIGS } = require(path.join(REPO, 'api', 'fill-form.js')).__testing;

  const forms = {};
  const documentTypeIndex = {};
  const files = fs.readdirSync(ROLE_MAP_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`no role maps found in ${ROLE_MAP_DIR}`);

  for (const file of files) {
    const slug = file.replace(/\.json$/, '');
    const roleMap = JSON.parse(fs.readFileSync(path.join(ROLE_MAP_DIR, file), 'utf8'));
    if (roleMap.form_type !== slug) {
      problems.push(`${file}: form_type "${roleMap.form_type}" does not match filename`);
      continue;
    }
    const cfg = FORM_CONFIGS[slug];
    if (!cfg) { problems.push(`${slug}: not in fill-form FORM_CONFIGS`); continue; }
    const assetModule = SLUG_TO_ASSET[slug];
    if (!assetModule) { problems.push(`${slug}: no SLUG_TO_ASSET entry`); continue; }

    // Verify the named asset is byte-identical to what fill-form fills.
    const b64Str = (m) => (typeof m === 'string' ? m : (m && (m.base64Pdf || m.base64 || m.b64)));
    const assetStr = b64Str(require(path.join(REPO, 'api', '_assets', assetModule)));
    const cfgStr = b64Str(cfg.getBase64());
    if (typeof assetStr !== 'string' || typeof cfgStr !== 'string') {
      problems.push(`${slug}: could not extract base64 string from asset/config module`);
      continue;
    }
    if (assetStr !== cfgStr) {
      problems.push(`${slug}: SLUG_TO_ASSET names ${assetModule} but fill-form fills a DIFFERENT pdf — fix the table`);
      continue;
    }
    const blankPdfSha256 = sha256(Buffer.from(assetStr, 'base64'));

    const entry = convertForm(slug, roleMap, assetModule, blankPdfSha256, problems);
    entry.document_type = cfg.documentType;
    forms[slug] = entry;
    documentTypeIndex[cfg.documentType] = slug;
  }

  if (problems.length) {
    console.error(`BUILD FAILED — ${problems.length} problem(s):`);
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  const out = {
    _readme: 'GENERATED by scripts/build-esign-field-maps.js — do not hand-edit. '
      + 'Regenerate after any role-map or blank-asset change. Coordinates are '
      + 'top-left-origin fractions 0-1; areas[].page is 1-indexed (DocuSeal write convention).',
    schema_version: 1,
    forms,
    document_type_index: documentTypeIndex,
  };
  const json = JSON.stringify(out, null, 1) + '\n';

  if (checkOnly) {
    const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
    if (existing !== json) {
      console.error('CHECK FAILED: api/_assets/esign-field-maps.json is stale — rerun scripts/build-esign-field-maps.js');
      process.exit(1);
    }
    console.log(`CHECK OK — ${Object.keys(forms).length} forms, output up to date.`);
    return;
  }

  fs.writeFileSync(OUT_FILE, json);
  let widgetTotal = 0;
  for (const f of Object.values(forms)) {
    widgetTotal += Object.values(f.expected_field_count_per_role).reduce((a, b) => a + b, 0);
  }
  console.log(`Wrote ${OUT_FILE}: ${Object.keys(forms).length} forms, ${widgetTotal} signing widgets.`);
  for (const [slug, f] of Object.entries(forms)) {
    console.log(`  ${slug.padEnd(24)} ${JSON.stringify(f.expected_field_count_per_role)}`);
  }
}

main();
