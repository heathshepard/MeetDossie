#!/usr/bin/env node
/**
 * dedupe-patterns.mjs — Group widgets that share a labeling pattern across pages.
 *
 * Detects two kinds of patterns:
 *   1. POSITION pattern — widgets at similar (x, y) within ±10pt across multiple
 *      pages (e.g., buyer-initials line at bottom-left of every page).
 *   2. NAME pattern — widgets whose AcroForm field name shares the same prefix
 *      modulo a numeric suffix (e.g., "Initialed for identification by Buyer",
 *      "Initialed for identification by Buyer_2", "..._3").
 *
 * For each group of >=3 widgets, emits a "pattern group" record. The labeler
 * presents the group as ONE labeling decision; accepting applies to all widgets
 * in the group.
 *
 * Output: scripts/.<form-id>-pattern-groups.json
 *   {
 *     form_id: "trec-20-18",
 *     groups: [
 *       {
 *         group_id: "g0",
 *         pattern_type: "position+name",
 *         signature: "x~33,y~25,'Initialed for identification by Buyer'",
 *         widget_indices: [37, 58, 79, ...],
 *         representative_index: 37,         // the one to show Heath
 *         pages: [1, 2, 3, ...],
 *         field_type: "text",
 *         suggested_fixture_key: "buyer_initials",
 *         confidence: 0.95
 *       },
 *       ...
 *     ],
 *     ungrouped_indices: [...],          // widgets in no group
 *   }
 *
 * Usage:
 *   node scripts/trec-labeler/dedupe-patterns.mjs
 *   node scripts/trec-labeler/dedupe-patterns.mjs --form trec-20-18
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

const FORM_IDS = [
  'trec-20-18',
  'trec-40',
  'trec-39-10',
  'op-h',
  'trec-36-11',
  'trec-38-7',
  'op-l',
];

const PDF_OF = (formId) => join(REPO_ROOT, 'api', '_assets', `${formId}-raw.pdf`);
const REPORT_OF = (formId) => join(REPO_ROOT, 'scripts', `.${formId}-unmatched-report.json`);
const ENRICHED_OF = (formId) => join(REPO_ROOT, 'scripts', `.${formId}-llm-enriched.json`);
const OUT_OF = (formId) => join(REPO_ROOT, 'scripts', `.${formId}-pattern-groups.json`);

const args = process.argv.slice(2);
const FORM_FILTER = (() => {
  const i = args.indexOf('--form');
  return i >= 0 ? args[i+1] : null;
})();

const POS_TOL = 10;        // points
const MIN_GROUP_SIZE = 3;  // widgets needed to form a group

async function loadGeometry(formId) {
  const pdfPath = PDF_OF(formId);
  if (!existsSync(pdfPath)) return new Map();
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const widgets = new Map();
  let idx = 0;
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const annots = await page.getAnnotations({ intent: 'display' });
    const ws = annots.filter(a => a.subtype === 'Widget');
    for (const w of ws) {
      const rect = w.rect;
      if (!rect || rect.length !== 4) { idx++; continue; }
      const x = Math.min(rect[0], rect[2]);
      const x2 = Math.max(rect[0], rect[2]);
      const y = Math.min(rect[1], rect[3]);
      const y2 = Math.max(rect[1], rect[3]);
      let ftype = 'text';
      if (w.fieldType === 'Btn') ftype = 'checkbox';
      else if (w.fieldType === 'Sig') ftype = 'signature';
      widgets.set(idx, {
        index: idx,
        page: pageNum,
        x, y,
        w: x2 - x,
        h: y2 - y,
        field_type: ftype,
        field_name: w.fieldName || w.alternativeText || '',
      });
      idx++;
    }
  }
  return widgets;
}

/**
 * Normalise an AcroForm field name into a "pattern" — strip trailing
 * numeric suffixes that tend to distinguish repeats:
 *   "Buyer Initials"      → "Buyer Initials"
 *   "Buyer Initials_2"    → "Buyer Initials"
 *   "Buyer Initials 3"    → "Buyer Initials"
 *   "TextField3[55]"      → "TextField3[]"
 *   "TextField3[3]"       → "TextField3[]"
 *   "Address numb 1"      → "Address numb"
 *   "form1[0].#subform[0].CheckBox1[0]"  → "form1[0].#subform[0].CheckBox1[]"
 */
function namePattern(name) {
  if (!name) return '(unnamed)';
  let s = String(name);
  // form1[0].#subform[0].TextField3[55] → strip the trailing index
  s = s.replace(/\[\d+\](?!\.|\[)$/, '[]');
  // _2, _3 suffixes
  s = s.replace(/_\d+$/, '');
  // " 2", " 3" trailing-number suffixes (like "AC numb 1")
  s = s.replace(/\s+\d+$/, '');
  // standalone trailing digits at end with no separator
  s = s.replace(/(?:numb|Number|num)\s*\d+$/i, m => m.replace(/\d+$/, '').trim());
  return s.trim();
}

function quantize(n, step) { return Math.round(n / step) * step; }

/**
 * Cluster widgets by (namePattern, field_type, quantized x, quantized y).
 * Widgets with the same signature on >=3 distinct pages form a group.
 *
 * Three passes:
 *   1. Strict: same name pattern + position quantized to ±10pt + type
 *   2. Name-only: same name pattern + type
 *   3. LLM-key: same LLM-suggested fixture_key + type, spanning >=3 pages
 */
function buildGroups(widgetsByIndex, unmatchedIndices, llmGuesses) {
  const buckets = new Map();
  for (const idx of unmatchedIndices) {
    const w = widgetsByIndex.get(idx);
    if (!w) continue;
    const pat = namePattern(w.field_name);
    const qx = quantize(w.x, POS_TOL);
    const qy = quantize(w.y, POS_TOL);
    // Two-pass: try strict name+pos first, then fall back to name-only.
    const sigStrict = `name:${pat}|type:${w.field_type}|x:${qx}|y:${qy}`;
    if (!buckets.has(sigStrict)) buckets.set(sigStrict, []);
    buckets.get(sigStrict).push(w);
  }

  const groups = [];
  const assigned = new Set();
  let gid = 0;
  for (const [sig, ws] of buckets) {
    if (ws.length < MIN_GROUP_SIZE) continue;
    const pages = new Set(ws.map(w => w.page));
    if (pages.size < MIN_GROUP_SIZE) continue;
    // Sort by page then index
    ws.sort((a, b) => a.page - b.page || a.index - b.index);
    groups.push({
      group_id: `g${gid++}`,
      pattern_type: 'position+name',
      signature: sig,
      widget_indices: ws.map(w => w.index),
      representative_index: ws[0].index,
      pages: [...pages].sort((a,b) => a - b),
      field_type: ws[0].field_type,
      field_name_pattern: namePattern(ws[0].field_name),
    });
    for (const w of ws) assigned.add(w.index);
  }

  // Second pass: name-only groups for the remaining unmatched widgets
  const buckets2 = new Map();
  for (const idx of unmatchedIndices) {
    if (assigned.has(idx)) continue;
    const w = widgetsByIndex.get(idx);
    if (!w) continue;
    const pat = namePattern(w.field_name);
    if (pat === '(unnamed)') continue;
    const sig = `name:${pat}|type:${w.field_type}`;
    if (!buckets2.has(sig)) buckets2.set(sig, []);
    buckets2.get(sig).push(w);
  }
  for (const [sig, ws] of buckets2) {
    if (ws.length < MIN_GROUP_SIZE) continue;
    const pages = new Set(ws.map(w => w.page));
    if (pages.size < MIN_GROUP_SIZE) continue;
    ws.sort((a, b) => a.page - b.page || a.index - b.index);
    groups.push({
      group_id: `g${gid++}`,
      pattern_type: 'name-only',
      signature: sig,
      widget_indices: ws.map(w => w.index),
      representative_index: ws[0].index,
      pages: [...pages].sort((a,b) => a - b),
      field_type: ws[0].field_type,
      field_name_pattern: namePattern(ws[0].field_name),
    });
    for (const w of ws) assigned.add(w.index);
  }

  // Third pass: group widgets that the LLM gave the SAME fixture_key + same type,
  // even if name/position differs. This catches "buyer initials on every page"
  // where the AcroForm name and exact x/y drift but the LLM understands semantics.
  if (llmGuesses) {
    const buckets3 = new Map();
    for (const idx of unmatchedIndices) {
      if (assigned.has(idx)) continue;
      const w = widgetsByIndex.get(idx);
      if (!w) continue;
      const guess = llmGuesses[idx] || llmGuesses[String(idx)];
      if (!guess || !guess.fixture_key) continue;
      // Skip catch-all keys (never useful as a group)
      const fk = String(guess.fixture_key).toLowerCase();
      if (fk === 'notes' || fk === 'ignore') continue;
      // Require reasonably confident guesses to anchor a group
      if (guess.confidence != null && guess.confidence < 0.70) continue;
      const sig = `llm:${guess.fixture_key}|type:${w.field_type}`;
      if (!buckets3.has(sig)) buckets3.set(sig, []);
      buckets3.get(sig).push(w);
    }
    for (const [sig, ws] of buckets3) {
      if (ws.length < MIN_GROUP_SIZE) continue;
      const pages = new Set(ws.map(w => w.page));
      if (pages.size < MIN_GROUP_SIZE) continue;
      ws.sort((a, b) => a.page - b.page || a.index - b.index);
      groups.push({
        group_id: `g${gid++}`,
        pattern_type: 'llm-semantic',
        signature: sig,
        widget_indices: ws.map(w => w.index),
        representative_index: ws[0].index,
        pages: [...pages].sort((a,b) => a - b),
        field_type: ws[0].field_type,
        field_name_pattern: namePattern(ws[0].field_name) + ' (LLM cluster)',
      });
      for (const w of ws) assigned.add(w.index);
    }
  }

  return { groups, assigned };
}

function suggestedFromLLM(groups, llmGuesses) {
  if (!llmGuesses) return;
  for (const g of groups) {
    // Use the LLM guess on the representative index; if low conf, fall back to
    // majority key among guesses in the group.
    const repGuess = llmGuesses[g.representative_index];
    if (repGuess) {
      g.suggested_fixture_key = repGuess.fixture_key;
      g.confidence = repGuess.confidence;
      g.reasoning = repGuess.reasoning;
    }
    // Cross-check: count fixture keys across group members and prefer majority
    const counts = new Map();
    let total = 0;
    for (const idx of g.widget_indices) {
      const guess = llmGuesses[idx];
      if (!guess) continue;
      counts.set(guess.fixture_key, (counts.get(guess.fixture_key) || 0) + 1);
      total++;
    }
    if (total === 0) continue;
    let topKey = null, topCount = 0;
    for (const [k, c] of counts) {
      if (c > topCount) { topKey = k; topCount = c; }
    }
    g.group_agreement = topCount / total;
    if (topKey && topCount > total / 2) {
      // majority wins
      g.suggested_fixture_key = topKey;
      // Boost confidence if all guesses agree, deflate if they disagree
      if (g.confidence != null) {
        if (topCount === total) g.confidence = Math.min(1, g.confidence + 0.05);
        else if (g.group_agreement < 0.7) g.confidence = Math.max(0, g.confidence - 0.15);
      }
    }
  }
}

async function processForm(formId) {
  console.log(`\n=== ${formId} ===`);
  const reportPath = REPORT_OF(formId);
  if (!existsSync(reportPath)) {
    console.log(`  no report — skipping`);
    return null;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const unmatchedIndices = (report.unmatched || []).map(u => u.index);
  if (unmatchedIndices.length === 0) {
    writeFileSync(OUT_OF(formId), JSON.stringify({ form_id: formId, groups: [], ungrouped_indices: [] }, null, 2));
    console.log(`  no unmatched — empty pattern file written`);
    return { formId, total: 0, grouped: 0, groups: 0 };
  }
  const widgetsByIndex = await loadGeometry(formId);
  // Pull LLM guesses first — they help BOTH the third-pass clustering and the
  // group's suggested_fixture_key resolution.
  let llmGuesses = null;
  if (existsSync(ENRICHED_OF(formId))) {
    try {
      const enr = JSON.parse(readFileSync(ENRICHED_OF(formId), 'utf8'));
      llmGuesses = enr.llm_guesses || null;
    } catch {}
  }
  const { groups, assigned } = buildGroups(widgetsByIndex, unmatchedIndices, llmGuesses);
  suggestedFromLLM(groups, llmGuesses);

  const ungrouped = unmatchedIndices.filter(i => !assigned.has(i));
  writeFileSync(OUT_OF(formId), JSON.stringify({
    form_id: formId,
    total_unmatched: unmatchedIndices.length,
    grouped_count: assigned.size,
    ungrouped_count: ungrouped.length,
    groups,
    ungrouped_indices: ungrouped,
    generated_at: new Date().toISOString(),
  }, null, 2));

  console.log(`  ${unmatchedIndices.length} unmatched → ${groups.length} pattern groups covering ${assigned.size} widgets (${ungrouped.length} still ungrouped)`);
  for (const g of groups.slice(0, 5)) {
    console.log(`    ${g.group_id}: ${g.widget_indices.length}× "${g.field_name_pattern}" (${g.field_type}) pages ${g.pages.join(',')} → ${g.suggested_fixture_key || '(no key)'}`);
  }
  if (groups.length > 5) console.log(`    …+${groups.length - 5} more`);
  return { formId, total: unmatchedIndices.length, grouped: assigned.size, groups: groups.length, ungrouped: ungrouped.length };
}

async function main() {
  const ids = FORM_FILTER ? [FORM_FILTER] : FORM_IDS;
  const summaries = [];
  for (const id of ids) {
    const s = await processForm(id);
    if (s) summaries.push(s);
  }
  console.log('\n=== SUMMARY ===');
  let tu = 0, tg = 0, tgroups = 0;
  for (const s of summaries) {
    const pct = s.total > 0 ? (100 * s.grouped / s.total).toFixed(0) : '0';
    console.log(`  ${s.formId.padEnd(12)}: ${s.grouped}/${s.total} unmatched widgets grouped into ${s.groups} groups (${pct}% deduped)`);
    tu += s.total; tg += s.grouped; tgroups += s.groups;
  }
  const tpct = tu > 0 ? (100 * tg / tu).toFixed(0) : '0';
  console.log(`  ALL         : ${tg}/${tu} unmatched widgets grouped into ${tgroups} groups (${tpct}% deduped)`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
