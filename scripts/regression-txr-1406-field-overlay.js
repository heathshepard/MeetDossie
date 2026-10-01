#!/usr/bin/env node
// scripts/regression-txr-1406-field-overlay.js
//
// Overlay regression gate for the TXR-1406 Seller's Disclosure field map
// (api/_assets/field-maps/txr-1406-sellers-disclosure-docuseal-fields.json).
//
// Why this exists (2026-10-01, 702 Fawndale): rendering each page and
// reading it caught MISSING fields but not COLLISIONS. A field positioned
// wherever "roughly looked right" silently sat on top of the form's own
// preprinted choice text ("__ electric __ gas  number of units:") making
// both unreadable, and in one case a text field covered a Y/N radio bubble
// so it couldn't be clicked. Per the acroform-field-names-lie method, field
// placement must be checked against the REAL rendered page, not assumed —
// this script makes that check mechanical and permanent instead of a one-time
// manual look.
//
// What it checks, for every field (and every radio option, each of which is
// its own clickable rectangle):
//   1. FIELD vs PRINTED TEXT — does the field rectangle intersect any word's
//      ink bounding box on the same page? (api/_assets/field-maps/
//      txr-1406-printed-text-bbox.json, generated once via
//      `pdftotext -bbox` against the genuine blank PDF — see "regenerate"
//      below. Committed as a fixture so this check has zero runtime
//      dependency on poppler being installed.)
//   2. FIELD vs FIELD — does the field rectangle intersect any OTHER field's
//      (or radio option's) rectangle on the same page?
//
// Coordinate convention (matches scripts/build-txr-1406-packet.js toArea()
// and api/_assets/txr-1406-printed-text-bbox.json): x/y is the
// TOP-LEFT corner in PDF points on a 612x792 page, y increasing DOWNWARD
// from the top edge. w/h are width/height in points.
//
// Regenerate the printed-text fixture (only needed if the underlying blank
// PDF asset changes — api/_assets/txr-1406-sellers-disclosure-base64.js):
//   for p in 1 2 3 4 5 6 7; do pdftotext -bbox -f $p -l $p <(node -e "
//     process.stdout.write(Buffer.from(require('./api/_assets/txr-1406-sellers-disclosure-base64.js').base64Pdf,'base64'))
//   ") page$p.bbox.html; done
//   then re-run the parse step in this file's git history / HANDOFF notes.
//
// Usage: node scripts/regression-txr-1406-field-overlay.js

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIELD_MAP_PATH = path.join(REPO, 'api', '_assets', 'field-maps', 'txr-1406-sellers-disclosure-docuseal-fields.json');
const TEXT_BBOX_PATH = path.join(REPO, 'api', '_assets', 'txr-1406-printed-text-bbox.json');

let failures = 0;
function fail(msg) { failures += 1; console.error(`  FAIL  ${msg}`); }

// Rectangles overlap if they share positive area on both axes. A small
// epsilon avoids flagging rectangles that only share an edge (touching,
// not overlapping) as a false positive.
const EPS = 0.05;
function intersects(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx2 = b.x + b.w, by2 = b.y + b.h;
  const ox = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const oy = Math.min(ay2, by2) - Math.max(a.y, b.y);
  return ox > EPS && oy > EPS;
}

function fieldRects(field) {
  // Returns a list of { label, page, x, y, w, h } — one per clickable area.
  if (field.type === 'radio') {
    return field.options.map((o) => ({
      label: `${field.name} [${o.value}]`,
      page: field.page,
      x: o.x, y: o.y, w: o.w, h: o.h,
    }));
  }
  return [{ label: field.name, page: field.page, x: field.x, y: field.y, w: field.w, h: field.h }];
}

function main() {
  const { fields } = JSON.parse(fs.readFileSync(FIELD_MAP_PATH, 'utf8'));
  const textByPage = JSON.parse(fs.readFileSync(TEXT_BBOX_PATH, 'utf8'));

  const rects = fields.flatMap(fieldRects);
  console.log(`[overlay-check] ${fields.length} fields -> ${rects.length} clickable rectangles across ${new Set(rects.map((r) => r.page)).size} pages`);

  // 1. Field vs printed text.
  let textOverlaps = 0;
  for (const r of rects) {
    const words = textByPage[String(r.page)] || [];
    for (const w of words) {
      if (!w.t || !w.t.trim()) continue;
      const wordRect = { x: w.x, y: w.y, w: w.x2 - w.x, h: w.y2 - w.y };
      if (intersects(r, wordRect)) {
        textOverlaps += 1;
        fail(`page ${r.page}: "${r.label}" overlaps printed text "${w.t}" at (${w.x.toFixed(1)},${w.y.toFixed(1)})`);
      }
    }
  }

  // 2. Field vs field (same page only; pairwise, each pair reported once).
  let fieldOverlaps = 0;
  const byPage = new Map();
  for (const r of rects) {
    if (!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }
  for (const [page, list] of byPage) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].label === list[j].label) continue; // same field, different option areas never overlap each other by construction, but skip self-pairs defensively
        if (intersects(list[i], list[j])) {
          fieldOverlaps += 1;
          fail(`page ${page}: "${list[i].label}" overlaps field "${list[j].label}"`);
        }
      }
    }
  }

  console.log(`[overlay-check] text overlaps: ${textOverlaps}, field-vs-field overlaps: ${fieldOverlaps}`);
  if (failures > 0) {
    console.error(`\n[overlay-check] FAILED — ${failures} collision(s) found.`);
    process.exit(1);
  }
  console.log('[overlay-check] PASS — no field overlaps printed text or another field.');
}

if (require.main === module) main();
module.exports = { intersects, fieldRects };
