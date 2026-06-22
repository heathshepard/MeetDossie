#!/usr/bin/env node
/**
 * llm-enrich-widgets.mjs — Use Claude Haiku 4.5 to semantically label
 * unmatched widgets in TREC forms.
 *
 * For each unmatched widget:
 *   1. Extract surrounding contract text (300-500 chars around the widget rect)
 *   2. Send to Claude Haiku 4.5 with a labeling prompt
 *   3. Cache the LLM response in scripts/.llm-widget-cache.json
 *   4. Output enriched-report JSONs the labeler can consume
 *
 * Cache key: sha1(form_id + widget_index + surrounding_text)
 * Cache means re-runs are free if the input data hasn't changed.
 *
 * Cost: ~$0.001 per widget × ~332 widgets ≈ $0.30 total.
 *
 * Usage:
 *   node scripts/trec-labeler/llm-enrich-widgets.mjs
 *   node scripts/trec-labeler/llm-enrich-widgets.mjs --form trec-20-18
 *   node scripts/trec-labeler/llm-enrich-widgets.mjs --dry      # show widget→prompt mapping, no API calls
 *
 * Env: ANTHROPIC_API_KEY (read from .env.local or process.env).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..', '..');

const CACHE_PATH = join(REPO_ROOT, 'scripts', '.llm-widget-cache.json');
const ENRICHED_DIR = join(REPO_ROOT, 'scripts');
const ENRICHED_OF = (formId) => join(ENRICHED_DIR, `.${formId}-llm-enriched.json`);

const FORM_IDS = [
  'trec-20-18',
  'trec-40',
  'trec-39-10',
  'op-h',
  'trec-36-11',
  'trec-38-7',
  'op-l',
];

const FORM_NAMES = {
  'trec-20-18': 'TREC 20-18 Resale Contract (One-to-Four Family Residential)',
  'trec-40': 'TREC 40 Third-Party Financing Addendum',
  'trec-39-10': 'TREC 39-10 Amendment to Contract',
  'op-h': "TREC OP-H Seller's Disclosure Notice",
  'trec-36-11': 'TREC 36-11 HOA Addendum',
  'trec-38-7': 'TREC 38-7 Notice of Buyer to Terminate',
  'op-l': 'TREC OP-L Lead-Based Paint Addendum',
};

const PDF_OF = (formId) => join(REPO_ROOT, 'api', '_assets', `${formId}-raw.pdf`);
const REPORT_OF = (formId) => join(REPO_ROOT, 'scripts', `.${formId}-unmatched-report.json`);

// --- Args ---
const args = process.argv.slice(2);
const FORM_FILTER = (() => {
  const i = args.indexOf('--form');
  return i >= 0 ? args[i+1] : null;
})();
const DRY = args.includes('--dry');

// --- Anthropic key from .env.local + system env ---
function loadDotenv() {
  const p = join(REPO_ROOT, '.env.local');
  if (!existsSync(p)) return;
  const raw = readFileSync(p, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)="?(.*?)"?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
if (!ANTHROPIC_KEY && !DRY) {
  console.error('FATAL: ANTHROPIC_API_KEY not set. Add to .env.local or set in shell.');
  process.exit(1);
}

// --- Cache ---
let cache = {};
if (existsSync(CACHE_PATH)) {
  try { cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { cache = {}; }
}
function cacheKey(formId, widgetIndex, context) {
  return createHash('sha1').update(`${formId}|${widgetIndex}|${context}`).digest('hex').slice(0, 16);
}
function saveCache() {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

// --- PDF text + widget geometry ---
/**
 * Returns {
 *   widgets: [{ index, page, x, y, w, h, field_name, field_type }],
 *   textByPage: { 1: [{str, x, y, w, h}], ... }
 * }
 */
async function extractPdfDataForLLM(formId) {
  const pdfPath = PDF_OF(formId);
  if (!existsSync(pdfPath)) {
    console.warn(`  WARN: no PDF at ${pdfPath}`);
    return { widgets: [], textByPage: {} };
  }
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc = await getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;

  const widgets = [];
  const textByPage = {};
  let widgetGlobalIndex = 0;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const annots = await page.getAnnotations({ intent: 'display' });
    const ws = annots.filter(a => a.subtype === 'Widget');
    for (const w of ws) {
      const rect = w.rect;
      if (!rect || rect.length !== 4) {
        widgetGlobalIndex++;
        continue;
      }
      const x = Math.min(rect[0], rect[2]);
      const x2 = Math.max(rect[0], rect[2]);
      const y = Math.min(rect[1], rect[3]);
      const y2 = Math.max(rect[1], rect[3]);
      let ftype = 'text';
      if (w.fieldType === 'Btn') ftype = 'checkbox';
      else if (w.fieldType === 'Sig') ftype = 'signature';
      widgets.push({
        index: widgetGlobalIndex,
        field_name: w.fieldName || w.alternativeText || '',
        field_type: ftype,
        page: pageNum,
        x, y,
        w: x2 - x,
        h: y2 - y,
      });
      widgetGlobalIndex++;
    }
    // Text content
    const tc = await page.getTextContent({ disableCombineTextItems: false });
    const items = [];
    for (const it of tc.items) {
      const str = (it.str || '').replace(/\s+/g, ' ').trim();
      if (!str) continue;
      const tr = it.transform || [];
      const tx = tr[4] || 0;
      const ty = tr[5] || 0;
      const tw = it.width || (str.length * 4);
      const th = it.height || 10;
      items.push({ str, x: tx, y: ty, w: tw, h: th });
    }
    textByPage[pageNum] = items;
  }
  return { widgets, textByPage };
}

/**
 * Build a contextual text snippet around a widget. Strategy:
 *   - All text items on the same page within a vertical band 80pt above
 *     and 25pt below the widget's vertical center.
 *   - All text items on lines whose Y matches the widget's baseline within 14pt
 *     (the immediate sentence the widget is in).
 *   - Sorted reading order: top-to-bottom (PDF y desc), then left-to-right (x asc).
 *   - Truncated to ~500 chars to keep prompt small.
 */
function buildContext(textItems, widget) {
  const yCenter = widget.y + widget.h / 2;
  const yTop    = yCenter + 80;      // (PDF y grows up — "above" = higher y)
  const yBot    = yCenter - 25;
  const nearby = textItems.filter(t => {
    const tyc = t.y + (t.h / 2);
    return tyc <= yTop && tyc >= yBot;
  });
  // sort top-to-bottom (PDF y desc), then left-to-right
  nearby.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  // Group by approximate line baseline (within 4pt)
  const lines = [];
  let curLine = null;
  for (const t of nearby) {
    if (!curLine || Math.abs(t.y - curLine.y) > 4) {
      curLine = { y: t.y, strs: [] };
      lines.push(curLine);
    }
    curLine.strs.push(t.str);
  }
  let text = lines.map(l => l.strs.join(' ')).join('\n');
  if (text.length > 800) text = text.slice(0, 800);
  return text;
}

/**
 * Find which top-level numbered section the widget belongs to. Heuristic:
 * look UP from the widget for the most recent line starting with a digit + period
 * (e.g., "4. LEASES" or "12A. EARNEST MONEY").
 */
function inferSection(textItems, widget) {
  const yCenter = widget.y + widget.h / 2;
  const above = textItems
    .filter(t => t.y > yCenter && t.y < yCenter + 400)
    .filter(t => /^\d+[A-Za-z]?\.\s/.test(t.str) || /^[A-Z]\.\s/.test(t.str))
    .sort((a, b) => a.y - b.y); // closest to widget first
  return above[0] ? above[0].str.slice(0, 120) : '';
}

// --- Prompt ---
const KNOWN_KEY_GUIDE = `
Conventions for fixture_key (snake_case):
- Boolean checkboxes: addendum_<name> (e.g. addendum_propane, addendum_seller_financing, addendum_1031, addendum_hoa, addendum_buyers_lease), or <thing>_<state> (e.g. hoa_present, hoa_not_present, buyer_pays_title_policy, seller_pays_title_policy, possession_at_closing, possession_after_closing).
- Text fields:
  - Parties: buyer_names, seller_names, buyer_1_name, buyer_2_name, seller_1_name, seller_2_name
  - Property: property_address_line1, city, state, zip, county, lot, block, addition, legal_description
  - Money: sales_price_total, sales_price_cash, sales_price_financing, earnest_money, option_fee, loan_amount
  - Dates: effective_date, closing_date, option_period_days, option_period_end_date, financing_contingency_end_date
  - Agent info: buyer_agent_name, buyer_agent_email, buyer_agent_phone, buyer_broker_name, buyer_broker_license, seller_agent_name, seller_agent_email, seller_agent_phone, seller_broker_name, seller_broker_license
  - Title: title_company_name, title_company_address, earnest_holder_name, earnest_holder_address
  - Special: special_provisions, notes (default catch-all)
- Initials lines: buyer_initials, seller_initials (use these for the small initial-line widgets at page bottoms)
- Signatures: buyer_signature, seller_signature
- If the widget is clearly NOT a fillable field (e.g., a page-number stamp, a graphic checkbox that's decorative), return fixture_key="ignore".
- Use "notes" only as a last resort — prefer a more specific key whenever possible.
`.trim();

async function callClaude(prompt) {
  const body = {
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json.content || []).map(c => c.text || '').join('');
  return { text, usage: json.usage || {} };
}

function buildPrompt(formName, widget, section, surroundingText, atlasSpatialGuess) {
  return `You are labeling fields in a Texas TREC real estate form.

Form: ${formName}
Widget on page ${widget.page}
Widget field-name (from the PDF AcroForm): "${widget.field_name || '(blank)'}"
Widget type: ${widget.field_type}
Widget position (PDF points): x=${Math.round(widget.x)}, y=${Math.round(widget.y)}, w=${Math.round(widget.w || widget.width || 0)}, h=${Math.round(widget.h || widget.height || 0)}
Nearest numbered section heading above this widget: "${section || '(unknown)'}"
Atlas's spatial best guess (weak; may be wrong): ${atlasSpatialGuess || '(none)'}

Surrounding contract text near this widget (top→bottom, the widget sits inside this region):
"""
${surroundingText || '(no nearby text)'}
"""

${KNOWN_KEY_GUIDE}

What does this widget represent? Output ONLY a single JSON object on one line, no markdown, no commentary:
{"fixture_key":"snake_case_canonical_name","confidence":0.85,"reasoning":"one short sentence"}`;
}

function parseLlmReply(text) {
  // Strip code fences if present
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  // First well-formed JSON object on a line
  const m = t.match(/\{[\s\S]*?\}/);
  if (!m) throw new Error('No JSON in response: ' + text.slice(0, 200));
  const obj = JSON.parse(m[0]);
  if (!obj.fixture_key) throw new Error('Missing fixture_key in: ' + m[0]);
  obj.confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
  obj.fixture_key = String(obj.fixture_key).trim().replace(/^[`'"]|[`'"]$/g, '');
  return obj;
}

async function enrichForm(formId) {
  console.log(`\n=== ${formId} ===`);
  const reportPath = REPORT_OF(formId);
  if (!existsSync(reportPath)) {
    console.log(`  no unmatched report — skipping`);
    return null;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const unmatched = report.unmatched || [];
  if (unmatched.length === 0) {
    console.log(`  zero unmatched — skipping`);
    writeFileSync(ENRICHED_OF(formId), JSON.stringify({ form_id: formId, llm_guesses: {} }, null, 2));
    return { formId, total: 0, cached: 0, called: 0, failed: 0, autoAccept: 0, likely: 0, lowConf: 0 };
  }
  console.log(`  ${unmatched.length} unmatched widgets to enrich`);

  const { widgets: allWidgets, textByPage } = await extractPdfDataForLLM(formId);
  const widgetByIndex = new Map(allWidgets.map(w => [w.index, w]));

  const llmGuesses = {};
  let calls = 0, cached = 0, failed = 0, autoAccept = 0, likely = 0, lowConf = 0;
  let totalIn = 0, totalOut = 0;

  for (const u of unmatched) {
    const widget = widgetByIndex.get(u.index) || {
      index: u.index, field_name: u.field_name, field_type: u.field_type,
      page: u.page || 1, x: u.x || 0, y: u.y || 0, w: u.width || 0, h: u.height || 0,
    };
    const pageText = textByPage[widget.page] || [];
    const context = buildContext(pageText, widget);
    const section = inferSection(pageText, widget);
    const key = cacheKey(formId, widget.index, context);

    if (cache[key] && !process.env.LLM_RECACHE) {
      llmGuesses[widget.index] = cache[key];
      cached++;
    } else {
      const prompt = buildPrompt(
        FORM_NAMES[formId] || formId,
        widget,
        section,
        context,
        u.best_label_fixture_key
      );
      if (DRY) {
        if (calls < 2) {
          console.log(`  [DRY] widget ${widget.index} (${widget.field_type}):`);
          console.log(`    section: ${section}`);
          console.log(`    context: ${context.slice(0, 150).replace(/\n/g, ' | ')}…`);
        }
        calls++;
        continue;
      }
      try {
        const { text, usage } = await callClaude(prompt);
        const obj = parseLlmReply(text);
        llmGuesses[widget.index] = obj;
        cache[key] = obj;
        totalIn  += usage.input_tokens  || 0;
        totalOut += usage.output_tokens || 0;
        calls++;
        if (calls % 20 === 0) {
          saveCache();
          process.stdout.write(`  …${calls} called (${cached} cached)\n`);
        }
      } catch (err) {
        failed++;
        console.warn(`  FAIL widget ${widget.index}: ${err.message}`);
      }
    }
    const g = llmGuesses[widget.index];
    if (g) {
      if (g.confidence >= 0.90) autoAccept++;
      else if (g.confidence >= 0.70) likely++;
      else lowConf++;
    }
  }
  saveCache();
  writeFileSync(ENRICHED_OF(formId), JSON.stringify({
    form_id: formId,
    total_unmatched: unmatched.length,
    llm_guesses: llmGuesses,
    generated_at: new Date().toISOString(),
  }, null, 2));
  console.log(`  done: ${calls} API calls, ${cached} cached, ${failed} failed`);
  console.log(`  buckets: ${autoAccept} auto-accept (≥0.90), ${likely} likely (0.70-0.90), ${lowConf} low-conf (<0.70)`);
  if (totalIn || totalOut) {
    const cost = (totalIn / 1e6) * 1.0 + (totalOut / 1e6) * 5.0; // Haiku 4.5 pricing
    console.log(`  tokens: ${totalIn} in / ${totalOut} out · approx cost $${cost.toFixed(4)}`);
  }
  return { formId, total: unmatched.length, cached, called: calls, failed, autoAccept, likely, lowConf };
}

async function main() {
  const ids = FORM_FILTER ? [FORM_FILTER] : FORM_IDS;
  const summaries = [];
  for (const id of ids) {
    const s = await enrichForm(id);
    if (s) summaries.push(s);
  }
  console.log('\n=== SUMMARY ===');
  let totalUnmatched = 0, totalAutoAccept = 0, totalLikely = 0, totalLow = 0, totalCalls = 0, totalCached = 0;
  for (const s of summaries) {
    console.log(`  ${s.formId.padEnd(12)}: ${s.total} unmatched | ${s.autoAccept} auto-accept (${pct(s.autoAccept, s.total)}%) | ${s.likely} likely (${pct(s.likely, s.total)}%) | ${s.lowConf} low (${pct(s.lowConf, s.total)}%)`);
    totalUnmatched += s.total;
    totalAutoAccept += s.autoAccept;
    totalLikely += s.likely;
    totalLow += s.lowConf;
    totalCalls += s.called;
    totalCached += s.cached;
  }
  console.log(`  ALL         : ${totalUnmatched} unmatched | ${totalAutoAccept} auto-accept (${pct(totalAutoAccept, totalUnmatched)}%) | ${totalLikely} likely (${pct(totalLikely, totalUnmatched)}%) | ${totalLow} low (${pct(totalLow, totalUnmatched)}%)`);
  console.log(`  ${totalCalls} new API calls, ${totalCached} cache hits`);
}

function pct(n, d) { return d > 0 ? (100 * n / d).toFixed(0) : '0'; }

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
