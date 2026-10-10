#!/usr/bin/env node
/**
 * scripts/generate-txr-1406-editor-coords.js
 *
 * Companion to scripts/generate-trec-20-19-editor-coords.js. The 2026-10-09
 * fix repointed FORM_CONFIGS['sellers-disclosure'] in api/fill-form.js from
 * TREC 55-1 to TXR 1406 -- a completely different flat PDF with different
 * page geometry -- so the Interactive Editor's overlay coords for this form
 * (previously trec-sellers-disclosure-55-1-coords.json) would highlight the
 * wrong spot on the new PDF. EDITABLE_FIELDS_BY_FORM['sellers-disclosure']
 * only has one editable key (property_address), so this converts just that
 * one entry from api/_assets/field-maps/txr-1406-address-coords.json (page 1
 * -- top-left-origin {x,y,width,height}, y = near the bottom of the glyph
 * bbox per that file's own notes) into the same percent-of-page, top-left
 * overlay-box shape the editor expects.
 *
 * Run: node scripts/generate-txr-1406-editor-coords.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'api', '_assets', 'field-maps', 'txr-1406-address-coords.json');
const OUT = path.join(__dirname, '..', 'api', '_assets', 'trec-sellers-disclosure-txr-1406-coords.json');

function round3(n) { return Math.round(n * 1000) / 1000; }

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const { width, height } = src.page_dimensions;
const p1 = src.fields.property_address_p1;

const boxTop = p1.y - p1.height; // y in source is near the box's bottom edge
const field = {
  pdf_field_name: 'property_address_p1',
  type: 'text',
  page: p1.page,
  x_pt: p1.x,
  y_pt: boxTop,
  w_pt: p1.width,
  h_pt: p1.height,
  x_pct: round3((p1.x / width) * 100),
  y_pct: round3((boxTop / height) * 100),
  w_pct: round3((p1.width / width) * 100),
  h_pct: round3((p1.height / height) * 100),
  key: 'property_address',
  label: 'Property address (page 1 header)',
  category: 'TXR-1406',
};

const out = {
  form_type: 'sellers-disclosure',
  generated_at: new Date().toISOString(),
  source_pdf: 'txr-1406-sellers-disclosure-base64.js',
  derived_from: 'txr-1406-address-coords.json',
  page_count: src.page_count,
  page_sizes: Array.from({ length: src.page_count }, (_, i) => ({
    page: i + 1,
    width_pt: width,
    height_pt: height,
  })),
  field_count: 1,
  mapped_field_count: 1,
  fields: [field],
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${OUT}`);
