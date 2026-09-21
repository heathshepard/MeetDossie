#!/usr/bin/env node
// scripts/regression-base64-asset-shapes.js
//
// 2026-09-21 CARTER — trec-unimproved-property-base64.js exports
// { base64Pdf: '...' } instead of a plain string. fill-form.js already
// normalized this shape inline; api/_lib/resolve-blank-template-pdf.js and
// api/dossiesign-prepare.js did not, and both silently returned null for
// unimproved-property (no crash — a live form a member could reach just
// quietly failed to resolve). All three now share
// api/_lib/base64-asset.js's extractBase64().
//
// This guards two different things a future asset change could break:
//   1. every api/_assets/*-base64.js module resolves to a real base64
//      PDF string via extractBase64() (catches a NEW shape mismatch before
//      it ships, not after a send fails).
//   2. every loader actually WIRED into the three production consumers
//      (fill-form.js FORM_CONFIGS, resolve-blank-template-pdf.js
//      FORM_TEMPLATE_B64, dossiesign-prepare.js FORM_B64_MAP) resolves to a
//      real, pdf-lib-loadable PDF when invoked THROUGH that consumer's own
//      code path — not just that the raw asset file is fine in isolation.
//
// Run with: node scripts/regression-base64-asset-shapes.js

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const REPO = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO, 'api', '_assets');
const { extractBase64 } = require(path.join(REPO, 'api', '_lib', 'base64-asset.js'));

let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// Resolves every loader in a { slug: () => require(...) } map and reports
// any that don't come back as a real, pdf-lib-loadable PDF.
async function checkLoaderMap(map, mapLabel) {
  const bad = [];
  for (const [slug, loader] of Object.entries(map)) {
    let b64;
    try {
      b64 = extractBase64(loader());
    } catch (err) {
      bad.push(`${slug}: loader threw — ${err.message}`);
      continue;
    }
    if (!b64) { bad.push(`${slug}: loader resolved to null/unrecognized shape`); continue; }
    try {
      await PDFDocument.load(Buffer.from(b64, 'base64'), { ignoreEncryption: true });
    } catch (err) {
      bad.push(`${slug}: pdf-lib could not load the decoded bytes — ${err.message}`);
    }
  }
  if (bad.length) throw new Error(`${mapLabel}: ${bad.join('; ')}`);
}

async function main() {
  console.log('regression-base64-asset-shapes');

  const assetFiles = fs.readdirSync(ASSETS_DIR).filter((f) => f.endsWith('-base64.js'));

  await check(`1. all ${assetFiles.length} api/_assets/*-base64.js modules resolve to a base64 string via extractBase64()`, () => {
    const bad = [];
    for (const file of assetFiles) {
      const mod = require(path.join(ASSETS_DIR, file));
      const b64 = extractBase64(mod);
      if (!b64 || b64.length < 100) bad.push(file);
    }
    if (bad.length) throw new Error(`unrecognized/empty export shape: ${bad.join(', ')}`);
  });

  await check('2. every resolved string decodes to real PDF bytes (magic-header sanity)', () => {
    const bad = [];
    for (const file of assetFiles) {
      const mod = require(path.join(ASSETS_DIR, file));
      const b64 = extractBase64(mod);
      if (!b64) continue; // already flagged by check 1
      const buf = Buffer.from(b64, 'base64');
      if (buf.slice(0, 5).toString('latin1') !== '%PDF-') bad.push(file);
    }
    if (bad.length) throw new Error(`decoded bytes do not start with the PDF magic header: ${bad.join(', ')}`);
  });

  await check('3. api/_lib/resolve-blank-template-pdf.js: every FORM_TEMPLATE_B64 loader resolves + loads', async () => {
    const { FORM_TEMPLATE_B64 } = require(path.join(REPO, 'api', '_lib', 'resolve-blank-template-pdf.js'));
    if (!FORM_TEMPLATE_B64) throw new Error('FORM_TEMPLATE_B64 not exported — update this check if the export contract changes');
    await checkLoaderMap(FORM_TEMPLATE_B64, 'FORM_TEMPLATE_B64');
  });

  await check('4. api/dossiesign-prepare.js: every FORM_B64_MAP loader resolves + loads', async () => {
    const mod = require(path.join(REPO, 'api', 'dossiesign-prepare.js'));
    const map = mod.__testing && mod.__testing.FORM_B64_MAP;
    if (!map) throw new Error('FORM_B64_MAP not exposed via __testing — update this check if the export contract changes');
    await checkLoaderMap(map, 'FORM_B64_MAP');
  });

  await check('5. api/fill-form.js: every legacy FORM_CONFIGS.getBase64() resolves + loads', async () => {
    const { FORM_CONFIGS } = require(path.join(REPO, 'api', 'fill-form.js')).__testing;
    const loaderMap = {};
    for (const [slug, cfg] of Object.entries(FORM_CONFIGS)) {
      if (typeof cfg.getBase64 === 'function') loaderMap[slug] = cfg.getBase64;
    }
    await checkLoaderMap(loaderMap, 'FORM_CONFIGS');
  });

  if (failed) {
    console.error(`\n${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nAll checks passed');
}

main();
