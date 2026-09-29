/**
 * scripts/artifact-integrity-check.js
 *
 * Heath's source of truth for the TREC 20-18 validator + rules lives at:
 *   - scripts/trec-validator.js
 *   - scripts/trec-20-18-field-rules.json
 *
 * For Vercel deployment we keep BYTE-IDENTICAL copies at api/_lib/ so the
 * serverless function bundle doesn't pull in the whole 217 MB scripts/
 * directory (atlas-runs/, trec-forms/, etc.) via Vercel's NFT tracer.
 *
 * This script verifies the copies match the source of truth. CI blocks any
 * PR where they drift.
 *
 * Exit code: 0 if matched, 1 if drift.
 *
 * To re-sync after Heath updates a source-of-truth artifact:
 *   cp scripts/trec-validator.js api/_lib/trec-validator.js
 *   cp scripts/trec-20-18-field-rules.json api/_lib/trec-20-18-field-rules.json
 *   node scripts/artifact-integrity-check.js   # should print MATCH
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function sha(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function check(srcPath, copyPath) {
  if (!fs.existsSync(srcPath)) {
    console.error(`MISSING source: ${srcPath}`);
    return false;
  }
  if (!fs.existsSync(copyPath)) {
    console.error(`MISSING copy:   ${copyPath}`);
    return false;
  }
  const s = sha(srcPath);
  const c = sha(copyPath);
  if (s !== c) {
    console.error(`DRIFT: ${path.relative(process.cwd(), srcPath)} != ${path.relative(process.cwd(), copyPath)}`);
    console.error(`  source sha256: ${s}`);
    console.error(`  copy   sha256: ${c}`);
    console.error('  Re-sync with:  cp -f "' + srcPath + '" "' + copyPath + '"');
    return false;
  }
  console.log(`MATCH: ${path.relative(process.cwd(), srcPath)}  ==  ${path.relative(process.cwd(), copyPath)}`);
  return true;
}

const repoRoot = path.resolve(__dirname, '..');

const pairs = [
  [
    path.join(repoRoot, 'scripts', 'trec-validator.js'),
    path.join(repoRoot, 'api', '_lib', 'trec-validator.js'),
  ],
  [
    path.join(repoRoot, 'scripts', 'trec-20-18-field-rules.json'),
    path.join(repoRoot, 'api', '_lib', 'trec-20-18-field-rules.json'),
  ],
];

let allOK = true;
for (const [src, copy] of pairs) {
  if (!check(src, copy)) allOK = false;
}

console.log(allOK ? 'INTEGRITY: ALL GOOD' : 'INTEGRITY: DRIFT DETECTED');
process.exit(allOK ? 0 : 1);
