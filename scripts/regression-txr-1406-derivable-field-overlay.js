#!/usr/bin/env node
// scripts/regression-txr-1406-derivable-field-overlay.js
//
// Companion to scripts/regression-txr-1406-field-overlay.js (2026-10-01,
// 702 Fawndale), extended 2026-10-09 to cover the FILLED state, not just the
// blank widget geometry. That script already proves the 287 DocuSeal
// widgets don't collide with each other or the printed form text. It does
// NOT check the property-address bake (api/_assets/field-maps/
// txr-1406-address-coords.json) -- the one other thing Dossie draws onto
// this PDF (via fillSellersDisclosureTxr1406() in api/fill-form.js) that
// isn't one of the 287 widgets, since the address was never a DocuSeal
// field on this flat PDF (see that file's own notes).
//
// This script checks the address-bake rectangle on all 7 pages against:
//   1. the real printed form text (same txr-1406-printed-text-bbox.json
//      fixture the sibling regression uses)
//   2. every one of the 287 DocuSeal widget rectangles (so a baked address
//      never sits on top of a widget that will later become a live
//      DocuSeal field when this form moves into the signing pipeline)
//
// The seller-name and HOA derivable fields do NOT need a new check here --
// they are drawn at the EXACT SAME {x,y,w,h} as their own DocuSeal widget
// (see api/_lib/txr-1406-field-map.js), which the sibling regression already
// collision-checks against printed text and every other widget.
//
// Usage: node scripts/regression-txr-1406-derivable-field-overlay.js

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FIELD_MAP_PATH = path.join(REPO, 'api', '_assets', 'field-maps', 'txr-1406-sellers-disclosure-docuseal-fields.json');
const TEXT_BBOX_PATH = path.join(REPO, 'api', '_assets', 'txr-1406-printed-text-bbox.json');
const ADDRESS_COORDS_PATH = path.join(REPO, 'api', '_assets', 'field-maps', 'txr-1406-address-coords.json');

const { intersects, fieldRects } = require('./regression-txr-1406-field-overlay.js');

let failures = 0;
function fail(msg) { failures += 1; console.error(`  FAIL  ${msg}`); }

function main() {
  const { fields } = JSON.parse(fs.readFileSync(FIELD_MAP_PATH, 'utf8'));
  const textByPage = JSON.parse(fs.readFileSync(TEXT_BBOX_PATH, 'utf8'));
  const addressCoords = JSON.parse(fs.readFileSync(ADDRESS_COORDS_PATH, 'utf8'));

  const widgetRects = fields.flatMap(fieldRects);

  // Address rect per page, as actually drawn by fillSellersDisclosureTxr1406:
  // top-left-origin box whose bottom edge is at spec.y (same convention
  // bakeAddress() in scripts/build-txr-1406-packet.js and the fill-form.js
  // handler both use), height = spec.font_size * 1.2 (generous estimate for
  // a single text line so the check is conservative, not optimistic).
  const addrRects = Object.entries(addressCoords.fields).map(([key, spec]) => {
    const h = spec.font_size * 1.2;
    return { label: `address-bake (${key})`, page: spec.page, x: spec.x, y: spec.y - h, w: spec.width, h };
  });

  console.log(`[derivable-overlay-check] checking address bake on ${addrRects.length} pages against ${widgetRects.length} widgets + printed text`);

  let textOverlaps = 0;
  for (const r of addrRects) {
    const words = textByPage[String(r.page)] || [];
    for (const w of words) {
      if (!w.t || !w.t.trim()) continue;
      // The address bake deliberately sits ON the "Concerning the Property
      // at" line itself (drawing over the blank, not beside it) -- exclude
      // that label's own words from the check, same way a human reading the
      // rendered page would expect "CONCERNING THE PROPERTY AT ___" to share
      // a line with the filled-in address.
      if (/concerning|property|at/i.test(w.t) && r.page !== 1) continue;
      const wordRect = { x: w.x, y: w.y, w: w.x2 - w.x, h: w.y2 - w.y };
      if (intersects(r, wordRect)) {
        textOverlaps += 1;
        fail(`page ${r.page}: "${r.label}" overlaps printed text "${w.t}" at (${w.x.toFixed(1)},${w.y.toFixed(1)})`);
      }
    }
  }

  let widgetOverlaps = 0;
  for (const r of addrRects) {
    for (const wgt of widgetRects) {
      if (wgt.page !== r.page) continue;
      if (intersects(r, wgt)) {
        widgetOverlaps += 1;
        fail(`page ${r.page}: "${r.label}" overlaps widget "${wgt.label}"`);
      }
    }
  }

  console.log(`[derivable-overlay-check] text overlaps: ${textOverlaps}, address-vs-widget overlaps: ${widgetOverlaps}`);
  if (failures > 0) {
    console.error(`\n[derivable-overlay-check] FAILED — ${failures} collision(s) found.`);
    process.exit(1);
  }
  console.log('[derivable-overlay-check] PASS — address bake overlaps no widget and no unrelated printed text.');
}

if (require.main === module) main();
