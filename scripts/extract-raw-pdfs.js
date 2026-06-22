#!/usr/bin/env node
// Extract base64 PDF files into raw .pdf files for the associator.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'api', '_assets');

const FORMS = [
  { id: 'trec-40',      base64: 'trec-financing-base64.js',         outRaw: 'trec-40-raw.pdf' },
  { id: 'trec-39-10',   base64: 'trec-39-10-base64.js',             outRaw: 'trec-39-10-raw.pdf' },
  { id: 'op-h',         base64: 'trec-sellers-disclosure-base64.js', outRaw: 'op-h-raw.pdf' },
  { id: 'trec-36-11',   base64: 'trec-hoa-addendum-36-11-base64.js', outRaw: 'trec-36-11-raw.pdf' },
  { id: 'trec-38-7',    base64: 'trec-termination-base64.js',        outRaw: 'trec-38-7-raw.pdf' },
  { id: 'op-l',         base64: 'trec-lead-paint-base64.js',         outRaw: 'op-l-raw.pdf' },
];

for (const f of FORMS) {
  const b64src = path.join(ASSETS, f.base64);
  const outPath = path.join(ASSETS, f.outRaw);
  if (!fs.existsSync(b64src)) {
    console.error(`MISSING: ${b64src}`);
    process.exit(1);
  }
  // base64 files are: module.exports = '...';
  const src = fs.readFileSync(b64src, 'utf8');
  // strip BOM if present
  const clean = src.replace(/^﻿/, '');
  // Parse: extract the literal between quotes
  const m = clean.match(/=\s*['"]([A-Za-z0-9+/=]+)['"]/);
  if (!m) {
    console.error(`Could not parse base64 from ${f.base64}`);
    process.exit(1);
  }
  const buf = Buffer.from(m[1], 'base64');
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath} (${(buf.length / 1024).toFixed(1)} KB) from ${f.base64}`);
}
