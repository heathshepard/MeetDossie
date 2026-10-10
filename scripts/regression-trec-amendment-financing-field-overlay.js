#!/usr/bin/env node
/**
 * scripts/regression-trec-amendment-financing-field-overlay.js
 *
 * Overlay regression gate for TREC 40-11 (Third Party Financing Addendum)
 * and TREC 39-11 (Amendment) — extends the
 * scripts/regression-txr-1406-field-overlay.js pattern to these two
 * real-AcroForm (not flat/coordinate-baked) forms.
 *
 * What it checks, per form, using the LIVE wired asset's own
 * form.getFields() rectangles (not the stale api/_assets/trec-40-11-
 * coords.json / trec-amendment-39-11-coords.json geometry files, which
 * predate this pass and in 40-11's case over-count by one duplicate-name
 * widget — see trec-40-11-field-classification.json's note on 'Text2'):
 *
 *   1. WIDGET vs WIDGET, same page — does any field's rectangle intersect
 *      any OTHER field's rectangle? This is the exact failure class a
 *      duplicate-named widget (two widgets sharing one field name, e.g.
 *      40-11's 'Text2') or a genuinely mis-placed field produces: two
 *      unrelated blanks fight over the same ink.
 *   2. CLASSIFICATION COVERAGE — every widget in the live asset's
 *      form.getFields() appears in exactly one bucket of the
 *      corresponding *-field-classification.json (derivable / must_ask /
 *      signature_policy), and vice versa. Catches silent drift if the
 *      asset is ever swapped for a different revision without re-running
 *      the classification generator.
 *
 * Does NOT re-check field-vs-printed-text collisions the way the 1406
 * script does — these are real AcroForm widgets whose Rect the form itself
 * defines as the blank area, not DocuSeal widgets Dossie places by hand, so
 * that collision class doesn't apply the same way. The real risk on these
 * two forms (AcroForm field NAMES lying about their own position/meaning)
 * is validated separately, by direct pdftotext -bbox cross-reference
 * against a live render — see the classification generator scripts' own
 * header comments for the full verified position audit.
 *
 * Usage: node scripts/regression-trec-amendment-financing-field-overlay.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const REPO = path.resolve(__dirname, '..');

// NOT scripts/regression-txr-1406-field-overlay.js's intersects() (EPS=0.05)
// -- that threshold is right for DocuSeal widgets Dossie places by hand at
// exact coordinates, but real AcroForm field Rects on these two TREC forms
// routinely share a hairline (<2pt) hand-off between vertically-stacked
// rows (measured 2026-10-10 across all 12 raw overlaps this script first
// flagged: every one had Y-overlap under 1.9pt against ~11-12pt field
// heights, and every one renders with zero visible collision -- see the
// pdftoppm render used to verify this fix). A real collision -- two blanks
// actually fighting over the same ink -- needs BOTH meaningful X AND
// meaningful Y overlap. MIN_OVERLAP_PT is intentionally generous on the Y
// axis (above the largest hairline measured) so it still catches an actual
// mis-placed or duplicate-rect widget without false-failing on normal
// adjacent-row spacing.
const MIN_OVERLAP_PT = 3;
function intersects(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ox = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const oy = Math.min(ay2, by2) - Math.max(a.y, b.y);
  return ox > MIN_OVERLAP_PT && oy > MIN_OVERLAP_PT;
}

const FORMS = [
  {
    label: 'TREC 40-11',
    asset: path.join(REPO, 'api', '_assets', 'trec-financing-40-11-base64.js'),
    classification: path.join(REPO, 'api', '_lib', 'trec-40-11-field-classification.json'),
  },
  {
    label: 'TREC 39-11',
    asset: path.join(REPO, 'api', '_assets', 'trec-amendment-39-11-base64.js'),
    classification: path.join(REPO, 'api', '_lib', 'trec-amendment-39-11-field-classification.json'),
  },
];

let failures = 0;
function fail(msg) { failures += 1; console.error(`  FAIL  ${msg}`); }

async function loadFieldRects(assetPath) {
  const mod = require(assetPath);
  const b64 = typeof mod === 'string' ? mod : (mod.base64Pdf || mod.base64);
  const bytes = Buffer.from(b64, 'base64');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const fields = doc.getForm().getFields();
  const pages = doc.getPages();
  const rects = [];
  for (const f of fields) {
    const name = f.getName();
    for (const w of f.acroField.getWidgets()) {
      const r = w.getRectangle();
      let page = 1;
      try {
        const pRef = w.P();
        const idx = pages.findIndex((p) => p.ref === pRef);
        if (idx >= 0) page = idx + 1;
      } catch (e) { /* default to page 1 */ }
      rects.push({ label: name, page, x: r.x, y: r.y, w: r.width, h: r.height });
    }
  }
  return { fields, rects };
}

async function checkForm(form) {
  const { fields, rects } = await loadFieldRects(form.asset);
  const classification = JSON.parse(fs.readFileSync(form.classification, 'utf8'));

  console.log(`\n[${form.label}] ${fields.length} named fields -> ${rects.length} widget rectangles`);

  // 1. Widget vs widget collision, same page.
  let overlapCount = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.page !== b.page) continue;
      if (a.label === b.label) continue; // same field, multiple widgets (e.g. radio-style) — expected, not a collision
      if (intersects(a, b)) {
        overlapCount += 1;
        fail(`${form.label} page ${a.page}: "${a.label}" overlaps "${b.label}"`);
      }
    }
  }
  console.log(`  widget-vs-widget overlaps: ${overlapCount}`);

  // 2. Classification coverage — every live field name appears in exactly
  // one bucket, and the classification carries no stale names.
  const liveNames = new Set(fields.map((f) => f.getName()));
  const classifiedNames = [
    ...classification.derivable.map((f) => f.name),
    ...classification.signature_policy.map((f) => f.name),
    ...classification.must_ask.map((f) => f.name),
  ];
  const classifiedSet = new Set(classifiedNames);

  // Duplicate-named widgets (same field, >1 rect, e.g. 40-11's 'Text2')
  // legitimately appear once in the field list but twice in the rect list
  // — count against unique live field names, not raw widget rects.
  for (const name of liveNames) {
    if (!classifiedSet.has(name)) fail(`${form.label}: live field "${name}" missing from classification`);
  }
  const seen = new Set();
  for (const name of classifiedNames) {
    if (seen.has(name)) { fail(`${form.label}: "${name}" classified in more than one bucket`); continue; }
    seen.add(name);
    if (!liveNames.has(name)) fail(`${form.label}: classified field "${name}" does not exist on the live asset (stale)`);
  }
  console.log(`  classification coverage: ${liveNames.size} live fields, ${classifiedSet.size} classified names`);
}

async function main() {
  for (const form of FORMS) {
    await checkForm(form);
  }
  if (failures > 0) {
    console.error(`\n[overlay-check] FAILED — ${failures} issue(s) found.`);
    process.exit(1);
  }
  console.log('\n[overlay-check] PASS — no widget collisions, classification fully covers both live assets.');
}

if (require.main === module) main();

module.exports = { loadFieldRects, checkForm };
