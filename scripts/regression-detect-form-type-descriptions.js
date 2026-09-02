#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-01 CARTER fix to api/detect-form-type.js:
 * FORM_TYPE_DESCRIPTIONS (the reference list the AI classifier uses to route
 * an uploaded document to a fill handler) had mislabeled 20 of 28 entries.
 * Confirmed examples:
 *   - improvement-district described as TREC 34-6 "Seaward of the Gulf
 *     Intracoastal Waterway" (asset is TREC 53-0, Improvement District
 *     Assessment notice)
 *   - oil-gas-minerals described as "Right to Terminate Due to Lender's
 *     Appraisal" (that is TREC 49-1; asset is the 44-3 mineral reservation)
 *   - buyers/sellers temp-lease numbers swapped (16-7 is BUYER's, 15-7 is
 *     SELLER's)
 *   - three keys (wire-fraud-advisory, buyer-rep, buyer-termination) that do
 *     not exist in fill-form.js FORM_CONFIGS at all
 * A wrong description routes a member's upload to the wrong fill handler.
 *
 * This test extracts FORM_TYPE_DESCRIPTIONS from the detect-form-type.js
 * source (string parse, so it runs against pre-fix code too), then for every
 * listed key:
 *   1. asserts the key exists in fill-form.js FORM_CONFIGS ("unknown" exempt),
 *   2. decodes the exact asset FORM_CONFIGS loads, runs pdftotext on page 1,
 *   3. asserts the described form number appears verbatim on the page,
 *   4. asserts every significant word of the described title appears in the
 *      page text.
 * Also asserts every FORM_CONFIGS key is present in the description list
 * (the old list was missing appraisal-termination, seller-financing,
 * gulf-waterway, fixture-leases).
 *
 * Run manually:
 *   node scripts/regression-detect-form-type-descriptions.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const { FORM_CONFIGS } = require(path.join(REPO, 'api/fill-form.js')).__testing;

// buyer-rep-agreement's asset is a placeholder PDF ("PLACEHOLDER - Official
// PDF asset not yet installed", flagged in fill-form.js). Its page text
// carries the form number (1501) but not the full official title, so the
// title-word check is relaxed to the words the placeholder does print.
const TITLE_CHECK_OVERRIDES = {
  'buyer-rep-agreement': ['BUYER', 'REPRESENTATION', 'AGREEMENT'],
};

const STOP_WORDS = new Set(['THAT', 'WITH', 'FROM', 'THIS', 'INTO', 'ONLY']);

function extractDescriptions() {
  const src = fs.readFileSync(path.join(REPO, 'api/detect-form-type.js'), 'utf8');
  const m = src.match(/const FORM_TYPE_DESCRIPTIONS = `([\s\S]*?)`;/);
  assert.ok(m, 'FORM_TYPE_DESCRIPTIONS template literal not found in api/detect-form-type.js');
  const entries = [];
  for (const line of m[1].split('\n')) {
    const em = line.match(/^\s*- ([a-z0-9-]+):\s*([^,]+),\s*"([^"]+)"/);
    if (em) entries.push({ key: em[1], numberSegment: em[2].trim(), title: em[3] });
  }
  assert.ok(entries.length > 5, 'expected to parse form-type entries from the list');
  return entries;
}

function formNumberToken(numberSegment) {
  // e.g. "TREC 20-19" -> "20-19"; "TREC 55-1 (formerly OP-H)" -> "55-1";
  //      "TXR 2517" -> "2517"; "T-47" -> "T-47"
  const m = numberSegment.match(/\b(T-47|\d+-\d+|\d{4})\b/);
  return m ? m[1] : null;
}

function decodeConfigAsset(key) {
  const raw = FORM_CONFIGS[key].getBase64();
  const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
  return Buffer.from(base64, 'base64');
}

function pdftotextFirstPage(pdfBytes, key) {
  const tmp = path.join(os.tmpdir(), `regression-dft-${key}-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, pdfBytes);
  try {
    return execSync(`pdftotext -f 1 -l 1 "${tmp}" -`).toString();
  } finally {
    fs.unlinkSync(tmp);
  }
}

function collapse(s) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function significantTitleWords(title) {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, '')      // drop apostrophes/commas, keep hyphens for now
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Z0-9]/g, '')) // BACK-UP -> BACKUP, LEAD-BASED -> LEADBASED
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

async function main() {
  console.log('detect-form-type FORM_TYPE_DESCRIPTIONS regression — descriptions must match the real assets');
  console.log('==========================================================================================');

  const entries = extractDescriptions();
  const listedKeys = new Set(entries.map((e) => e.key));
  let failed = 0;
  const check = (cond, label, detail) => {
    if (cond) return;
    failed++;
    console.error(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  };

  // 1. Every FORM_CONFIGS key must be represented in the description list.
  for (const key of Object.keys(FORM_CONFIGS)) {
    check(listedKeys.has(key), `FORM_CONFIGS key "${key}" missing from FORM_TYPE_DESCRIPTIONS`);
  }

  // 2. Every listed key must exist in FORM_CONFIGS, and its description must
  //    match the page-1 text of the asset FORM_CONFIGS actually loads.
  for (const { key, numberSegment, title } of entries) {
    if (key === 'unknown') continue;
    if (!FORM_CONFIGS[key]) {
      failed++;
      console.error(`  FAIL: listed key "${key}" does not exist in fill-form.js FORM_CONFIGS`);
      continue;
    }
    const pageText = pdftotextFirstPage(decodeConfigAsset(key), key);
    const collapsed = collapse(pageText);

    const token = formNumberToken(numberSegment);
    check(Boolean(token), `${key}: could not parse a form number from "${numberSegment}"`);
    if (token) {
      check(
        pageText.toUpperCase().includes(token.toUpperCase()),
        `${key}: form number "${token}" not found on the asset's page 1`,
        `described as "${numberSegment}"`
      );
    }

    const words = TITLE_CHECK_OVERRIDES[key] || significantTitleWords(title);
    for (const word of words) {
      check(
        collapsed.includes(word),
        `${key}: title word "${word}" not found on the asset's page 1`,
        `described title: "${title}"`
      );
    }
  }

  console.log(`\nChecked ${entries.length} listed entries against ${Object.keys(FORM_CONFIGS).length} FORM_CONFIGS assets.`);
  console.log('==========================================================================================');
  if (failed) {
    console.log(failed + ' check(s) FAILED');
    process.exit(1);
  }
  console.log('All checks passed');
}

main().catch((e) => {
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
});
