#!/usr/bin/env node
/**
 * build-labeler.mjs  (v4 — Hadley pre-labels + per-form thresholds + autocomplete vocab
 *                          + LLM semantic guesses + auto-accept + pattern dedupe)
 *
 * v3 was visual + LLM. v4 adds:
 *   - Hadley pre-labels (Desktop/trec-20-18-labels-jarvis.json + trec-40 equivalent) override LLM
 *   - Per-form auto-accept thresholds: 0.90 for trec-20-18 + trec-40 (Heath sees edge cases);
 *     0.75 for the other 5 forms (fully autonomous, max coverage)
 *   - Autocomplete vocab list emitted at dataset._meta.autocomplete_vocab — built from
 *     canonical fixture keys + every key surfaced by the LLM / Hadley
 *   - Deferred review file at scripts/.labeler-v4-deferred-review.json — surfaces every
 *     widget that fell below the autonomous-form threshold for Atlas/Hadley post-flight
 *   - HEATH_FORMS gate: only trec-20-18 + trec-40 are presented to Heath; the other 5
 *     forms auto-accept everything above threshold, defer the rest, and never bother him
 *
 * v3 backward-compat: if LLM/pattern files are missing, the build still works,
 *   just without those features (graceful degradation).
 *
 * Tradeoff: file size grows from ~150 KB to ~6-8 MB. Heath approved the budget.
 *   - Rendering at 72 DPI keeps PNGs small AND maps PDF points 1:1 to image
 *     pixels (zero scale math, zero rounding bugs).
 *   - Per-page (not per-widget) means we embed ~22 PNGs total across 7 forms
 *     instead of ~400 widget-crops.
 *   - Widget rect overlay is pure CSS, computed at runtime — no per-widget asset.
 *
 * Usage: node scripts/trec-labeler/build-labeler.mjs
 *
 * Requires: pdftoppm on PATH (Poppler — already installed via winget).
 *
 * Inputs (per form):
 *   - scripts/.<form-id>-unmatched-report.json   (confident_matches + unmatched)
 *   - api/_assets/<form-id>-raw.pdf              (source PDF; rendered to PNGs)
 *
 * Widget geometry: we re-read the PDF via pdfjs (matching the associator's
 * iteration order) to backfill x/y for confident_matches (which lack rects
 * in the report JSON). Unmatched entries already have x/y; we trust those.
 *
 * Special: TREC 38-7 has NO AcroForm widgets. Pseudo-widgets come from
 *   api/_assets/field-maps/trec-38-7-coords.json (which provides x/y for the
 *   coords-overlay system the prod fill uses).
 *
 * Outputs:
 *   - scripts/trec-labeler/trec-labeler.html         (versioned)
 *   - C:\Users\Heath Shepard\Desktop\trec-labeler.html (working copy)
 *   - C:\Users\Heath Shepard\Desktop\MeetDossie\.tmp-labeler-pages\ (intermediate PNGs, NOT committed)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

const TEMPLATE_PATH = join(__dirname, 'labeler-template.html');
const REPO_OUT      = join(__dirname, 'trec-labeler.html');
const DESKTOP_OUT   = 'C:\\Users\\Heath Shepard\\Desktop\\trec-labeler.html';
const TMP_DIR       = join(REPO_ROOT, '.tmp-labeler-pages');
const DEFERRED_OUT  = join(REPO_ROOT, 'scripts', '.labeler-v4-deferred-review.json');
const FIXTURE_PATH  = join(REPO_ROOT, 'scripts', '.trec-20-18-fixture.json');

const FORM_IDS = [
  'trec-20-18',
  'trec-40',
  'trec-39-10',
  'op-h',
  'trec-36-11',
  'trec-38-7',
  'op-l',
];

// Forms Heath manually labels in the UI. The other 5 forms get fully autonomous
// LLM auto-accept + deferred review; Heath never sees them.
const HEATH_FORMS = new Set(['trec-20-18', 'trec-40']);

// Per-form LLM auto-accept threshold.
//   trec-20-18 + trec-40 → 0.90 (Heath WANTS to see edge cases)
//   other 5 forms        → 0.75 (autonomous; max coverage)
const AUTO_ACCEPT_THRESHOLD_BY_FORM = {
  'trec-20-18': 0.90,
  'trec-40':    0.90,
  'trec-39-10': 0.75,
  'op-h':       0.75,
  'trec-36-11': 0.75,
  'trec-38-7':  0.75,
  'op-l':       0.75,
};

// Hadley pre-label files on Desktop (optional; load-if-present).
const HADLEY_FILE_OF = {
  'trec-20-18': 'C:\\Users\\Heath Shepard\\Desktop\\trec-20-18-labels-jarvis.json',
  'trec-40':    'C:\\Users\\Heath Shepard\\Desktop\\trec-40-labels-jarvis.json',
};

const COORDS_FALLBACK = {
  'trec-38-7': {
    coordsPath: join(REPO_ROOT, 'api', '_assets', 'field-maps', 'trec-38-7-coords.json'),
  },
};

const PDF_OF = (formId) => join(REPO_ROOT, 'api', '_assets', `${formId}-raw.pdf`);
const REPORT_OF = (formId) => join(REPO_ROOT, 'scripts', `.${formId}-unmatched-report.json`);
const ENRICHED_OF = (formId) => join(REPO_ROOT, 'scripts', `.${formId}-llm-enriched.json`);
const GROUPS_OF = (formId) => join(REPO_ROOT, 'scripts', `.${formId}-pattern-groups.json`);

const DPI = 72; // 1pt = 1px → trivial PDF-to-image coord mapping

function loadReport(formId) {
  const p = REPORT_OF(formId);
  if (!existsSync(p)) {
    console.warn(`  WARN: no report for ${formId} at ${p}`);
    return null;
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function loadEnriched(formId) {
  const p = ENRICHED_OF(formId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function loadGroups(formId) {
  const p = GROUPS_OF(formId);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function loadHadley(formId) {
  const p = HADLEY_FILE_OF[formId];
  if (!p || !existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    // Accept either { labels: [{index, fixture_key, status?}] } or
    // { byIndex: { "37": "buyer_initials" } } or a plain { "37": "buyer_initials" } map.
    if (Array.isArray(raw.labels)) {
      const map = new Map();
      for (const lbl of raw.labels) {
        if (typeof lbl.index !== 'number') continue;
        map.set(lbl.index, {
          fixture_key: lbl.fixture_key || null,
          status: lbl.status || 'corrected',
          reasoning: lbl.reasoning || 'Hadley pre-label',
        });
      }
      return map;
    }
    if (raw.byIndex && typeof raw.byIndex === 'object') {
      const map = new Map();
      for (const [k, v] of Object.entries(raw.byIndex)) {
        const idx = parseInt(k, 10);
        if (Number.isNaN(idx)) continue;
        if (typeof v === 'string') map.set(idx, { fixture_key: v, status: 'corrected', reasoning: 'Hadley pre-label' });
        else if (v && typeof v === 'object' && v.fixture_key) map.set(idx, { fixture_key: v.fixture_key, status: v.status || 'corrected', reasoning: v.reasoning || 'Hadley pre-label' });
      }
      return map;
    }
    // Plain { "37": "buyer_initials", "58": "buyer_initials" } shape
    if (typeof raw === 'object' && raw !== null) {
      const map = new Map();
      for (const [k, v] of Object.entries(raw)) {
        const idx = parseInt(k, 10);
        if (Number.isNaN(idx)) continue;
        if (typeof v === 'string') map.set(idx, { fixture_key: v, status: 'corrected', reasoning: 'Hadley pre-label' });
        else if (v && typeof v === 'object' && v.fixture_key) map.set(idx, { fixture_key: v.fixture_key, status: v.status || 'corrected', reasoning: v.reasoning || 'Hadley pre-label' });
      }
      return map;
    }
    return null;
  } catch { return null; }
}

function loadFixture() {
  if (!existsSync(FIXTURE_PATH)) return {};
  try { return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')); } catch { return {}; }
}

/**
 * Extract widget geometry from the source PDF in the SAME iteration order
 * as scripts/trec-multi-form-associator.mjs (which is what assigns the
 * `index` field used by the report JSON). This lets us backfill x/y for
 * confident_matches (which report JSON omits) and gives us authoritative
 * coords for every widget regardless of its match status.
 *
 * Returns:
 *   {
 *     pageSizes: { 1: { width, height }, 2: {...} },
 *     widgets:   Map<index, { page, x, y, w, h }>     // PDF coords, origin bottom-left
 *   }
 */
async function extractGeometry(formId) {
  const pdfPath = PDF_OF(formId);
  if (!existsSync(pdfPath)) {
    console.warn(`  WARN: no PDF at ${pdfPath}`);
    return { pageSizes: {}, widgets: new Map() };
  }
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const pageSizes = {};
  const widgetsByIndex = new Map();
  let widgetGlobalIndex = 0;
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1.0 });
    pageSizes[pageNum] = { width: vp.width, height: vp.height };
    const annots = await page.getAnnotations({ intent: 'display' });
    const widgets = annots.filter(a => a.subtype === 'Widget');
    for (const w of widgets) {
      const rect = w.rect;
      if (!rect || rect.length !== 4) continue;
      const x = Math.min(rect[0], rect[2]);
      const x2 = Math.max(rect[0], rect[2]);
      const y = Math.min(rect[1], rect[3]);
      const y2 = Math.max(rect[1], rect[3]);
      widgetsByIndex.set(widgetGlobalIndex, {
        page: pageNum,
        x, y,
        w: x2 - x,
        h: y2 - y,
      });
      widgetGlobalIndex++;
    }
  }
  return { pageSizes, widgets: widgetsByIndex };
}

/**
 * Get page sizes for forms that don't have AcroForm widgets (e.g. trec-38-7).
 * We still need page dimensions so the labeler can position the overlay.
 */
async function pageSizesOnly(formId) {
  const pdfPath = PDF_OF(formId);
  if (!existsSync(pdfPath)) return {};
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;
  const pageSizes = {};
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1.0 });
    pageSizes[pageNum] = { width: vp.width, height: vp.height };
  }
  return pageSizes;
}

/**
 * Render every PDF page to PNG at 72 DPI via pdftoppm. Returns
 * { 1: base64, 2: base64, ... } per page number.
 */
function renderPagesAsBase64(formId) {
  const pdfPath = PDF_OF(formId);
  if (!existsSync(pdfPath)) {
    console.warn(`  WARN: no PDF to render for ${formId}`);
    return {};
  }
  const outDir = join(TMP_DIR, formId);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const outPrefix = join(outDir, `${formId}-page`);
  try {
    execFileSync('pdftoppm', ['-png', '-r', String(DPI), pdfPath, outPrefix], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(`  ERROR: pdftoppm failed for ${formId}: ${err.message}`);
    return {};
  }
  const pages = {};
  const files = readdirSync(outDir).filter(f => f.endsWith('.png')).sort();
  // pdftoppm names files like trec-20-18-page-01.png, trec-20-18-page-02.png, …
  // The page number is the last numeric segment before .png.
  for (const f of files) {
    const m = f.match(/-(\d+)\.png$/);
    if (!m) continue;
    const pageNum = parseInt(m[1], 10);
    const buf = readFileSync(join(outDir, f));
    pages[pageNum] = buf.toString('base64');
  }
  return pages;
}

/**
 * Build the per-form widget array the labeler renders. Each widget carries
 * authoritative x/y/w/h from the geometry pass, plus the report's match
 * data and labels.
 */
function widgetsForForm(formId, report, geometry, enriched, groupsFile, hadleyMap) {
  const out = [];
  if (COORDS_FALLBACK[formId]) {
    return synthFromCoords(formId, geometry.pageSizes || {});
  }
  if (!report) return [];

  const threshold = AUTO_ACCEPT_THRESHOLD_BY_FORM[formId] ?? 0.85;
  const llmGuesses = (enriched && enriched.llm_guesses) || {};
  // Map widget_index → { group_id, role: 'representative'|'member', size, suggested_fixture_key, confidence }
  const groupMembership = new Map();
  if (groupsFile && Array.isArray(groupsFile.groups)) {
    for (const g of groupsFile.groups) {
      for (const idx of g.widget_indices) {
        groupMembership.set(idx, {
          group_id: g.group_id,
          is_representative: idx === g.representative_index,
          group_size: g.widget_indices.length,
          group_pages: g.pages,
          group_member_indices: g.widget_indices,
          group_suggested_fixture_key: g.suggested_fixture_key || null,
          group_confidence: g.confidence != null ? g.confidence : null,
          group_reasoning: g.reasoning || null,
          group_agreement: g.group_agreement != null ? g.group_agreement : null,
          field_name_pattern: g.field_name_pattern || null,
        });
      }
    }
  }

  // Confident matches: report omits x/y, so backfill from geometry.
  // These were matched by the spatial associator with high confidence AND
  // (for trec-20-18) overridden by the existing overridemap. They are NOT
  // unmatched — they're already in the production fixture. v4 auto-accepts
  // them too so Heath never sees a "remaining" count he didn't cause.
  for (const m of report.confident_matches || []) {
    const geom = geometry.widgets.get(m.index) || {};
    const hadley = hadleyMap ? hadleyMap.get(m.index) : null;
    out.push({
      index: m.index,
      field_name: m.field_name,
      page: m.page || geom.page || 1,
      x: round(geom.x ?? m.x ?? 0),
      y: round(geom.y ?? m.y ?? 0),
      width: round(geom.w ?? m.width ?? 0),
      height: round(geom.h ?? m.height ?? 0),
      field_type: m.field_type,
      best_label_guess: m.evidence && m.evidence.label ? m.evidence.label : m.fixture_key,
      best_label_fixture_key: hadley && hadley.fixture_key ? hadley.fixture_key : m.fixture_key,
      best_label_score: m.confidence_score,
      best_label_source: hadley && hadley.fixture_key ? 'hadley' : 'spatial_confident',
      best_label_reason: hadley && hadley.fixture_key ? (hadley.reasoning || 'Hadley pre-label') : null,
      nearest_labels_within_100px: [],
      _auto_confident: true,
      auto_accept: true, // Confident spatial match + override map = Heath never sees these
    });
  }
  // Unmatched: report has x/y; cross-check against geometry and prefer geometry
  // if they disagree (geometry is the source of truth — same iteration order).
  for (const u of report.unmatched || []) {
    const geom = geometry.widgets.get(u.index) || {};
    const llm = llmGuesses[u.index] || llmGuesses[String(u.index)];
    const group = groupMembership.get(u.index) || null;
    const hadley = hadleyMap ? hadleyMap.get(u.index) : null;

    // LLM guess takes precedence over spatial guess when present.
    const llmKey = llm && llm.fixture_key ? llm.fixture_key : null;
    const llmConf = llm ? llm.confidence : null;
    const llmReason = llm ? llm.reasoning : null;

    // Decide the "best guess" surfaced in the UI. Priority:
    //   1. Hadley pre-label (treat as gold; auto-accept)
    //   2. Group's suggested key (if widget is in a group)
    //   3. LLM guess
    //   4. Spatial guess (legacy)
    let bestKey, bestScore, bestSource, bestReason;
    if (hadley && hadley.fixture_key) {
      bestKey = hadley.fixture_key;
      bestScore = 1.0;
      bestSource = 'hadley';
      bestReason = hadley.reasoning || 'Hadley pre-label';
    } else if (group && group.group_suggested_fixture_key) {
      bestKey = group.group_suggested_fixture_key;
      bestScore = group.group_confidence;
      bestSource = 'pattern_group';
      bestReason = group.group_reasoning || `Pattern across ${group.group_pages.length} pages`;
    } else if (llmKey) {
      bestKey = llmKey;
      bestScore = llmConf;
      bestSource = 'llm';
      bestReason = llmReason;
    } else {
      bestKey = u.best_label_fixture_key;
      bestScore = u.best_label_score;
      bestSource = 'spatial';
      bestReason = null;
    }

    out.push({
      index: u.index,
      field_name: u.field_name,
      page: u.page || geom.page || 1,
      x: round(geom.x ?? u.x ?? 0),
      y: round(geom.y ?? u.y ?? 0),
      width: round(geom.w ?? u.width ?? 0),
      height: round(geom.h ?? u.height ?? 0),
      field_type: u.field_type,
      best_label_guess: u.best_label_guess,            // human-readable spatial label (kept for context)
      best_label_fixture_key: bestKey,
      best_label_score: bestScore != null ? bestScore : u.best_label_score,
      best_label_source: bestSource,
      best_label_reason: bestReason,
      // Carry the raw spatial guess separately so the UI can show both
      spatial_fixture_key: u.best_label_fixture_key,
      spatial_score: u.best_label_score,
      // Also carry the LLM result independently (useful when in a group)
      llm_fixture_key: llmKey,
      llm_confidence: llmConf,
      llm_reasoning: llmReason,
      nearest_labels_within_100px: u.nearest_labels_within_100px || [],
      reason_no_match: u.reason_no_match,
      // Pattern-group metadata
      group_id: group ? group.group_id : null,
      group_is_representative: group ? group.is_representative : false,
      group_size: group ? group.group_size : null,
      group_pages: group ? group.group_pages : null,
      group_member_indices: group ? group.group_member_indices : null,
      field_name_pattern: group ? group.field_name_pattern : null,
      // Auto-accept flag: per-form threshold; Hadley always wins.
      auto_accept: shouldAutoAccept(bestSource, bestScore, group, threshold),
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

function shouldAutoAccept(source, score, group, threshold) {
  // Hadley pre-labels: gold but we still want Heath to rapid-confirm them
  // in the UI (per v4 spec). So they DO NOT auto-apply — they only set the
  // pre-filled guess. The template's renderCorrectForm/card surfaces them
  // with the HADLEY source badge and pre-filled fixture_key, and Heath hits [1].
  if (source === 'hadley') return false;
  if (score == null) return false;
  if (source === 'spatial') return false; // spatial guesses are too unreliable
  if (score < threshold) return false;
  // For pattern groups, require group_agreement ≥ 0.8 (majority)
  if (group && group.group_agreement != null && group.group_agreement < 0.8) return false;
  return true;
}

function round(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function synthFromCoords(formId, pageSizes) {
  const cfg = COORDS_FALLBACK[formId];
  if (!existsSync(cfg.coordsPath)) {
    console.warn(`  WARN: coords file missing for ${formId}: ${cfg.coordsPath}`);
    return [];
  }
  const map = JSON.parse(readFileSync(cfg.coordsPath, 'utf8'));
  // The coords-overlay maps use TOP-LEFT DESIGN COORDS (see flat-pdf-filler.js:
  //   y_pdf = page.height - y_design - font_size
  // The labeler renders by flipping PDF coords back to top-down image coords:
  //   imgY = pageSize.height - widget.y - widget.height
  // So we must convert design coords → PDF coords here to round-trip correctly.
  const out = [];
  let idx = 0;
  for (const [key, f] of Object.entries(map.fields || {})) {
    const isCheckbox = f.type === 'checkbox';
    const widthPt  = f.width  || (isCheckbox ? 10 : 200);
    const heightPt = f.height || (isCheckbox ? 10 : 14);
    const ps = pageSizes[f.page || 1];
    const pageH = (ps && ps.height) || (map.page_dimensions && map.page_dimensions.height) || 792;
    // design (top-down) → PDF (bottom-up) — match flat-pdf-filler.js semantics.
    // For text fields fpf uses (height - y_design - fontSize); for checkboxes
    // we mirror the same flip using the widget's own height as the baseline.
    const pdfY = pageH - f.y - heightPt;
    out.push({
      index: idx++,
      field_name: key,
      page: f.page || 1,
      x: f.x,
      y: pdfY,
      width: widthPt,
      height: heightPt,
      field_type: isCheckbox ? 'checkbox' : 'text',
      best_label_guess: f.label || f.notes || key,
      best_label_fixture_key: key,
      best_label_score: 1.0,
      best_label_source: 'spatial_confident', // coords overlay = production-mapped
      best_label_reason: 'TREC 38-7 coords-overlay mapping (already in production)',
      nearest_labels_within_100px: [],
      _auto_confident: true,
      auto_accept: true, // v4: synthesized coords-overlay widgets are production-ready
      _source: 'coords-overlay',
    });
  }
  console.log(`  ${formId}: synthesised ${out.length} widgets from coords overlay`);
  return out;
}

async function main() {
  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`ERROR: template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  console.log('Rendering PDFs and extracting widget geometry...');
  mkdirSync(TMP_DIR, { recursive: true });

  const dataset = {};
  const stats = {};

  // Pattern groups (built dataset-level: list of groups per form for "label-once" UX)
  const patternGroupsByForm = {};

  // Vocab accumulator + deferred review accumulator
  const vocabSet = new Set();
  const deferredItems = [];

  for (const formId of FORM_IDS) {
    let report = null;
    let geometry = { pageSizes: {}, widgets: new Map() };
    if (COORDS_FALLBACK[formId]) {
      geometry.pageSizes = await pageSizesOnly(formId);
    } else {
      report = loadReport(formId);
      geometry = await extractGeometry(formId);
    }
    const enriched = loadEnriched(formId);
    const groupsFile = loadGroups(formId);
    const hadleyMap = loadHadley(formId);
    const widgets = widgetsForForm(formId, report, geometry, enriched, groupsFile, hadleyMap);
    const pagesB64 = renderPagesAsBase64(formId);
    const pageCount = Object.keys(pagesB64).length;
    const confident = widgets.filter(w => w._auto_confident).length;
    const autoAccept = widgets.filter(w => w.auto_accept).length;
    const inGroup = widgets.filter(w => w.group_id).length;
    const fromHadley = widgets.filter(w => w.best_label_source === 'hadley').length;
    const unmatched = widgets.length - confident;
    const threshold = AUTO_ACCEPT_THRESHOLD_BY_FORM[formId] ?? 0.85;
    const isHeathForm = HEATH_FORMS.has(formId);

    // Heath sees every widget that's NOT auto_accept and NOT a non-representative
    // group member (collapsed). For non-Heath forms, treat ALL widgets as
    // auto-handled — anything below threshold goes to deferred review, not Heath.
    let heathSees;
    if (isHeathForm) {
      heathSees = widgets.filter(w => {
        if (w.auto_accept) return false;
        if (w.group_id && !w.group_is_representative) return false;
        return true;
      }).length;
    } else {
      heathSees = 0;
    }

    // Collect deferred items (LLM/spatial guesses below threshold on non-Heath forms)
    if (!isHeathForm) {
      for (const w of widgets) {
        if (w._auto_confident) continue;     // already spatial-confident
        if (w.auto_accept) continue;          // already auto-accepted by LLM/hadley/group
        deferredItems.push({
          form_id: formId,
          widget_index: w.index,
          field_name: w.field_name,
          field_type: w.field_type,
          page: w.page,
          suggested_fixture_key: w.best_label_fixture_key,
          source: w.best_label_source,
          confidence: w.best_label_score,
          threshold,
          reasoning: w.best_label_reason || w.reason_no_match || null,
          group_id: w.group_id || null,
        });
      }
    }

    // Harvest vocab: every fixture key we touched
    for (const w of widgets) {
      if (w.best_label_fixture_key) vocabSet.add(w.best_label_fixture_key);
      if (w.spatial_fixture_key) vocabSet.add(w.spatial_fixture_key);
      if (w.llm_fixture_key) vocabSet.add(w.llm_fixture_key);
    }

    dataset[formId] = {
      widgets,
      pattern_groups: (groupsFile && groupsFile.groups) || [],
      page_sizes: geometry.pageSizes,
      page_images: pagesB64, // { 1: "iVBORw0KG…", 2: "…", … }
      dpi: DPI,
      auto_accept_threshold: threshold,
      heath_form: isHeathForm,
    };
    patternGroupsByForm[formId] = (groupsFile && groupsFile.groups) || [];
    stats[formId] = {
      total: widgets.length,
      confident,
      unmatched,
      autoAccept,
      inGroup,
      groupCount: (groupsFile && groupsFile.groups) ? groupsFile.groups.length : 0,
      heathSees: Math.max(0, heathSees),
      fromHadley,
      pages: pageCount,
      threshold,
      isHeathForm,
      hadleyLoaded: !!hadleyMap,
    };
    const imgKB = Object.values(pagesB64).reduce((n, b) => n + b.length, 0) / 1024;
    const hadleyTag = hadleyMap ? ` · HADLEY:${fromHadley}` : '';
    const heathTag  = isHeathForm ? `~${stats[formId].heathSees} for Heath` : 'FULLY AUTONOMOUS';
    console.log(`  ${formId}: ${widgets.length} widgets · ${confident} pre-confident · ${unmatched} unmatched (${autoAccept} auto-accept@${threshold}, ${inGroup} in ${stats[formId].groupCount} groups${hadleyTag}, ${heathTag}) · ${pageCount}p · ${imgKB.toFixed(0)}KB`);
  }

  // Build autocomplete vocab: union of (a) canonical fixture keys + (b) keys
  // observed across all forms.
  const fixture = loadFixture();
  for (const k of Object.keys(fixture)) vocabSet.add(k);
  // High-priority canonical keys that may not be in the fixture
  for (const k of [
    'buyer_initials', 'seller_initials', 'buyer_signature', 'seller_signature',
    'buyer_1_name', 'buyer_2_name', 'seller_1_name', 'seller_2_name',
    'property_address_line1', 'state', 'zip',
    'addendum_propane', 'addendum_seller_financing', 'addendum_1031', 'addendum_hoa',
    'addendum_buyers_lease', 'addendum_environmental', 'addendum_short_sale',
    'addendum_oil_gas', 'addendum_coastal',
    'hoa_present', 'hoa_not_present',
    'buyer_pays_title_policy', 'seller_pays_title_policy',
    'possession_at_closing', 'possession_after_closing',
    'sales_price_total', 'sales_price_cash', 'sales_price_financing',
    'option_period_end_date', 'financing_contingency_end_date',
    'title_company_address', 'earnest_holder_address',
    'notes', 'ignore',
  ]) vocabSet.add(k);
  const autocompleteVocab = [...vocabSet]
    .filter(k => typeof k === 'string' && k.trim().length > 0)
    .sort();
  console.log(`Autocomplete vocab: ${autocompleteVocab.length} keys`);

  // Inject _meta so the labeler can read globals
  dataset._meta = {
    autocomplete_vocab: autocompleteVocab,
    heath_forms: [...HEATH_FORMS],
    auto_accept_thresholds: AUTO_ACCEPT_THRESHOLD_BY_FORM,
    build_version: 'v4',
  };

  // Deferred review file — for Atlas/Hadley post-flight (NOT shown to Heath)
  const deferredByForm = {};
  for (const item of deferredItems) {
    deferredByForm[item.form_id] = (deferredByForm[item.form_id] || 0) + 1;
  }
  writeFileSync(DEFERRED_OUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    build_version: 'v4',
    auto_accept_thresholds: AUTO_ACCEPT_THRESHOLD_BY_FORM,
    heath_forms: [...HEATH_FORMS],
    deferred_items: deferredItems,
    summary_by_form: Object.fromEntries(
      Object.entries(stats).map(([k, v]) => [k, {
        deferred: deferredByForm[k] || 0,
        total: v.total,
        threshold: v.threshold,
        is_heath_form: v.isHeathForm,
      }])
    ),
  }, null, 2));
  console.log(`Deferred review: ${DEFERRED_OUT} (${deferredItems.length} items)`);

  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const buildTime = new Date().toISOString();

  // JSON.stringify is safe inside a <script> block as long as we escape </script>.
  const json = JSON.stringify(dataset).replace(/<\/script>/gi, '<\\/script>');
  const literal = JSON.stringify(json);

  const html = template
    .replace('/* __EMBEDDED_DATASET__ */"__PLACEHOLDER__"', () => literal)
    .replace('__BUILD_TIME__', () => buildTime);

  writeFileSync(REPO_OUT, html, 'utf8');
  console.log(`Wrote ${REPO_OUT} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);

  try {
    writeFileSync(DESKTOP_OUT, html, 'utf8');
    console.log(`Wrote ${DESKTOP_OUT} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    console.warn(`WARN: could not write Desktop copy: ${err.message}`);
  }

  console.log(`Build OK at ${buildTime}`);
  const totalWidgets = Object.values(stats).reduce((n, s) => n + s.total, 0);
  const totalPages = Object.values(stats).reduce((n, s) => n + s.pages, 0);
  const totalUnmatched = Object.values(stats).reduce((n, s) => n + s.unmatched, 0);
  const totalAutoAccept = Object.values(stats).reduce((n, s) => n + s.autoAccept, 0);
  const totalInGroup = Object.values(stats).reduce((n, s) => n + s.inGroup, 0);
  const totalGroupCount = Object.values(stats).reduce((n, s) => n + s.groupCount, 0);
  const totalHeathSees = Object.values(stats).reduce((n, s) => n + s.heathSees, 0);
  const totalHadley = Object.values(stats).reduce((n, s) => n + s.fromHadley, 0);
  console.log(`\n=== V4 SUMMARY ===`);
  console.log(`  Totals: ${totalWidgets} widgets · ${totalPages} pages across 7 forms`);
  console.log(`  Unmatched: ${totalUnmatched}`);
  console.log(`  Hadley pre-labels:    ${totalHadley}`);
  console.log(`  LLM auto-accept:      ${totalAutoAccept} (per-form threshold)`);
  console.log(`  Pattern groups:       ${totalGroupCount} groups covering ${totalInGroup} widgets`);
  console.log(`  Deferred review:      ${deferredItems.length} (Atlas/Hadley post-flight)`);
  console.log(`  Heath manual labels:  ~${totalHeathSees} (on trec-20-18 + trec-40 only)`);
  console.log(`\n  Per-form (v4):`);
  console.log(`    ${'form'.padEnd(12)} total  conf  unm   auto  group  Hadley  Heath  threshold  mode`);
  for (const [fid, s] of Object.entries(stats)) {
    const mode = s.isHeathForm ? 'HEATH' : 'AUTO';
    console.log(
      `    ${fid.padEnd(12)} ${String(s.total).padStart(5)}  ${String(s.confident).padStart(4)}  ${String(s.unmatched).padStart(4)}  ${String(s.autoAccept).padStart(4)}  ${String(s.inGroup).padStart(5)}  ${String(s.fromHadley).padStart(6)}  ${String(s.heathSees).padStart(5)}  ${String(s.threshold).padStart(9)}  ${mode}${s.hadleyLoaded ? ' (Hadley)' : ''}`
    );
  }
  const estSec = totalHeathSees * 4;
  console.log(`\n  Estimated Heath labeling time: ~${Math.ceil(estSec / 60)} min (4s/widget w/ autocomplete + visual).`);
}

function pct(n, d) { return d > 0 ? (100 * n / d).toFixed(0) : '0'; }

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
