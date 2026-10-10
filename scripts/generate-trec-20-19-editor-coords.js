#!/usr/bin/env node
/**
 * scripts/generate-trec-20-19-editor-coords.js
 *
 * Converts api/_assets/trec-20-19-field-coords.json (absolute PDF points,
 * bottom-left origin, label-baseline draw coordinates used by
 * fillResaleContractCoordinate() in api/fill-form.js) into the percent-of-
 * page, top-left-origin overlay shape api/interactive-editor-init.js's
 * COORDS_FILES loader expects (same shape as the legacy
 * trec-20-18-coords.json this replaces) -- {page_count, page_sizes,
 * fields:[{key,page,x_pct,y_pct,w_pct,h_pct,pdf_field_name,label}]}.
 *
 * This form is a flat PDF (0 AcroForm fields) -- there is no pdf_field_name,
 * so that property carries the semantic key instead, matching how the other
 * flat-PDF coord files (trec-38-7-coords.json etc.) already behave.
 *
 * The source has no explicit box height -- it has a text draw baseline (x,y)
 * + fontSize. Approximated box: height_pt = fontSize * 1.2, with the top of
 * the box fontSize * 0.9 above the baseline (typical cap-height + a little
 * leading) and the bottom fontSize * 0.3 below it (descender clearance).
 * This is a *display* overlay only -- the actual PDF fill continues to use
 * the untouched source file's exact baseline coordinates directly.
 *
 * Run: node scripts/generate-trec-20-19-editor-coords.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'api', '_assets', 'trec-20-19-field-coords.json');
const OUT = path.join(__dirname, '..', 'api', '_assets', 'trec-20-19-coords.json');

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const { width, height } = src.pdfDimensions;
const pageCount = src.pageCount;

const fields = [];
for (const [key, f] of Object.entries(src.fields)) {
  const fontSize = f.fontSize || 10;
  const hPt = fontSize * 1.2;
  const topPt = f.y + fontSize * 0.9;
  const wPt = f.maxWidth || 100;

  const x_pct = round3((f.x / width) * 100);
  const y_pct = round3(((height - topPt) / height) * 100);
  const w_pct = round3((wPt / width) * 100);
  const h_pct = round3((hPt / height) * 100);

  fields.push({
    pdf_field_name: key,
    type: 'text',
    page: f.page,
    x_pt: round2(f.x),
    y_pt: round2(f.y),
    w_pt: round2(wPt),
    h_pt: round2(hPt),
    x_pct,
    y_pct,
    w_pct,
    h_pct,
    key,
    label: f.notes || key,
    category: 'TREC-20-19',
  });
}

const page_sizes = Array.from({ length: pageCount }, (_, i) => ({
  page: i + 1,
  width_pt: width,
  height_pt: height,
}));

const out = {
  form_type: 'resale-contract',
  generated_at: new Date().toISOString(),
  source_pdf: 'trec-resale-20-19-base64.js',
  derived_from: 'trec-20-19-field-coords.json (absolute-point draw coords; converted to percent-of-page overlay boxes)',
  page_count: pageCount,
  page_sizes,
  field_count: fields.length,
  mapped_field_count: fields.length,
  fields,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${fields.length} fields to ${OUT}`);
