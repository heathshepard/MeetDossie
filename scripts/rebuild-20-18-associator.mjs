#!/usr/bin/env node
// scripts/rebuild-20-18-associator.mjs
//
// Atlas — TREC 20-18 widget associator (rebuild)
//
// Reads:    api/_assets/trec-20-18-raw.pdf
// Writes:   scripts/.trec-20-18-unmatched-report.md
//           scripts/.trec-20-18-unmatched-report.json
//           scripts/.trec-20-18-validation-table.json
//
// Rule: every widget is either CONFIDENT_MATCH or UNMATCHED.
// ZERO entries fall into a catch-all `notes` bucket.
//
// Algorithm (documented inline + in the report):
//  1. For each page, pull every widget annotation (rect, fieldName, fieldType).
//  2. For each page, pull every text item with x/y/width/height/text.
//  3. Score each widget against every text item on its page:
//        - prefer text whose right-edge is to the LEFT of widget.left
//          and whose vertical center is within ±half-widget-height
//          (label sits on the same baseline, just before the blank line)
//        - secondary: text directly ABOVE within 30pt (column header pattern)
//        - distance-decay: closer = better
//  4. Take the top label. Run it through a fixture-key keyword catalog.
//     If a confident keyword hit exists -> CONFIDENT_MATCH.
//     Else                              -> UNMATCHED.
//  5. Skip widgets whose AcroForm name is a page-number ("Page X of 10").
//
// Scoring weights are constants near the top and re-printed in the report.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

// ----------------------------------------------------------------------------
// Tunables (also surfaced in the report so Heath can see what drove decisions)
// ----------------------------------------------------------------------------
const PROXIMITY_RADIUS_PT       = 100;   // hard limit for "near" labels
const SAME_BASELINE_TOL_PT      = 8;     // vertical tolerance for "on same line"
const LEFT_LABEL_MAX_GAP_PT     = 220;   // how far left of widget a same-line label can sit
const ABOVE_LABEL_MAX_GAP_PT    = 30;    // how far above a header label can sit
const CONFIDENT_MIN_SCORE       = 0.55;  // [0..1] floor for CONFIDENT_MATCH
const NEAREST_TO_REPORT         = 3;     // how many nearby labels to log on unmatched

const SCORE_WEIGHTS = {
  same_baseline_left  : 1.00, // label ends just before widget, same baseline -- strongest
  directly_above      : 0.85, // text sits within ABOVE_LABEL_MAX_GAP_PT above widget
  same_baseline_right : 0.35, // label after widget on same line -- weaker (suffix label)
  general_proximity   : 0.25, // anywhere else within radius
  keyword_hit_bonus   : 0.20, // bumps score when label string contains a fixture keyword
  exact_keyword_phrase: 0.30, // bumps when the entire fixture phrase is present
};

// ----------------------------------------------------------------------------
// Fixture-key keyword catalog
// ----------------------------------------------------------------------------
// Each entry: an internal fixture key, plus the label substrings (lowercase)
// that strongly signal that key. ORDER MATTERS WHEN PHRASES OVERLAP:
//   - more-specific phrases must come BEFORE less-specific ones, because the
//     matcher prefers longer-phrase hits and uses catalog order as a tiebreaker.
//   - `weak: true` entries are last-resort hits, easily beaten by anything stronger.
const FIXTURE_CATALOG = [
  // --- Addenda checkboxes (PUT FIRST — these phrases are very specific and
  //     overlap with broader words like "seller", "financing") -----------------
  { key: 'addendum_coastal',                phrases: ['property located seaward', 'coastal area', 'coastal'] },
  { key: 'addendum_propane',                phrases: ['propane gas system', 'propane gas', 'propane'] },
  { key: 'addendum_oil_gas',                phrases: ['reservation of oil', 'oil gas and minerals', 'oil, gas'] },
  { key: 'addendum_other_property_sale',    phrases: ['sale of other property by'] },
  { key: 'addendum_1031',                   phrases: ['section 1031', '1031 exchange'] },
  { key: 'addendum_environmental',          phrases: ['environmental assessment', 'threatened or endangered'] },
  { key: 'addendum_short_sale',             phrases: ['short sale addendum', 'short sale'] },
  { key: 'addendum_buyers_lease',           phrases: ['buyers temporary residential lease', 'buyers temporary', "buyer's temporary"] },
  { key: 'addendum_sellers_lease',          phrases: ['sellers temporary residential lease', 'sellers temporary', "seller's temporary"] },
  { key: 'addendum_loan_assumption',        phrases: ['loan assumption addendum', 'loan assumption'] },
  { key: 'backup_contract',                 phrases: ['back-up contract', 'backup contract', 'back up contract', 'addendum for backup'] },
  { key: 'third_party_financing_addendum',  phrases: ['third party financing addendum', 'third party financing'] },
  { key: 'seller_financing_addendum',       phrases: ['seller financing addendum'] },
  { key: 'hoa_addendum',                    phrases: ['property owners associations', 'property owners association', 'mandatory membership'] },
  { key: 'lead_paint_addendum',             phrases: ['lead-based paint', 'lead based paint'] },

  // --- Parties --------------------------------------------------------------
  { key: 'buyer_names',         phrases: ['parties to this contract', 'as buyer'] },
  { key: 'seller_names',        phrases: ['as seller', 'seller and'] },
  { key: 'buyer_names',         phrases: ['buyer'], weak: true },
  { key: 'seller_names',        phrases: ['seller'], weak: true },

  // --- Property -------------------------------------------------------------
  { key: 'addition',            phrases: ['addition'] },
  { key: 'city',                phrases: ['city of'] },
  { key: 'county',              phrases: ['county of'] },
  { key: 'lot',                 phrases: ['lot'] },
  { key: 'block',               phrases: ['block'] },
  { key: 'legal_description',   phrases: ['texas known as', 'known as'] },
  { key: 'property_address_line1', phrases: ['address of property', 'street address', 'addr of prop'] },
  { key: 'property_address_line1', phrases: ['address'], weak: true },

  // --- Address sub-fields ---------------------------------------------------
  { key: 'city',                phrases: ['city'], weak: true },
  { key: 'property_state',      phrases: ['state'] },
  { key: 'property_zip',        phrases: ['zip code', 'zip'] },

  // --- Consideration --------------------------------------------------------
  { key: 'sales_price',         phrases: ['total sales price', 'sales price', 'cash portion'] },
  { key: 'earnest_money',       phrases: ['earnest money'] },
  { key: 'option_fee',          phrases: ['option fee'] },
  { key: 'option_period_days',  phrases: ['option period', 'days after'] },

  // --- Title / escrow -------------------------------------------------------
  { key: 'title_company',       phrases: ['title policy', 'title company', 'insurance title policy'] },
  { key: 'earnest_holder_name', phrases: ['escrow agent', 'escrow holder'] },
  { key: 'escrow_officer',      phrases: ['escrow officer'] },
  { key: 'escrow_officer_email',phrases: ['escrow officer email'] },

  // --- Financing (specific keys BEFORE generic financing_contingency) -------
  { key: 'loan_amount',             phrases: ['loan amount', 'sum of all financing'] },
  { key: 'financing_approval_days', phrases: ['days for buyer to obtain', 'approval no later'] },
  { key: 'financing_type',          phrases: ['conventional', 'fha', 'va loan'] },
  { key: 'financing_contingency',   phrases: ['financing approval', 'financing addendum'] },

  // --- Dates ----------------------------------------------------------------
  { key: 'closing_date',        phrases: ['closing of the sale', 'closing date', 'close on or before'] },
  { key: 'possession_date',     phrases: ['possession'] },
  { key: 'effective_date',      phrases: ['effective date', 'executed', 'date of final acceptance'] },

  // --- Survey / HOA / Disclosures ------------------------------------------
  { key: 'survey_required',     phrases: ['survey'] },
  { key: 'hoa_present',         phrases: ['membership in property owners'] },
  { key: 'hoa_dues',            phrases: ['association dues', 'transfer fee', 'private transfer fee'] },
  { key: 'lead_paint_disclosure',phrases: ['lead'] },
  { key: 'repairs_required',    phrases: ['specific repairs', 'repairs and treatments', 'repairs'] },
  { key: 'homeowners_warranty_limit', phrases: ['residential service contract', 'service contract'] },
  { key: 'special_provisions',  phrases: ['special provisions'] },

  // --- Brokerage ------------------------------------------------------------
  { key: 'listing_broker_firm',        phrases: ['listing broker firm', 'listing brokers office', 'listing broker'] },
  { key: 'listing_agent_name',         phrases: ['listing associates name', 'listing associate'] },
  { key: 'listing_agent_email',        phrases: ['listing associates email'] },
  { key: 'listing_agent_phone',        phrases: ['listing phone'] },
  { key: 'listing_agent_supervisor',   phrases: ['licensed supervisor of listing'] },
  { key: 'selling_agent_name',         phrases: ['selling associates name', 'selling associate'] },
  { key: 'selling_agent_email',        phrases: ['selling associates email'] },
  { key: 'selling_agent_phone',        phrases: ['selling associates office', 'selling phone'] },
  { key: 'selling_agent_supervisor',   phrases: ['licensed supervisor of selling'] },
  { key: 'other_broker_firm',          phrases: ['other broker firm', 'other brokers address', 'other broker'] },
  { key: 'buyer_broker_firm',          phrases: ['buyer broker'] },
  { key: 'seller_broker_firm',         phrases: ['seller broker'] },
  { key: 'buyer_commission_percent',   phrases: ['buyer commission'] },
  { key: 'seller_commission_percent',  phrases: ['seller commission'] },
  { key: 'listing_broker_compensation',phrases: ['listing brokers fee', 'listing broker fee'] },
  { key: 'other_broker_compensation',  phrases: ['other broker from'] },

  // --- Signatures / initials -----------------------------------------------
  { key: 'buyer_initials',     phrases: ['initialed for identification by buyer', 'buyer initial'] },
  { key: 'seller_initials',    phrases: ['and seller', 'seller initial'] },
  { key: 'buyer_signature_date', phrases: ['buyer signature date'] },
  { key: 'seller_signature_date',phrases: ['seller signature date'] },

  // --- Contact (broad / weak last) -----------------------------------------
  { key: 'listing_agent_email',    phrases: ['email address', 'email'], weak: true },
  { key: 'listing_agent_phone',    phrases: ['phone', 'fax'], weak: true },
  { key: 'listing_broker_license', phrases: ['license no'], weak: true },
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function norm(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isPageNumberFieldName(name) {
  return /^page\s+\d+\s+of\s+\d+$/i.test((name || '').trim());
}

function isPageNumberText(s) {
  return /^page\s+\d+\s+of\s+\d+$/i.test((s || '').trim());
}

function rectCenter(rect) {
  return { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 };
}

function distance(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

// Geometric relationship of a text-item box vs widget box (PDF coords: y grows up).
// leftGapLimit param lets callers tighten the same-baseline-left radius for
// dense widget blocks (checkbox columns) so labels don't leak between rows.
function relate(widget, textItem, leftGapLimit = LEFT_LABEL_MAX_GAP_PT) {
  const wLeft   = widget.x;
  const wRight  = widget.x + widget.w;
  const wTop    = widget.y + widget.h;
  const wBottom = widget.y;

  const tLeft   = textItem.x;
  const tRight  = textItem.x + textItem.w;
  const tBaselineY = textItem.y;          // baseline
  const tTop    = textItem.y + textItem.h;

  // Same baseline = vertical overlap of widget's vertical span and text's vertical span
  const verticalOverlap = !(tTop < wBottom - SAME_BASELINE_TOL_PT
                         || tBaselineY > wTop + SAME_BASELINE_TOL_PT);

  if (verticalOverlap) {
    if (tRight <= wLeft + 2) {
      const gap = wLeft - tRight;
      if (gap <= leftGapLimit) {
        return { rel: 'same_baseline_left', gap };
      }
    } else if (tLeft >= wRight - 2) {
      const gap = tLeft - wRight;
      if (gap <= leftGapLimit) {
        return { rel: 'same_baseline_right', gap };
      }
    } else {
      // text overlaps widget horizontally -- unusual, treat as proximity
      return { rel: 'general_proximity', gap: 0 };
    }
  }

  // Directly above
  if (tBaselineY > wTop && tBaselineY - wTop <= ABOVE_LABEL_MAX_GAP_PT) {
    const horizontalOverlap = !(tRight < wLeft - 20 || tLeft > wRight + 20);
    if (horizontalOverlap) {
      const gap = tBaselineY - wTop;
      return { rel: 'directly_above', gap };
    }
  }

  // General proximity radius
  const { cx: wcx, cy: wcy } = rectCenter({ x: widget.x, y: widget.y, w: widget.w, h: widget.h });
  const tcx = tLeft + textItem.w / 2;
  const tcy = tBaselineY + textItem.h / 2;
  const dist = distance(wcx, wcy, tcx, tcy);
  if (dist <= PROXIMITY_RADIUS_PT) {
    return { rel: 'general_proximity', gap: dist };
  }

  return null;
}

function scoreCandidate(rel, gap) {
  // Closer = better. Score = relation_weight * decay(gap)
  const w = SCORE_WEIGHTS[rel.rel] ?? 0;
  // Linear decay across the relation's allowed gap window.
  const maxGap = rel.rel === 'directly_above'
    ? ABOVE_LABEL_MAX_GAP_PT
    : (rel.rel === 'general_proximity' ? PROXIMITY_RADIUS_PT : LEFT_LABEL_MAX_GAP_PT);
  const decay = Math.max(0, 1 - (gap / maxGap));
  return w * decay;
}

// Look up the best fixture key for a given label phrase.
// Returns { key, hitPhrase, exact } or null.
// Priority: non-weak > weak; within same weakness, longer phrase wins;
// ties broken by earlier-in-catalog (so addenda-block phrases win over
// generic "buyer" / "seller" entries that appear later).
function matchFixtureKey(labelLower) {
  if (!labelLower) return null;
  let best = null;
  let bestCatalogIdx = -1;
  for (let i = 0; i < FIXTURE_CATALOG.length; i++) {
    const entry = FIXTURE_CATALOG[i];
    for (const phrase of entry.phrases) {
      if (labelLower.includes(phrase)) {
        const exact = labelLower === phrase;
        const cand = { key: entry.key, hitPhrase: phrase, exact, weak: !!entry.weak };
        let better = false;
        if (!best) {
          better = true;
        } else if (cand.weak === false && best.weak === true) {
          better = true;
        } else if (cand.weak === best.weak) {
          if (phrase.length > best.hitPhrase.length) better = true;
          else if (phrase.length === best.hitPhrase.length && i < bestCatalogIdx) better = true;
        }
        if (better) { best = cand; bestCatalogIdx = i; }
      }
    }
  }
  return best;
}

// Combine the AcroForm field name as an extra label candidate.
// Treat the AcroForm name as a "phantom" label at the widget center.
function fieldNameAsLabel(fieldName, widget) {
  return {
    str: fieldName,
    x: widget.x,
    y: widget.y + widget.h - 6,
    w: widget.w,
    h: 6,
    isFieldName: true,
  };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();

  // pdfjs-dist ESM legacy build
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Point at the worker .mjs so the fake-worker setup can resolve it
  if (pdfjs.GlobalWorkerOptions) {
    const workerPath = resolve(REPO_ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  }

  const pdfPath = resolve(REPO_ROOT, 'api/_assets/trec-20-18-raw.pdf');
  const data    = new Uint8Array(readFileSync(pdfPath));
  const doc     = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;

  const allWidgets = [];      // { index, fieldName, fieldType, page, x, y, w, h }
  const allTextByPage = {};   // page -> [{ str, x, y, w, h }]

  let widgetGlobalIndex = 0;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const pageHeight = viewport.height;

    // 1. Widgets
    const annots = await page.getAnnotations({ intent: 'display' });
    const widgets = annots.filter(a => a.subtype === 'Widget');
    for (const w of widgets) {
      const rect = w.rect; // [x1, y1, x2, y2] in PDF user space, y up
      if (!rect || rect.length !== 4) continue;
      const x = Math.min(rect[0], rect[2]);
      const x2 = Math.max(rect[0], rect[2]);
      const y = Math.min(rect[1], rect[3]);
      const y2 = Math.max(rect[1], rect[3]);
      const widget = {
        index: widgetGlobalIndex++,
        fieldName: w.fieldName || w.alternativeText || '',
        fieldType: w.fieldType || w.fieldFlags?.toString() || 'unknown',
        // pdfjs sets fieldType: 'Tx' | 'Btn' | 'Sig' | ...
        page: pageNum,
        x, y,
        w: x2 - x,
        h: y2 - y,
      };
      allWidgets.push(widget);
    }

    // 2. Text items
    const tc = await page.getTextContent({ disableCombineTextItems: false });
    const textItems = [];
    for (const it of tc.items) {
      const str = (it.str || '').replace(/\s+/g, ' ').trim();
      if (!str) continue;
      // transform = [a, b, c, d, e, f]; e=x, f=y of baseline-left
      const tr = it.transform || [];
      const tx = tr[4] || 0;
      const ty = tr[5] || 0;
      const tw = it.width || (str.length * 4);
      const th = it.height || 10;
      textItems.push({ str, x: tx, y: ty, w: tw, h: th });
    }
    allTextByPage[pageNum] = textItems;
  }

  // ----------------------------------------------------------------------------
  // Associate
  // ----------------------------------------------------------------------------
  const confidentMatches = [];
  const unmatched         = [];
  const skipped           = [];

  for (const widget of allWidgets) {
    // SKIP: page-number widgets
    if (isPageNumberFieldName(widget.fieldName)) {
      skipped.push({
        index: widget.index,
        field_name: widget.fieldName,
        page: widget.page,
        reason: 'page_number_field',
      });
      continue;
    }

    const isCheckbox = (widget.fieldType === 'Btn');
    const isSignature = (widget.fieldType === 'Sig');

    const pageText = allTextByPage[widget.page] || [];
    // Add the AcroForm field name itself as a phantom label
    const phantom = fieldNameAsLabel(widget.fieldName, widget);

    // Tighten the left-label gap for checkbox widgets -- a TREC checkbox's
    // own label sits within ~10-15pt of the box. Anything farther is almost
    // certainly an adjacent checkbox's label leaking in.
    const leftGapLimit = isCheckbox ? 18 : LEFT_LABEL_MAX_GAP_PT;

    // Score every text item on the page
    const ranked = [];
    for (const t of pageText) {
      if (isPageNumberText(t.str)) continue;
      const rel = relate(widget, t, leftGapLimit);
      if (!rel) continue;
      // Checkboxes in dense columns: ignore "directly_above" -- a label
      // above a checkbox is the row above's label, not this row's.
      if (isCheckbox && rel.rel === 'directly_above') continue;
      // Same for general_proximity hits on checkboxes -- too noisy.
      if (isCheckbox && rel.rel === 'general_proximity') continue;
      const base = scoreCandidate(rel, rel.gap);
      const fxMatch = matchFixtureKey(norm(t.str));
      const fxBonus = fxMatch ? (fxMatch.exact
        ? SCORE_WEIGHTS.exact_keyword_phrase
        : SCORE_WEIGHTS.keyword_hit_bonus) : 0;
      ranked.push({
        text: t.str,
        x: t.x, y: t.y,
        rel: rel.rel,
        gap: rel.gap,
        score: base + fxBonus,
        fxMatch,
      });
    }

    // Score the AcroForm field name as a "free" label.
    // For CHECKBOXES, the field name IS the addendum label (e.g. "Short Sale
    // Addendum"). Give it full credit. For text fields it's secondary metadata.
    {
      const fxMatch = matchFixtureKey(norm(widget.fieldName));
      const fieldNameWeight = isCheckbox ? 1.0 : 0.5;
      const base = SCORE_WEIGHTS.same_baseline_left * fieldNameWeight;
      const fxBonus = fxMatch ? (fxMatch.exact
        ? SCORE_WEIGHTS.exact_keyword_phrase
        : SCORE_WEIGHTS.keyword_hit_bonus) : 0;
      ranked.push({
        text: `[field-name] ${widget.fieldName}`,
        x: phantom.x, y: phantom.y,
        rel: 'same_baseline_left',
        gap: 0,
        score: base + fxBonus,
        fxMatch,
        fromFieldName: true,
      });
    }

    ranked.sort((a, b) => b.score - a.score);

    // Pick the top candidate that actually maps to a fixture key
    const topWithKey = ranked.find(r => r.fxMatch);
    const top         = ranked[0];

    // Sanity check: if the AcroForm field name is meaningful (not "undefined_*",
    // not a 1-3 char artifact) AND shares no meaningful tokens with the
    // proposed match, demote the score. Prevents adjacent labels from
    // claiming a widget whose own field name clearly belongs elsewhere.
    if (topWithKey && !topWithKey.fromFieldName) {
      const fnTokens = meaningfulTokens(widget.fieldName);
      if (fnTokens.length >= 1 && !isGenericFieldName(widget.fieldName)) {
        const labelTokens = meaningfulTokens(topWithKey.text + ' ' + topWithKey.fxMatch.key);
        const overlap = fnTokens.some(t => labelTokens.includes(t));
        if (!overlap) {
          topWithKey.score = topWithKey.score - 0.4;
          topWithKey._demotedReason = 'field-name and matched label share no meaningful tokens';
        }
      }
    }

    if (topWithKey && topWithKey.score >= CONFIDENT_MIN_SCORE) {
      // Type sanity:
      //   - checkbox widget must map to a boolean fixture key
      //   - text widget must NOT map to a boolean fixture key
      const looksBoolean = isBooleanFixtureKey(topWithKey.fxMatch.key);
      const typeOK = isCheckbox ? looksBoolean : !looksBoolean;
      if (!typeOK) {
        unmatched.push({
          index: widget.index,
          field_name: widget.fieldName,
          page: widget.page,
          x: round(widget.x), y: round(widget.y),
          width: round(widget.w), height: round(widget.h),
          field_type: isCheckbox ? 'checkbox' : (isSignature ? 'signature' : 'text'),
          best_label_guess: topWithKey.text,
          best_label_score: round(topWithKey.score, 3),
          best_label_fixture_key: topWithKey.fxMatch.key,
          nearest_labels_within_100px: top3Nearby(widget, pageText),
          reason_no_match: isCheckbox
            ? `type mismatch: checkbox widget mapped to text key '${topWithKey.fxMatch.key}' -- need a boolean fixture key`
            : `type mismatch: text widget mapped to boolean key '${topWithKey.fxMatch.key}' -- nearby checkbox label leaked; needs human label`,
        });
        continue;
      }

      confidentMatches.push({
        index: widget.index,
        field_name: widget.fieldName,
        page: widget.page,
        field_type: isCheckbox ? 'checkbox' : (isSignature ? 'signature' : 'text'),
        fixture_key: topWithKey.fxMatch.key,
        confidence_score: round(topWithKey.score, 3),
        evidence: {
          label: topWithKey.text,
          relation: topWithKey.rel,
          gap_pt: round(topWithKey.gap, 1),
          matched_phrase: topWithKey.fxMatch.hitPhrase,
          exact: topWithKey.fxMatch.exact,
          from_field_name: !!topWithKey.fromFieldName,
        },
      });
    } else {
      // No confident keyword match -- surface for human label
      const nearest = top3Nearby(widget, pageText);
      let reason;
      if (nearest.length === 0) {
        reason = 'no labels within 100px';
      } else if (top && top.fxMatch && top.score < CONFIDENT_MIN_SCORE) {
        reason = `weak match: label '${top.text}' would map to '${top.fxMatch.key}' but score ${round(top.score, 3)} < threshold ${CONFIDENT_MIN_SCORE}`;
      } else if (top && !top.fxMatch) {
        reason = `label found '${top.text}' but no matching fixture key exists for it`;
      } else if (nearest.length >= 2 && Math.abs(nearest[0].distance - nearest[1].distance) < 4) {
        reason = `equidistant between '${nearest[0].text}' and '${nearest[1].text}' -- can't disambiguate`;
      } else {
        reason = 'fixture catalog missing a key for the best nearby label';
      }
      unmatched.push({
        index: widget.index,
        field_name: widget.fieldName,
        page: widget.page,
        x: round(widget.x), y: round(widget.y),
        width: round(widget.w), height: round(widget.h),
        field_type: isCheckbox ? 'checkbox' : (isSignature ? 'signature' : 'text'),
        nearest_labels_within_100px: nearest,
        reason_no_match: reason,
      });
    }
  }

  // ----------------------------------------------------------------------------
  // Validation table (PASS / FLAGGED / FAIL)
  // ----------------------------------------------------------------------------
  const validation = [];
  for (const m of confidentMatches) {
    let status = 'PASS';
    if (m.fixture_key === 'notes') status = 'FAIL';
    validation.push({
      index: m.index, page: m.page, field_name: m.field_name,
      field_type: m.field_type, fixture_key: m.fixture_key,
      confidence_score: m.confidence_score, status,
    });
  }
  for (const u of unmatched) {
    validation.push({
      index: u.index, page: u.page, field_name: u.field_name,
      field_type: u.field_type, fixture_key: null,
      confidence_score: null, status: 'FLAGGED',
    });
  }
  for (const s of skipped) {
    validation.push({
      index: s.index, page: s.page, field_name: s.field_name,
      field_type: 'page-label', fixture_key: null, confidence_score: null,
      status: 'SKIP',
    });
  }
  validation.sort((a, b) => a.index - b.index);

  // ----------------------------------------------------------------------------
  // Write outputs
  // ----------------------------------------------------------------------------
  const stats = {
    total_widgets: allWidgets.length,
    confident_match: confidentMatches.length,
    unmatched: unmatched.length,
    skip: skipped.length,
    pct_confident: round(100 * confidentMatches.length / allWidgets.length, 1),
    pct_unmatched: round(100 * unmatched.length / allWidgets.length, 1),
  };

  const reportJsonPath = resolve(REPO_ROOT, 'scripts/.trec-20-18-unmatched-report.json');
  const reportMdPath   = resolve(REPO_ROOT, 'scripts/.trec-20-18-unmatched-report.md');
  const validationPath = resolve(REPO_ROOT, 'scripts/.trec-20-18-validation-table.json');

  writeFileSync(reportJsonPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    form: 'TREC 20-18',
    algorithm: {
      proximity_radius_pt: PROXIMITY_RADIUS_PT,
      same_baseline_tol_pt: SAME_BASELINE_TOL_PT,
      left_label_max_gap_pt: LEFT_LABEL_MAX_GAP_PT,
      above_label_max_gap_pt: ABOVE_LABEL_MAX_GAP_PT,
      confident_min_score: CONFIDENT_MIN_SCORE,
      score_weights: SCORE_WEIGHTS,
    },
    stats,
    confident_matches: confidentMatches,
    unmatched,
    skipped,
  }, null, 2));

  writeFileSync(validationPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    stats: {
      PASS:     validation.filter(v => v.status === 'PASS').length,
      FLAGGED:  validation.filter(v => v.status === 'FLAGGED').length,
      FAIL:     validation.filter(v => v.status === 'FAIL').length,
      SKIP:     validation.filter(v => v.status === 'SKIP').length,
    },
    table: validation,
  }, null, 2));

  writeFileSync(reportMdPath, buildMarkdown({
    stats, confidentMatches, unmatched, skipped,
    weights: SCORE_WEIGHTS, threshold: CONFIDENT_MIN_SCORE,
  }));

  const ms = Date.now() - t0;
  // Final stdout summary -- piped back to Atlas's parent
  console.log(JSON.stringify({
    report_md: reportMdPath,
    report_json: reportJsonPath,
    validation_json: validationPath,
    ...stats,
    elapsed_ms: ms,
  }, null, 2));
}

// ----------------------------------------------------------------------------
// utilities
// ----------------------------------------------------------------------------
function round(n, digits = 0) {
  const k = Math.pow(10, digits);
  return Math.round(n * k) / k;
}

function isGenericFieldName(name) {
  if (!name) return true;
  const n = name.toLowerCase().trim();
  if (n === '' || n.length < 4) return true;
  if (/^undefined(_\d+)?(-\d+)?$/.test(n)) return true;
  if (/^check\s*box\s*\d+$/i.test(n)) return true;
  if (/^check\s*box\d+$/i.test(n)) return true;
  if (/^text\s*\d+(\s*\d+)?$/i.test(n)) return true;
  if (/^date(_\d+)?$/i.test(n)) return true;
  if (/^datetime(_\d+)?$/i.test(n)) return true;
  if (/^ac\d+|ac\s+numb/i.test(n)) return true;
  if (/^signature\d+$/i.test(n)) return true;
  if (/^(at|is|will|other|phone|fax|state|zip|city|email|address)(_\d+)?$/i.test(n)) return true;
  return false;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','of','to','for','in','on','as','by','with','at','is','are','was','were','this',
  'that','these','those','contract','party','parties','addendum','property','from','until','within','about',
  'between','seller','buyer', // demoting these here keeps generic seller/buyer text from "matching" anywhere
]);

function meaningfulTokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));
}

function isBooleanFixtureKey(key) {
  // Heuristic: addendum_* keys, *_required, *_present, *_contingency are boolean-ish.
  // Also: a small allow-list of explicit booleans.
  if (!key) return false;
  if (key.startsWith('addendum_')) return true;
  if (/_required$|_present$|_contingency$|_disclosure$/.test(key)) return true;
  const booleanAllow = new Set([
    'hoa_addendum', 'lead_paint_addendum', 'termination_for_appraisal',
    'backup_contract', 'third_party_financing_addendum', 'seller_financing_addendum',
    'homeowners_warranty_required',
  ]);
  return booleanAllow.has(key);
}

function top3Nearby(widget, pageText) {
  const wcx = widget.x + widget.w / 2;
  const wcy = widget.y + widget.h / 2;
  const cands = [];
  for (const t of pageText) {
    if (isPageNumberText(t.str)) continue;
    const tcx = t.x + t.w / 2;
    const tcy = t.y + t.h / 2;
    const d = distance(wcx, wcy, tcx, tcy);
    if (d <= PROXIMITY_RADIUS_PT) {
      const dir = direction(widget, t);
      cands.push({ text: t.str, distance: round(d, 1), direction: dir });
    }
  }
  cands.sort((a, b) => a.distance - b.distance);
  return cands.slice(0, NEAREST_TO_REPORT);
}

function direction(widget, t) {
  const wcx = widget.x + widget.w / 2;
  const wcy = widget.y + widget.h / 2;
  const tcx = t.x + t.w / 2;
  const tcy = t.y + t.h / 2;
  const dx = tcx - wcx;
  const dy = tcy - wcy;
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy > 0 ? 'above' : 'below';
}

function buildMarkdown({ stats, confidentMatches, unmatched, skipped, weights, threshold }) {
  const lines = [];
  lines.push('# TREC 20-18 — Unmatched-Fields Report (rebuilt associator)');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Form: TREC 20-18 — One-to-Four Family Residential Contract (Resale)`);
  lines.push('');
  lines.push('## Rule of the new associator');
  lines.push('');
  lines.push('Every widget is either **CONFIDENT MATCH** or **UNMATCHED — NEEDS HUMAN LABEL**.');
  lines.push('There is no `notes` catch-all. If a widget cannot be confidently mapped to a known fixture key, it is flagged for Heath to label.');
  lines.push('');
  lines.push('## Stats');
  lines.push('');
  lines.push(`- Total widgets: **${stats.total_widgets}**`);
  lines.push(`- CONFIDENT MATCH: **${stats.confident_match}** (${stats.pct_confident}%)`);
  lines.push(`- UNMATCHED (need human label): **${stats.unmatched}** (${stats.pct_unmatched}%)`);
  lines.push(`- SKIP (page-number labels etc.): **${stats.skip}**`);
  lines.push('');
  lines.push('## Algorithm');
  lines.push('');
  lines.push('1. Extract every AcroForm widget rectangle per page (pdfjs-dist annotation layer).');
  lines.push('2. Extract every text item per page with x/y/width/height (pdfjs-dist getTextContent).');
  lines.push('3. Score each text item against the widget using spatial relation + keyword match:');
  lines.push('');
  lines.push('   | Relation | Weight |');
  lines.push('   |---|---|');
  for (const [k, v] of Object.entries(weights)) {
    lines.push(`   | \`${k}\` | ${v} |`);
  }
  lines.push('');
  lines.push(`4. Score = relation_weight * linear_decay(gap) + keyword_bonus.`);
  lines.push(`5. The widget is a CONFIDENT MATCH iff the top scored label maps to a fixture key with score >= **${threshold}** AND (for checkboxes) the fixture key is boolean-typed.`);
  lines.push('6. Otherwise the widget is UNMATCHED, with the 3 nearest labels within 100pt logged for Heath to label.');
  lines.push('');
  lines.push('## CONFIDENT MATCHES');
  lines.push('');
  lines.push('| # | Page | Field name | Type | Fixture key | Score | Evidence |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const m of confidentMatches) {
    lines.push(`| ${m.index} | ${m.page} | \`${escMd(m.field_name)}\` | ${m.field_type} | **${m.fixture_key}** | ${m.confidence_score} | ${escMd(m.evidence.relation)} via '${escMd(m.evidence.label)}' (match \`${escMd(m.evidence.matched_phrase)}\`) |`);
  }
  lines.push('');
  lines.push('## UNMATCHED — NEEDS HUMAN LABEL');
  lines.push('');
  lines.push('Heath: label each with a fixture key (or "ignore" / "needs new key").');
  lines.push('');
  for (const u of unmatched) {
    lines.push(`### #${u.index} — page ${u.page} — \`${escMd(u.field_name)}\` (${u.field_type})`);
    lines.push('');
    lines.push(`- Rect: x=${u.x} y=${u.y} w=${u.width} h=${u.height}`);
    lines.push(`- Reason: ${escMd(u.reason_no_match)}`);
    if (u.best_label_guess) {
      lines.push(`- Best guess: '${escMd(u.best_label_guess)}' -> \`${u.best_label_fixture_key}\` (score ${u.best_label_score})`);
    }
    if (u.nearest_labels_within_100px.length === 0) {
      lines.push(`- Nearby labels: (none within 100pt)`);
    } else {
      lines.push(`- Nearby labels (top ${u.nearest_labels_within_100px.length}):`);
      for (const n of u.nearest_labels_within_100px) {
        lines.push(`  - \`${escMd(n.text)}\` -- ${n.distance}pt ${n.direction}`);
      }
    }
    lines.push('');
    lines.push(`**Heath label:** \`__________________\``);
    lines.push('');
  }
  lines.push('## SKIP');
  lines.push('');
  for (const s of skipped) {
    lines.push(`- #${s.index} page ${s.page}: \`${escMd(s.field_name)}\` -- ${s.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

function escMd(s) {
  return (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

main().catch(err => {
  console.error('REBUILD-ASSOCIATOR ERROR:', err && err.stack || err);
  process.exit(1);
});
