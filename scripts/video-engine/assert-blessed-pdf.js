'use strict';

// scripts/video-engine/assert-blessed-pdf.js
//
// THE guard against rendering a real transaction document into video output.
//
// INCIDENT (2026-09-30): while building a video, an agent reached for
// .tmp/quinn-downloaded-20-19.pdf as the on-screen contract background. That
// file was a FILLED contract — real property address, title company, earnest
// money figure. Caught on visual inspection before anything shipped, but
// nothing in the code would have stopped it. Real/filled transaction
// documents were quarantined out of .tmp/ and scripts/trec-forms/ into
// .private-transaction-docs/ (gitignored, outside every pipeline's reach) —
// see docs/VIDEO-RULES.md "Document source of truth" and
// docs/INCIDENT-LOG.md.
//
// This module is the durable fix: every PDF path that reaches pdftoppm on
// the video-render path MUST be asserted here first. Two layers, in order:
//
//   1. PATH ALLOWLIST (primary). The resolved, real (symlink-free) path must
//      sit inside scripts/trec-forms/ — the single blessed, blank-only
//      source directory. Anything outside it fails closed, regardless of
//      filename, regardless of what the file actually contains. This is
//      what makes the guard hold even if scripts/trec-forms/ is ever
//      contaminated by a mistake elsewhere.
//
//   2. CONTENT CHECK (backstop). Even a blessed-path PDF is scanned with
//      pdftotext for the signature of a FILLED form: a real "<number>
//      <Street>, <City>, TX" address, or a completed dollar figure
//      ("$ 123,456" — TREC forms print the "$" and blank space, filled ones
//      have a real number after it). A genuinely blank promulgated TREC
//      form has neither — verified empirically against all 12 files
//      currently in scripts/trec-forms/ (zero false positives) and against
//      the incident file (caught: "987 Magnolia Creek Dr, San Antonio, TX"
//      and "$ 7,200"). This catches a mistake where someone *overwrites* a
//      blessed filename with filled content instead of adding a new path.
//
// Call assertBlessedPdf(pdfPath) before every pdftoppm/pdftotext call that
// feeds video output. Throws a loud, specific Error on failure — never
// returns a partial/degraded result.
//
// Usage:
//   const { assertBlessedPdf } = require('./assert-blessed-pdf.js');
//   const safePdf = assertBlessedPdf(cfg.pdf); // throws or returns resolved path

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BLESSED_DIR = fs.realpathSync(path.join(REPO_ROOT, 'scripts', 'trec-forms'));

// Filled-address signature: "<digits> <Street words>, <City>, TX|Texas".
// A blank TREC form only ever prints the label "(Street Address and City)" —
// no digits, no comma-separated city/state pair.
const FILLED_ADDRESS_RE = /\b\d{1,6} [A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*, *[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*, *(?:TX|Texas)\b/;

// Filled dollar figure: "$" (optionally followed by a space, which is how
// TREC prints the blank line) then an actual digit run. Blank forms print
// "$" with nothing but whitespace/underscores after it.
const FILLED_DOLLAR_RE = /\$ ?[0-9][0-9,]{2,}/;

function readPdfText(absPath, { maxPages = 6 } = {}) {
  const res = spawnSync('pdftotext', ['-f', '1', '-l', String(maxPages), absPath, '-'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(
      `assertBlessedPdf: could not read "${absPath}" with pdftotext (exit ${res.status}): ${res.stderr || res.stdout}`
    );
  }
  return res.stdout || '';
}

/**
 * assertBlessedPdf — throws if `pdfPath` is not a blank specimen form inside
 * the single blessed directory. Returns the resolved absolute path on success
 * so callers can use it directly.
 */
function assertBlessedPdf(pdfPath) {
  if (!pdfPath || typeof pdfPath !== 'string') {
    throw new Error(`assertBlessedPdf: no pdf path given (got ${JSON.stringify(pdfPath)})`);
  }
  const absInput = path.resolve(pdfPath);
  if (!fs.existsSync(absInput)) {
    throw new Error(`assertBlessedPdf: file does not exist: ${absInput}`);
  }

  // Resolve symlinks so a symlink inside trec-forms/ pointing outside it
  // (or vice versa) can't be used to smuggle a path past the prefix check.
  const real = fs.realpathSync(absInput);

  // ── Layer 1: path allowlist ──────────────────────────────────────────
  const rel = path.relative(BLESSED_DIR, real);
  const isInsideBlessed = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!isInsideBlessed) {
    throw new Error(
      `REFUSING TO RENDER: "${pdfPath}" resolves to ${real}, which is outside the ` +
      `blessed video-source directory (${BLESSED_DIR}). Only blank TREC specimen ` +
      `forms in scripts/trec-forms/ may ever appear on camera. If this is genuinely ` +
      `a blank form, add it to scripts/trec-forms/ (not anywhere else) and re-run. ` +
      `See docs/VIDEO-RULES.md "Document source of truth" and docs/INCIDENT-LOG.md ` +
      `for why this is enforced, not advisory.`
    );
  }

  // ── Layer 2: content backstop ────────────────────────────────────────
  const text = readPdfText(real);
  const addrMatch = text.match(FILLED_ADDRESS_RE);
  const dollarMatch = text.match(FILLED_DOLLAR_RE);
  if (addrMatch || dollarMatch) {
    const reasons = [];
    if (addrMatch) reasons.push('a filled street address');
    if (dollarMatch) reasons.push('a filled dollar figure');
    throw new Error(
      `REFUSING TO RENDER: "${real}" is inside the blessed directory but its content ` +
      `looks FILLED, not blank (found ${reasons.join(' and ')}). A blank promulgated ` +
      `TREC form has no real address or completed dollar amount. This file may have ` +
      `been overwritten with real data — do not render it. Restore the blank specimen ` +
      `and move any filled copy to .private-transaction-docs/. See docs/VIDEO-RULES.md.`
    );
  }

  return real;
}

module.exports = { assertBlessedPdf, BLESSED_DIR, FILLED_ADDRESS_RE, FILLED_DOLLAR_RE };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node assert-blessed-pdf.js <path-to-pdf>');
    process.exit(1);
  }
  try {
    const ok = assertBlessedPdf(target);
    console.log(`OK: ${ok}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
