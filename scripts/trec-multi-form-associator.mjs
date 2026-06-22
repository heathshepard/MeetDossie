#!/usr/bin/env node
// scripts/trec-multi-form-associator.mjs
//
// Atlas — Generic TREC form widget associator (v2 / multi-form).
//
// Based on rebuild-20-18-associator.mjs but parameterised by form-id so it can
// run against any of the 7 TREC forms we ship to the labeler:
//   - trec-20-18   One-to-Four Family Residential (Resale)
//   - trec-40      Third-Party Financing Addendum
//   - trec-39-10   Amendment
//   - op-h         Seller's Disclosure
//   - trec-36-11   HOA Addendum
//   - trec-38-7    Notice of Termination
//   - op-l         Lead-Based Paint Addendum
//
// Usage:
//   node scripts/trec-multi-form-associator.mjs <form-id>
//   node scripts/trec-multi-form-associator.mjs --all
//
// Reads:    api/_assets/<form-id>-raw.pdf
// Writes:   scripts/.<form-id>-unmatched-report.json
//           scripts/.<form-id>-unmatched-report.md
//           scripts/.<form-id>-validation-table.json
//
// Rule: every widget is either CONFIDENT_MATCH or UNMATCHED.
// ZERO catch-all `notes` bucket.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = resolve(__dirname, '..');

// ----------------------------------------------------------------------------
// Form registry
// ----------------------------------------------------------------------------
const FORMS = {
  'trec-20-18': {
    label: 'TREC 20-18 One-to-Four Family Residential Contract (Resale)',
    rawPdf: 'api/_assets/trec-20-18-raw.pdf',
  },
  'trec-40': {
    label: 'TREC 40 Third-Party Financing Addendum',
    rawPdf: 'api/_assets/trec-40-raw.pdf',
  },
  'trec-39-10': {
    label: 'TREC 39-10 Amendment',
    rawPdf: 'api/_assets/trec-39-10-raw.pdf',
  },
  'op-h': {
    label: "OP-H Seller's Disclosure Notice",
    rawPdf: 'api/_assets/op-h-raw.pdf',
  },
  'trec-36-11': {
    label: 'TREC 36-11 Addendum for Property Subject to Mandatory HOA Membership',
    rawPdf: 'api/_assets/trec-36-11-raw.pdf',
  },
  'trec-38-7': {
    label: 'TREC 38-7 Notice of Buyer\'s Termination of Contract',
    rawPdf: 'api/_assets/trec-38-7-raw.pdf',
  },
  'op-l': {
    label: 'OP-L Lead-Based Paint Addendum',
    rawPdf: 'api/_assets/op-l-raw.pdf',
  },
};

// ----------------------------------------------------------------------------
// Tunables (identical to rebuild-20-18-associator so output schema matches)
// ----------------------------------------------------------------------------
const PROXIMITY_RADIUS_PT       = 100;
const SAME_BASELINE_TOL_PT      = 8;
const LEFT_LABEL_MAX_GAP_PT     = 220;
const ABOVE_LABEL_MAX_GAP_PT    = 30;
const CONFIDENT_MIN_SCORE       = 0.55;
const NEAREST_TO_REPORT         = 3;

const SCORE_WEIGHTS = {
  same_baseline_left  : 1.00,
  directly_above      : 0.85,
  same_baseline_right : 0.35,
  general_proximity   : 0.25,
  keyword_hit_bonus   : 0.20,
  exact_keyword_phrase: 0.30,
};

// ----------------------------------------------------------------------------
// Fixture catalog — broadened to cover all 7 forms.
// Form-specific keys ALSO valid for 20-18 (no harm — they just don't fire
// when 20-18 doesn't have a label that matches). Keep more-specific phrases
// before less-specific.
// ----------------------------------------------------------------------------
const FIXTURE_CATALOG = [
  // -------------------------------------------------------------------------
  // Addenda checkboxes (cross-form)
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Parties
  // -------------------------------------------------------------------------
  { key: 'buyer_names',         phrases: ['parties to this contract', 'as buyer'] },
  { key: 'seller_names',        phrases: ['as seller', 'seller and'] },
  { key: 'buyer_names',         phrases: ['buyer'], weak: true },
  { key: 'seller_names',        phrases: ['seller'], weak: true },

  // -------------------------------------------------------------------------
  // Property
  // -------------------------------------------------------------------------
  { key: 'addition',            phrases: ['addition'] },
  { key: 'city',                phrases: ['city of'] },
  { key: 'county',              phrases: ['county of'] },
  { key: 'lot',                 phrases: ['lot'] },
  { key: 'block',               phrases: ['block'] },
  { key: 'legal_description',   phrases: ['texas known as', 'known as'] },
  { key: 'property_address_line1', phrases: ['address of property', 'street address', 'addr of prop'] },
  { key: 'property_address_line1', phrases: ['address'], weak: true },
  { key: 'city',                phrases: ['city'], weak: true },
  { key: 'property_state',      phrases: ['state'] },
  { key: 'property_zip',        phrases: ['zip code', 'zip'] },

  // -------------------------------------------------------------------------
  // Consideration / money
  // -------------------------------------------------------------------------
  { key: 'sales_price',         phrases: ['total sales price', 'sales price', 'cash portion'] },
  { key: 'earnest_money',       phrases: ['earnest money'] },
  { key: 'option_fee',          phrases: ['option fee'] },
  { key: 'option_period_days',  phrases: ['option period', 'days after'] },

  // -------------------------------------------------------------------------
  // Title / escrow
  // -------------------------------------------------------------------------
  { key: 'title_company',       phrases: ['title policy', 'title company', 'insurance title policy'] },
  { key: 'earnest_holder_name', phrases: ['escrow agent', 'escrow holder'] },
  { key: 'escrow_officer',      phrases: ['escrow officer'] },
  { key: 'escrow_officer_email',phrases: ['escrow officer email'] },

  // -------------------------------------------------------------------------
  // Financing (TREC 40 heavy hits)
  // -------------------------------------------------------------------------
  { key: 'loan_amount',                     phrases: ['loan amount', 'sum of all financing'] },
  { key: 'down_payment',                    phrases: ['down payment'] },
  { key: 'loan_term_years',                 phrases: ['term of', 'years', 'amortization'] },
  { key: 'interest_rate_max_percent',       phrases: ['interest rate not to exceed', 'interest rate'] },
  { key: 'origination_charge_percent',      phrases: ['origination charge'] },
  { key: 'financing_approval_days',         phrases: ['days for buyer to obtain', 'approval no later', 'days after the effective date'] },
  { key: 'financing_type',                  phrases: ['conventional', 'fha', 'va loan', 'usda', 'reverse mortgage'] },
  { key: 'financing_contingency',           phrases: ['financing approval', 'financing addendum'] },
  { key: 'appraisal_value',                 phrases: ['appraised value', 'opinion of value'] },
  { key: 'lender_name',                     phrases: ['lender'] },
  { key: 'fha_va_buyer_paid',               phrases: ['fha discount', 'va discount'] },

  // -------------------------------------------------------------------------
  // Dates
  // -------------------------------------------------------------------------
  { key: 'closing_date',        phrases: ['closing of the sale', 'closing date', 'close on or before'] },
  { key: 'possession_date',     phrases: ['possession'] },
  { key: 'effective_date',      phrases: ['effective date', 'executed', 'date of final acceptance'] },
  { key: 'termination_date',    phrases: ['termination date', 'date of termination', 'notice date'] },

  // -------------------------------------------------------------------------
  // Survey / HOA / Disclosures
  // -------------------------------------------------------------------------
  { key: 'survey_required',     phrases: ['survey'] },
  { key: 'hoa_present',         phrases: ['membership in property owners'] },
  { key: 'hoa_dues',            phrases: ['association dues', 'transfer fee', 'private transfer fee'] },
  { key: 'lead_paint_disclosure',phrases: ['lead'] },
  { key: 'repairs_required',    phrases: ['specific repairs', 'repairs and treatments', 'repairs'] },
  { key: 'homeowners_warranty_limit', phrases: ['residential service contract', 'service contract'] },
  { key: 'special_provisions',  phrases: ['special provisions'] },

  // -------------------------------------------------------------------------
  // HOA Addendum (TREC 36-11)
  // -------------------------------------------------------------------------
  { key: 'hoa_name_primary',       phrases: ['association', 'name of association'] },
  { key: 'hoa_phone',              phrases: ['phone number of association', 'phone'] },
  { key: 'hoa_management_company', phrases: ['management company'] },
  { key: 'subdivision_information',phrases: ['subdivision information'] },
  { key: 'resale_certificate',     phrases: ['resale certificate'] },
  { key: 'hoa_days_to_deliver',    phrases: ['days after'] },
  { key: 'hoa_fee_paid_by',        phrases: ['who pays', 'paid by'] },

  // -------------------------------------------------------------------------
  // Amendment (TREC 39-10)
  // -------------------------------------------------------------------------
  { key: 'contract_concerning_property', phrases: ['contract concerning'] },
  { key: 'amendment_purpose',            phrases: ['amend the contract', 'contract is amended', 'amended as follows'] },
  { key: 'new_sales_price',              phrases: ['new sales price', 'sales price is changed'] },
  { key: 'new_closing_date',             phrases: ['closing date is changed', 'new closing date'] },
  { key: 'option_fee_extension',         phrases: ['option fee', 'option period'] },

  // -------------------------------------------------------------------------
  // Termination (TREC 38-7)
  // -------------------------------------------------------------------------
  { key: 'termination_reason_option_fee', phrases: ['termination option', 'unrestricted right'] },
  { key: 'termination_reason_other',      phrases: ['other:', 'other reason'] },
  { key: 'earnest_money_release_to_buyer', phrases: ['released to buyer', 'refund of earnest'] },
  { key: 'earnest_money_release_to_seller',phrases: ['released to seller'] },

  // -------------------------------------------------------------------------
  // Seller's Disclosure (OP-H) — a LOT of yes/no/unknown rows
  // -------------------------------------------------------------------------
  { key: 'seller_occupies',         phrases: ['seller is', 'is occupying', 'not occupying'] },
  { key: 'years_owned',             phrases: ['years', 'how long', 'occupied the property'] },
  { key: 'item_range_oven',         phrases: ['range', 'oven'] },
  { key: 'item_microwave',          phrases: ['microwave'] },
  { key: 'item_dishwasher',         phrases: ['dishwasher'] },
  { key: 'item_trash_compactor',    phrases: ['trash compactor'] },
  { key: 'item_disposal',           phrases: ['disposal'] },
  { key: 'item_washer_dryer',       phrases: ['washer', 'dryer'] },
  { key: 'item_window_screens',     phrases: ['window screens'] },
  { key: 'item_rain_gutters',       phrases: ['rain gutters'] },
  { key: 'item_security_system',    phrases: ['security system'] },
  { key: 'item_smoke_detector',     phrases: ['smoke detector'] },
  { key: 'item_intercom',           phrases: ['intercom'] },
  { key: 'item_tv_antenna',         phrases: ['tv antenna', 'antenna'] },
  { key: 'item_cable_tv',           phrases: ['cable tv', 'satellite dish'] },
  { key: 'item_ceiling_fans',       phrases: ['ceiling fans'] },
  { key: 'item_attic_fans',         phrases: ['attic fans'] },
  { key: 'item_exhaust_fans',       phrases: ['exhaust fans'] },
  { key: 'item_central_ac',         phrases: ['central a/c', 'central ac'] },
  { key: 'item_central_heating',    phrases: ['central heating'] },
  { key: 'item_wall_ac',            phrases: ['wall', 'window units'] },
  { key: 'item_evaporative_coolers',phrases: ['evaporative coolers'] },
  { key: 'item_plumbing',           phrases: ['plumbing'] },
  { key: 'item_water_heater',       phrases: ['water heater'] },
  { key: 'item_water_softener',     phrases: ['water softener'] },
  { key: 'item_gas_fixtures',       phrases: ['gas fixtures'] },
  { key: 'item_fireplace',          phrases: ['fireplace', 'chimney'] },
  { key: 'item_natural_gas_lines',  phrases: ['natural gas lines'] },
  { key: 'item_pool',               phrases: ['pool', 'pool equipment'] },
  { key: 'item_hot_tub',            phrases: ['hot tub', 'spa'] },
  { key: 'item_sprinkler',          phrases: ['sprinkler', 'lawn sprinkler'] },
  { key: 'item_septic',             phrases: ['septic', 'septic system'] },
  { key: 'item_outdoor_grill',      phrases: ['outdoor grill'] },
  { key: 'item_fences',             phrases: ['fences'] },
  { key: 'item_satellite_dish',     phrases: ['satellite'] },
  { key: 'item_garage_door_opener', phrases: ['garage door opener'] },
  { key: 'item_water_well',         phrases: ['water well'] },
  { key: 'condition_basement',      phrases: ['basement'] },
  { key: 'condition_walls',         phrases: ['walls', 'fences'] },
  { key: 'condition_ceiling',       phrases: ['ceiling', 'attic'] },
  { key: 'condition_floors',        phrases: ['floors'] },
  { key: 'condition_foundation',    phrases: ['foundation', 'slab'] },
  { key: 'condition_roof',          phrases: ['roof'] },
  { key: 'condition_doors',         phrases: ['doors'] },
  { key: 'condition_windows',       phrases: ['windows'] },
  { key: 'condition_driveways',     phrases: ['driveways'] },
  { key: 'condition_sidewalks',     phrases: ['sidewalks'] },
  { key: 'condition_electrical',    phrases: ['electrical systems', 'electrical'] },
  { key: 'condition_lighting',      phrases: ['lighting fixtures'] },
  { key: 'condition_other_structural', phrases: ['other structural'] },
  { key: 'aware_active_termites',   phrases: ['active termites'] },
  { key: 'aware_termite_damage',    phrases: ['previous termite damage'] },
  { key: 'aware_termite_treatment', phrases: ['previous termite treatment'] },
  { key: 'aware_water_penetration', phrases: ['water penetration'] },
  { key: 'aware_flood_insurance',   phrases: ['flood insurance', 'flood'] },
  { key: 'aware_present_flood_insurance', phrases: ['present flood insurance'] },
  { key: 'aware_previous_flooding', phrases: ['previous flooding'] },
  { key: 'aware_flood_pool',        phrases: ['flood pool', 'controlled flood'] },
  { key: 'aware_radon_gas',         phrases: ['radon gas'] },
  { key: 'aware_asbestos',          phrases: ['asbestos'] },
  { key: 'aware_urea',              phrases: ['urea-formaldehyde'] },
  { key: 'aware_lead_paint',        phrases: ['lead based paint', 'lead-based paint'] },
  { key: 'aware_underground_tanks', phrases: ['underground storage'] },
  { key: 'aware_landfill',          phrases: ['landfill'] },
  { key: 'aware_subsurface',        phrases: ['subsurface structure'] },
  { key: 'aware_settling',          phrases: ['settling', 'soil movement', 'fault lines'] },

  // -------------------------------------------------------------------------
  // Lead Paint (OP-L)
  // -------------------------------------------------------------------------
  { key: 'lp_presence_known',         phrases: ['known lead', 'presence of lead'] },
  { key: 'lp_no_knowledge',           phrases: ['no knowledge'] },
  { key: 'lp_records_provided',       phrases: ['records available', 'reports available'] },
  { key: 'lp_no_reports',             phrases: ['no reports'] },
  { key: 'lp_buyer_received_pamphlet',phrases: ['lead warning', 'pamphlet'] },
  { key: 'lp_10_day_inspection',      phrases: ['10-day', 'opportunity to conduct'] },
  { key: 'lp_waived_inspection',      phrases: ['waived'] },

  // -------------------------------------------------------------------------
  // Brokerage (TREC 20-18 + others)
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Signatures / initials
  // -------------------------------------------------------------------------
  { key: 'buyer_initials',     phrases: ['initialed for identification by buyer', 'buyer initial'] },
  { key: 'seller_initials',    phrases: ['and seller', 'seller initial'] },
  { key: 'buyer_signature_date', phrases: ['buyer signature date'] },
  { key: 'seller_signature_date',phrases: ['seller signature date'] },

  // -------------------------------------------------------------------------
  // Contact (broad / weak last)
  // -------------------------------------------------------------------------
  { key: 'listing_agent_email',    phrases: ['email address', 'email'], weak: true },
  { key: 'listing_agent_phone',    phrases: ['phone', 'fax'], weak: true },
  { key: 'listing_broker_license', phrases: ['license no'], weak: true },
];

// ----------------------------------------------------------------------------
// Helpers (identical to rebuild-20-18)
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
function relate(widget, textItem, leftGapLimit = LEFT_LABEL_MAX_GAP_PT) {
  const wLeft   = widget.x;
  const wRight  = widget.x + widget.w;
  const wTop    = widget.y + widget.h;
  const wBottom = widget.y;
  const tLeft   = textItem.x;
  const tRight  = textItem.x + textItem.w;
  const tBaselineY = textItem.y;
  const tTop    = textItem.y + textItem.h;
  const verticalOverlap = !(tTop < wBottom - SAME_BASELINE_TOL_PT
                         || tBaselineY > wTop + SAME_BASELINE_TOL_PT);
  if (verticalOverlap) {
    if (tRight <= wLeft + 2) {
      const gap = wLeft - tRight;
      if (gap <= leftGapLimit) return { rel: 'same_baseline_left', gap };
    } else if (tLeft >= wRight - 2) {
      const gap = tLeft - wRight;
      if (gap <= leftGapLimit) return { rel: 'same_baseline_right', gap };
    } else {
      return { rel: 'general_proximity', gap: 0 };
    }
  }
  if (tBaselineY > wTop && tBaselineY - wTop <= ABOVE_LABEL_MAX_GAP_PT) {
    const horizontalOverlap = !(tRight < wLeft - 20 || tLeft > wRight + 20);
    if (horizontalOverlap) {
      const gap = tBaselineY - wTop;
      return { rel: 'directly_above', gap };
    }
  }
  const { cx: wcx, cy: wcy } = rectCenter({ x: widget.x, y: widget.y, w: widget.w, h: widget.h });
  const tcx = tLeft + textItem.w / 2;
  const tcy = tBaselineY + textItem.h / 2;
  const dist = distance(wcx, wcy, tcx, tcy);
  if (dist <= PROXIMITY_RADIUS_PT) return { rel: 'general_proximity', gap: dist };
  return null;
}
function scoreCandidate(rel, gap) {
  const w = SCORE_WEIGHTS[rel.rel] ?? 0;
  const maxGap = rel.rel === 'directly_above'
    ? ABOVE_LABEL_MAX_GAP_PT
    : (rel.rel === 'general_proximity' ? PROXIMITY_RADIUS_PT : LEFT_LABEL_MAX_GAP_PT);
  const decay = Math.max(0, 1 - (gap / maxGap));
  return w * decay;
}
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
        if (!best) better = true;
        else if (cand.weak === false && best.weak === true) better = true;
        else if (cand.weak === best.weak) {
          if (phrase.length > best.hitPhrase.length) better = true;
          else if (phrase.length === best.hitPhrase.length && i < bestCatalogIdx) better = true;
        }
        if (better) { best = cand; bestCatalogIdx = i; }
      }
    }
  }
  return best;
}
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
  'between','seller','buyer',
]);
function meaningfulTokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));
}
function isBooleanFixtureKey(key) {
  if (!key) return false;
  if (key.startsWith('addendum_')) return true;
  if (key.startsWith('item_')) return true;
  if (key.startsWith('condition_')) return true;
  if (key.startsWith('aware_')) return true;
  if (key.startsWith('lp_')) return true;
  if (key.startsWith('termination_reason_')) return true;
  if (key.startsWith('earnest_money_release_')) return true;
  if (/_required$|_present$|_contingency$|_disclosure$/.test(key)) return true;
  const booleanAllow = new Set([
    'hoa_addendum', 'lead_paint_addendum', 'termination_for_appraisal',
    'backup_contract', 'third_party_financing_addendum', 'seller_financing_addendum',
    'homeowners_warranty_required', 'seller_occupies', 'resale_certificate',
    'subdivision_information',
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
function escMd(s) { return (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }

// ----------------------------------------------------------------------------
// Per-form runner
// ----------------------------------------------------------------------------
// Forms that ship with a coords-overlay (no AcroForm widgets in the PDF).
// We emit a synthetic "all confident" report from the coords map so the
// labeler still has something to show + the merger has something to patch.
const COORDS_OVERLAY_FORMS = {
  'trec-38-7': 'api/_assets/field-maps/trec-38-7-coords.json',
};

async function runCoordsOverlay(formId, formCfg) {
  const t0 = Date.now();
  const coordsPath = resolve(REPO_ROOT, COORDS_OVERLAY_FORMS[formId]);
  if (!existsSync(coordsPath)) {
    console.error(`SKIP ${formId}: coords-overlay file missing at ${coordsPath}`);
    return null;
  }
  const map = JSON.parse(readFileSync(coordsPath, 'utf8'));
  const confidentMatches = [];
  let idx = 0;
  for (const [key, f] of Object.entries(map.fields || {})) {
    const isCheckbox = f.type === 'checkbox';
    confidentMatches.push({
      index: idx++,
      field_name: key,
      page: f.page || 1,
      field_type: isCheckbox ? 'checkbox' : 'text',
      fixture_key: key,
      confidence_score: 1.0,
      evidence: {
        label: f.label || f.notes || key,
        relation: 'coords_overlay',
        gap_pt: 0,
        matched_phrase: key,
        exact: true,
        from_field_name: true,
      },
    });
  }
  const stats = {
    total_widgets: confidentMatches.length,
    confident_match: confidentMatches.length,
    unmatched: 0,
    skip: 0,
    pct_confident: 100,
    pct_unmatched: 0,
  };
  const reportJsonPath = resolve(REPO_ROOT, `scripts/.${formId}-unmatched-report.json`);
  const reportMdPath   = resolve(REPO_ROOT, `scripts/.${formId}-unmatched-report.md`);
  const validationPath = resolve(REPO_ROOT, `scripts/.${formId}-validation-table.json`);
  writeFileSync(reportJsonPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    form: formCfg.label,
    form_id: formId,
    note: 'No AcroForm widgets in this PDF — labeler reads from coords overlay map.',
    stats,
    confident_matches: confidentMatches,
    unmatched: [],
    skipped: [],
  }, null, 2));
  writeFileSync(validationPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    form_id: formId,
    stats: { PASS: confidentMatches.length, FLAGGED: 0, FAIL: 0, SKIP: 0 },
    table: confidentMatches.map(m => ({
      index: m.index, page: m.page, field_name: m.field_name,
      field_type: m.field_type, fixture_key: m.fixture_key,
      confidence_score: m.confidence_score, status: 'PASS',
    })),
  }, null, 2));
  const md = [];
  md.push(`# ${formCfg.label} — Coords Overlay Report`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Form ID: ${formId}`);
  md.push('');
  md.push('No AcroForm widgets — overlay PDF. All 15 fields imported from coords map.');
  md.push('');
  writeFileSync(reportMdPath, md.join('\n'));
  return {
    form_id: formId,
    label: formCfg.label,
    report_json: reportJsonPath,
    ...stats,
    elapsed_ms: Date.now() - t0,
  };
}

async function runForm(pdfjs, formId, formCfg) {
  if (COORDS_OVERLAY_FORMS[formId]) {
    return runCoordsOverlay(formId, formCfg);
  }
  const t0 = Date.now();
  const pdfPath = resolve(REPO_ROOT, formCfg.rawPdf);
  if (!existsSync(pdfPath)) {
    console.error(`SKIP ${formId}: raw pdf not found at ${pdfPath}`);
    return null;
  }
  const data = new Uint8Array(readFileSync(pdfPath));
  const doc  = await pdfjs.getDocument({ data, disableWorker: true, isEvalSupported: false }).promise;

  const allWidgets = [];
  const allTextByPage = {};
  let widgetGlobalIndex = 0;

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const annots = await page.getAnnotations({ intent: 'display' });
    const widgets = annots.filter(a => a.subtype === 'Widget');
    for (const w of widgets) {
      const rect = w.rect;
      if (!rect || rect.length !== 4) continue;
      const x = Math.min(rect[0], rect[2]);
      const x2 = Math.max(rect[0], rect[2]);
      const y = Math.min(rect[1], rect[3]);
      const y2 = Math.max(rect[1], rect[3]);
      allWidgets.push({
        index: widgetGlobalIndex++,
        fieldName: w.fieldName || w.alternativeText || '',
        fieldType: w.fieldType || 'unknown',
        page: pageNum,
        x, y,
        w: x2 - x,
        h: y2 - y,
      });
    }
    const tc = await page.getTextContent({ disableCombineTextItems: false });
    const textItems = [];
    for (const it of tc.items) {
      const str = (it.str || '').replace(/\s+/g, ' ').trim();
      if (!str) continue;
      const tr = it.transform || [];
      const tx = tr[4] || 0;
      const ty = tr[5] || 0;
      const tw = it.width || (str.length * 4);
      const th = it.height || 10;
      textItems.push({ str, x: tx, y: ty, w: tw, h: th });
    }
    allTextByPage[pageNum] = textItems;
  }

  const confidentMatches = [];
  const unmatched         = [];
  const skipped           = [];

  for (const widget of allWidgets) {
    if (isPageNumberFieldName(widget.fieldName)) {
      skipped.push({
        index: widget.index,
        field_name: widget.fieldName,
        page: widget.page,
        reason: 'page_number_field',
      });
      continue;
    }
    const isCheckbox  = (widget.fieldType === 'Btn');
    const isSignature = (widget.fieldType === 'Sig');
    const pageText    = allTextByPage[widget.page] || [];
    const phantom     = fieldNameAsLabel(widget.fieldName, widget);
    const leftGapLimit = isCheckbox ? 18 : LEFT_LABEL_MAX_GAP_PT;

    const ranked = [];
    for (const t of pageText) {
      if (isPageNumberText(t.str)) continue;
      const rel = relate(widget, t, leftGapLimit);
      if (!rel) continue;
      if (isCheckbox && rel.rel === 'directly_above') continue;
      if (isCheckbox && rel.rel === 'general_proximity') continue;
      const base = scoreCandidate(rel, rel.gap);
      const fxMatch = matchFixtureKey(norm(t.str));
      const fxBonus = fxMatch ? (fxMatch.exact
        ? SCORE_WEIGHTS.exact_keyword_phrase
        : SCORE_WEIGHTS.keyword_hit_bonus) : 0;
      ranked.push({
        text: t.str, x: t.x, y: t.y,
        rel: rel.rel, gap: rel.gap,
        score: base + fxBonus, fxMatch,
      });
    }
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
        rel: 'same_baseline_left', gap: 0,
        score: base + fxBonus, fxMatch,
        fromFieldName: true,
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    const topWithKey = ranked.find(r => r.fxMatch);
    const top         = ranked[0];

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
      const nearest = top3Nearby(widget, pageText);
      let reason;
      if (nearest.length === 0) reason = 'no labels within 100px';
      else if (top && top.fxMatch && top.score < CONFIDENT_MIN_SCORE) {
        reason = `weak match: label '${top.text}' would map to '${top.fxMatch.key}' but score ${round(top.score, 3)} < threshold ${CONFIDENT_MIN_SCORE}`;
      } else if (top && !top.fxMatch) {
        reason = `label found '${top.text}' but no matching fixture key exists for it`;
      } else if (nearest.length >= 2 && Math.abs(nearest[0].distance - nearest[1].distance) < 4) {
        reason = `equidistant between '${nearest[0].text}' and '${nearest[1].text}' -- can't disambiguate`;
      } else reason = 'fixture catalog missing a key for the best nearby label';
      unmatched.push({
        index: widget.index,
        field_name: widget.fieldName,
        page: widget.page,
        x: round(widget.x), y: round(widget.y),
        width: round(widget.w), height: round(widget.h),
        field_type: isCheckbox ? 'checkbox' : (isSignature ? 'signature' : 'text'),
        best_label_guess: top && top.fxMatch ? top.text : undefined,
        best_label_score: top && top.fxMatch ? round(top.score, 3) : undefined,
        best_label_fixture_key: top && top.fxMatch ? top.fxMatch.key : undefined,
        nearest_labels_within_100px: nearest,
        reason_no_match: reason,
      });
    }
  }

  const validation = [];
  for (const m of confidentMatches) {
    validation.push({
      index: m.index, page: m.page, field_name: m.field_name,
      field_type: m.field_type, fixture_key: m.fixture_key,
      confidence_score: m.confidence_score, status: 'PASS',
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

  const stats = {
    total_widgets: allWidgets.length,
    confident_match: confidentMatches.length,
    unmatched: unmatched.length,
    skip: skipped.length,
    pct_confident: allWidgets.length ? round(100 * confidentMatches.length / allWidgets.length, 1) : 0,
    pct_unmatched: allWidgets.length ? round(100 * unmatched.length / allWidgets.length, 1) : 0,
  };

  const reportJsonPath = resolve(REPO_ROOT, `scripts/.${formId}-unmatched-report.json`);
  const reportMdPath   = resolve(REPO_ROOT, `scripts/.${formId}-unmatched-report.md`);
  const validationPath = resolve(REPO_ROOT, `scripts/.${formId}-validation-table.json`);

  writeFileSync(reportJsonPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    form: formCfg.label,
    form_id: formId,
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
    form_id: formId,
    stats: {
      PASS:    validation.filter(v => v.status === 'PASS').length,
      FLAGGED: validation.filter(v => v.status === 'FLAGGED').length,
      FAIL:    validation.filter(v => v.status === 'FAIL').length,
      SKIP:    validation.filter(v => v.status === 'SKIP').length,
    },
    table: validation,
  }, null, 2));

  // Minimal markdown for parity with 20-18 (we don't use it for ingestion,
  // but merge-labeler-export.js patches it).
  const md = [];
  md.push(`# ${formCfg.label} — Unmatched-Fields Report`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Form ID: ${formId}`);
  md.push('');
  md.push('## Stats');
  md.push('');
  md.push(`- Total widgets: **${stats.total_widgets}**`);
  md.push(`- CONFIDENT MATCH: **${stats.confident_match}** (${stats.pct_confident}%)`);
  md.push(`- UNMATCHED: **${stats.unmatched}** (${stats.pct_unmatched}%)`);
  md.push(`- SKIP: **${stats.skip}**`);
  md.push('');
  md.push('## UNMATCHED — NEEDS HUMAN LABEL');
  md.push('');
  for (const u of unmatched) {
    md.push(`### #${u.index} — page ${u.page} — \`${escMd(u.field_name)}\` (${u.field_type})`);
    md.push('');
    md.push(`- Rect: x=${u.x} y=${u.y} w=${u.width} h=${u.height}`);
    md.push(`- Reason: ${escMd(u.reason_no_match)}`);
    if (u.best_label_guess) {
      md.push(`- Best guess: '${escMd(u.best_label_guess)}' -> \`${u.best_label_fixture_key}\` (score ${u.best_label_score})`);
    }
    if (!u.nearest_labels_within_100px || u.nearest_labels_within_100px.length === 0) {
      md.push(`- Nearby labels: (none within 100pt)`);
    } else {
      md.push(`- Nearby labels (top ${u.nearest_labels_within_100px.length}):`);
      for (const n of u.nearest_labels_within_100px) {
        md.push(`  - \`${escMd(n.text)}\` -- ${n.distance}pt ${n.direction}`);
      }
    }
    md.push('');
    md.push('**Heath label:** `__________________`');
    md.push('');
  }
  writeFileSync(reportMdPath, md.join('\n'));

  const elapsed_ms = Date.now() - t0;
  return {
    form_id: formId,
    label: formCfg.label,
    report_json: reportJsonPath,
    report_md: reportMdPath,
    validation_json: validationPath,
    ...stats,
    elapsed_ms,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('Usage: node trec-multi-form-associator.mjs <form-id|--all>');
    console.error('Forms:', Object.keys(FORMS).join(', '));
    process.exit(2);
  }
  const wantAll = argv.includes('--all');
  const targets = wantAll ? Object.keys(FORMS) : argv.filter(a => !a.startsWith('--'));

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (pdfjs.GlobalWorkerOptions) {
    const workerPath = resolve(REPO_ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  }

  const summaries = [];
  for (const formId of targets) {
    const cfg = FORMS[formId];
    if (!cfg) {
      console.error(`Unknown form-id: ${formId}`);
      continue;
    }
    process.stderr.write(`Running ${formId}...\n`);
    try {
      const s = await runForm(pdfjs, formId, cfg);
      if (s) summaries.push(s);
    } catch (err) {
      console.error(`FAIL ${formId}:`, err && err.stack || err);
      summaries.push({ form_id: formId, error: err.message });
    }
  }
  console.log(JSON.stringify(summaries, null, 2));
}

main().catch(err => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
