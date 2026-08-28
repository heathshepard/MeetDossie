#!/usr/bin/env node
/**
 * scripts/extract-field-neighbor-text.js
 * =============================================================================
 * Deterministic neighboring-text extractor for AcroForm field semantic
 * labeling (dossie-esign-productization-plan, step 5).
 *
 * Given a raw PDF and a coords.json file (from extract-acroform-fields.js /
 * scripts/extract-trec-field-coords.js), pulls the words physically near
 * each widget rect out of the PDF's real content stream via `pdftotext -bbox`
 * (poppler-utils, already installed — no new npm dependency) and attaches
 * them to each field as `neighbor_text`.
 *
 * This is TEXT extraction only — never estimates a coordinate, never guesses
 * a position. It just answers "what words are near this already-known rect."
 * The output is meant to be read by a human or handed to an LLM as label-only
 * context (key/party/paragraph), never fed back into geometry.
 *
 * Usage:
 *   node scripts/extract-field-neighbor-text.js <raw.pdf> <coords.json> <out.json>
 *
 * pdftotext -bbox emits top-left-origin word boxes (yMin/yMax grow downward).
 * The coords.json widget rects are bottom-left-origin (PDF/pdf-lib convention,
 * y grows upward) — this script converts pdftotext words into the same
 * bottom-left space so both sides compare directly.
 * =============================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

function usage() {
  console.error('Usage: node extract-field-neighbor-text.js <raw.pdf> <coords.json> <out.json>');
  process.exit(1);
}

const [, , pdfPath, coordsPath, outPath, leftArg, rightArg, upArg, downArg] = process.argv;
if (!pdfPath || !coordsPath || !outPath) usage();

// Reach overrides — dense multi-column checklist forms (e.g. 55-1 Seller's
// Disclosure) need a much tighter vertical window (rows ~18pt apart) than a
// prose-paragraph form like an Amendment, where the label precedes the blank
// by a wide left reach. Pass all four to override the defaults.
const REACH = {
  left: leftArg !== undefined ? Number(leftArg) : 480,
  right: rightArg !== undefined ? Number(rightArg) : 220,
  up: upArg !== undefined ? Number(upArg) : 46,
  down: downArg !== undefined ? Number(downArg) : 8,
};

function runBbox(pdf) {
  const tmpXml = path.join(os.tmpdir(), `bbox-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`);
  execFileSync('pdftotext', ['-bbox', pdf, tmpXml]);
  const xml = fs.readFileSync(tmpXml, 'utf8');
  fs.unlinkSync(tmpXml);
  return xml;
}

// Minimal hand-rolled parser — the bbox XML is regular enough not to need a
// full XML lib. Pages in order; each <word .../> inside a <page> block.
function parseBbox(xml) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  let pm;
  while ((pm = pageRe.exec(xml))) {
    const width = parseFloat(pm[1]);
    const height = parseFloat(pm[2]);
    const body = pm[3];
    const words = [];
    const wordRe = /<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g;
    let wm;
    while ((wm = wordRe.exec(body))) {
      const xMin = parseFloat(wm[1]);
      const yMinTL = parseFloat(wm[2]); // top-left origin
      const xMax = parseFloat(wm[3]);
      const yMaxTL = parseFloat(wm[4]);
      const text = decodeEntities(wm[5]);
      words.push({
        text,
        x_pt: xMin,
        w_pt: xMax - xMin,
        // convert to bottom-left origin to match widget rects
        y_bottom_pt: height - yMaxTL,
        y_top_pt: height - yMinTL,
      });
    }
    pages.push({ width, height, words });
  }
  return pages;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Build neighbor text for one widget rect (bottom-left origin, pt units).
// Strategy: gather words in reading order (top-to-bottom, left-to-right)
// within a generous window around the widget — wide left-reach (labels
// usually precede the blank) plus the line(s) directly above, and a smaller
// reach to the right/below (checkbox labels that follow the box).
//
// `otherFields` (same page, all widgets) lets the window self-clamp on
// multi-column checklist forms: if another field sits on the same row a
// short distance to the left/right, the reach in that direction is capped
// just short of it so a label doesn't bleed into the neighboring column's
// field (e.g. TREC 55-1's 3-column Y/N/U checklist).
function neighborText(pageWords, field, otherFields) {
  const { x_pt: x, y_pt: y, w_pt: w, h_pt: h } = field;
  const top = y + h;
  const bottom = y;
  let LEFT_REACH = REACH.left;
  let RIGHT_REACH = REACH.right;
  const UP_REACH = REACH.up;
  const DOWN_REACH = REACH.down;

  const ROW_TOL = 4; // pt — same-row test for clamping
  for (const other of otherFields) {
    if (other === field) continue;
    const sameRow = Math.abs(other.y_pt - y) <= ROW_TOL;
    if (!sameRow) continue;
    if (other.x_pt > x) {
      const gap = other.x_pt - (x + w);
      if (gap > 0 && gap < RIGHT_REACH) RIGHT_REACH = Math.max(0, gap - 2);
    } else if (other.x_pt < x) {
      const gap = x - (other.x_pt + other.w_pt);
      if (gap > 0 && gap < LEFT_REACH) LEFT_REACH = Math.max(0, gap - 2);
    }
  }

  const inWindow = pageWords.filter((wd) => {
    const wx = wd.x_pt;
    const wTop = wd.y_top_pt;
    const wBottom = wd.y_bottom_pt;
    const withinX = wx + wd.w_pt >= x - LEFT_REACH && wx <= x + w + RIGHT_REACH;
    const withinY = wTop <= top + UP_REACH && wBottom >= bottom - DOWN_REACH;
    return withinX && withinY;
  });

  // reading order: top-to-bottom (y_top descending in bottom-left space == higher first),
  // then left-to-right within ~3pt line bands.
  inWindow.sort((a, b) => {
    const rowDiff = b.y_top_pt - a.y_top_pt;
    if (Math.abs(rowDiff) > 3) return rowDiff;
    return a.x_pt - b.x_pt;
  });

  return inWindow.map((wd) => wd.text).join(' ').trim();
}

// Structured-field detection — deterministic, geometry-only. Flags candidate
// multi-part groups (e.g. a Street/City/State/Zip address split across
// several small text widgets on the same row) so a human reviewer treats
// them as ONE logical field with sub-parts rather than N unrelated flat_text
// fields. Never guesses a coordinate — only clusters widgets whose neighbor
// text already contains address-part keywords AND that sit on the same row.
const ADDRESS_KEYWORDS = ['street', 'address', 'city', 'state', 'zip', 'postal', 'county'];
function flagStructuredAddressCandidates(fields) {
  const byPage = {};
  fields.forEach((f) => {
    (byPage[f.page] = byPage[f.page] || []).push(f);
  });
  const ROW_TOL = 4;
  Object.values(byPage).forEach((pageFields) => {
    pageFields.forEach((f) => {
      const text = (f.neighbor_text || '').toLowerCase();
      const matched = ADDRESS_KEYWORDS.filter((kw) => text.includes(kw));
      if (!matched.length) return;
      const rowMates = pageFields.filter(
        (of) => of !== f && of.type === 'text' && Math.abs(of.y_pt - f.y_pt) <= ROW_TOL
      );
      const rowMatchesOtherKeyword = rowMates.some((of) => {
        const otherText = (of.neighbor_text || '').toLowerCase();
        return ADDRESS_KEYWORDS.some((kw) => otherText.includes(kw) && !matched.includes(kw));
      });
      if (rowMatchesOtherKeyword) {
        f.structured_group_hint = 'address_component';
        f.structured_group_matched_keyword = matched[0];
      }
    });
  });
}

(function main() {
  const coords = JSON.parse(fs.readFileSync(coordsPath, 'utf8'));
  const xml = runBbox(pdfPath);
  const pages = parseBbox(xml);

  const out = {
    form_type: coords.form_type,
    source_pdf: path.basename(pdfPath),
    generated_at: new Date().toISOString(),
    field_count: coords.fields.length,
    fields: coords.fields.map((f) => {
      const page = pages[f.page - 1];
      const sameFields = coords.fields.filter((of) => of.page === f.page);
      const neighbor_text = page ? neighborText(page.words, f, sameFields) : '';
      return {
        widget_index: f.widget_index,
        pdf_field_name: f.pdf_field_name,
        type: f.type,
        page: f.page,
        x_pt: f.x_pt,
        y_pt: f.y_pt,
        w_pt: f.w_pt,
        h_pt: f.h_pt,
        existing_key: f.key || null,
        neighbor_text,
      };
    }),
  };

  flagStructuredAddressCandidates(out.fields);

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.fields.length} fields with neighbor_text -> ${outPath}`);
})();
