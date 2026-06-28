/**
 * api/_lib/trec-20-18-pipeline.js
 * =============================================================================
 * Layer-2 → Layer-3 wire-in for Heath's hand-built TREC 20-18 rules + validator.
 *
 * Pipeline:
 *   1. mapToAssignments(legacyFieldValues, intake)
 *      -> assignments = { fieldId: {value, confidence, matchReason} }
 *      keyed to fieldId values from scripts/trec-20-18-field-rules.json.
 *   2. validateWithRetry(rules, assignments, intake, extractCtx, opts)
 *      -> calls scripts/trec-validator.js validate(); on FAIL or UNMATCHED,
 *      re-runs LLM extraction (Opus 4.7) for ONLY the failing fieldIds,
 *      passing the rule.purpose + failure.reason as context. Max 2 retries
 *      per field. NEVER fabricates to pass — surfaces UNMATCHED for human review.
 *   3. fillableToLegacy(fillable)
 *      -> translates the validator's fillable map back into the legacy `fv.*`
 *      shape that api/fill-form.js fillResaleContract() expects, so the
 *      existing pdf-lib coord engine can render unchanged.
 *
 * Hard rules (per Heath, locked 2026-06-28):
 *   - DO NOT regenerate, rewrite, or "improve" the rules JSON.
 *   - DO NOT add a catch-all bucket. Every field is PASS | FAIL | SKIP | UNMATCHED.
 *   - Never fabricate values to pass validation. Surface UNMATCHED instead.
 *   - TREC 20-18 only. Never 20-17.
 *
 * Imports from scripts/ (Heath's source of truth):
 *   - scripts/trec-validator.js (Layer 3)
 *   - scripts/trec-20-18-field-rules.json (rules, 263 fields)
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Heath's validator + rules are the source of truth at scripts/. For Vercel
// deployment we keep BYTE-IDENTICAL copies at api/_lib/ so the serverless
// function bundle doesn't accidentally inline the whole 217 MB scripts/
// directory (atlas-runs/, trec-forms/, etc.) via Vercel's file tracer.
// scripts/integrity-check.js verifies the copies match the source of truth;
// CI blocks any PR where they drift.
const LOCAL_VALIDATOR = require('./trec-validator');
const LOCAL_RULES_PATH = path.join(__dirname, 'trec-20-18-field-rules.json');

let _cachedRules = null;
function loadHeathArtifacts() {
  if (!_cachedRules) {
    _cachedRules = JSON.parse(fs.readFileSync(LOCAL_RULES_PATH, 'utf8'));
  }
  return { rules: _cachedRules, validator: LOCAL_VALIDATOR };
}

// ---------------------------------------------------------------------------
// Layer 2: legacy fv-key → canonical fieldId mapping
// ---------------------------------------------------------------------------
// The legacy /api/extract-form-fields endpoint emits friendly snake_case keys
// (sale_price, buyer_name, earnest_money, etc). Heath's rules use a different
// canonical fieldId space (sales_price_total, sales_price_cash_portion, etc).
// This map is the single source of translation between the two.
//
// Strategy:
//   - Direct rename when shapes line up (buyer_name -> buyer_name).
//   - Derived split when one legacy field becomes multiple canonical fields
//     (sale_price + loan_amount + down_payment_amt -> 3A/3B/3C).
//   - Boolean checkbox routing for as-is, financing-type, addenda picks.
//   - Confidence default 0.95 for direct values, 0.90 for derived.
//
// Any legacy field with NO canonical counterpart is dropped on the floor
// here (it will be passed through the legacy fv path separately so the
// existing fill engine still receives it for non-validated rendering).
// ---------------------------------------------------------------------------

const DIRECT_KEY_MAP = {
  // Parties
  buyer_name: 'buyer_name',
  seller_name: 'seller_name',
  // Property
  property_address: 'property_street_address',
  legal_lot: 'legal_lot',
  legal_block: 'legal_block',
  addition_name: 'legal_addition',
  county: 'property_county',
  // Note: property_city_known_as in rules maps to street + city portion.
  // We mirror the legacy fill-form behavior: store property_address into
  // property_city_known_as (it's the "Texas known as ___" widget).
  // Money
  earnest_money: 'earnest_money_amount',
  option_fee: 'option_fee_amount',
  option_days: 'option_period_days',
  // Closing + escrow
  closing_date: 'closing_date',
  title_company: 'escrow_agent_name',
  title_company_address: 'escrow_agent_address',
};

const CONFIDENCE_DIRECT = 0.95;
const CONFIDENCE_DERIVED = 0.90;
const CONFIDENCE_RETRY_FLOOR = 0.85; // validator floor

/**
 * mapToAssignments(fv, intake)
 *   fv     = legacy field_values from /api/extract-form-fields (snake_case)
 *   intake = strict-typed intake { financing_type, has_second_buyer, ... }
 *   returns { assignments, intakeOut }
 *
 * intake is derived from fv when not provided, so a single legacy payload
 * can be funneled through the validator with minimal caller churn.
 */
function mapToAssignments(fv, intakeIn) {
  const assignments = {};
  const matchReason = (k) => `legacy:${k}`;

  // ---- direct renames ----
  for (const [legacyKey, fieldId] of Object.entries(DIRECT_KEY_MAP)) {
    if (fv[legacyKey] !== undefined && fv[legacyKey] !== null && fv[legacyKey] !== '') {
      assignments[fieldId] = {
        value: fv[legacyKey],
        confidence: CONFIDENCE_DIRECT,
        matchReason: matchReason(legacyKey),
      };
    }
  }

  // ---- §2 property_city_known_as = property_address (per fill-form line 661) ----
  if (fv.property_address) {
    assignments.property_city_known_as = {
      value: fv.property_address,
      confidence: CONFIDENCE_DERIVED,
      matchReason: 'derived:property_address',
    };
  }

  // ---- §2.A Legal description splitting ----
  // Legacy extractor often returns a single legal_description string like
  // "Lot 12 Block 3 Cordillera Ranch". Rules require legal_lot + legal_block
  // + legal_addition as separate core fields. Parse the common pattern.
  if (!assignments.legal_lot && !assignments.legal_block && fv.legal_description) {
    const ld = String(fv.legal_description);
    const m = ld.match(/Lot\s+(\S+)\s+Block\s+(\S+)\s+(.+)/i);
    if (m) {
      if (!assignments.legal_lot)
        assignments.legal_lot = { value: m[1], confidence: CONFIDENCE_DERIVED, matchReason: 'derived:legal_description' };
      if (!assignments.legal_block)
        assignments.legal_block = { value: m[2], confidence: CONFIDENCE_DERIVED, matchReason: 'derived:legal_description' };
      if (!assignments.legal_addition)
        assignments.legal_addition = { value: m[3].trim(), confidence: CONFIDENCE_DERIVED, matchReason: 'derived:legal_description' };
    }
  }

  // ---- §3 Sales Price tri-split ----
  // Legacy emits sale_price (total) + loan_amount (financing) + optional
  // down_payment_amt (cash). Rules require 3A (cash) + 3B (financing) + 3C (total)
  // and validator enforces 3C = 3A + 3B (arithmetic crossRef).
  //
  // The 3B (financing portion) rule has conditional financing_type != 'cash',
  // so we MUST NOT emit a value for it on cash deals (validator will FAIL).
  const financingType = (intakeIn && intakeIn.financing_type) || fv.financing_type || null;
  const isCash = String(financingType || '').toLowerCase() === 'cash';

  const salePrice = numeric(fv.sale_price);
  const loanAmount = numeric(fv.loan_amount);
  let cashPortion = numeric(fv.down_payment_amt);
  if (cashPortion == null && salePrice != null && loanAmount != null) {
    cashPortion = +(salePrice - loanAmount).toFixed(2);
  }
  if (cashPortion == null && salePrice != null && (loanAmount == null || loanAmount === 0)) {
    // Cash deal (or no loan): cash portion equals total
    cashPortion = salePrice;
  }
  let financingPortion = loanAmount;
  if (!isCash && financingPortion == null && salePrice != null && cashPortion != null) {
    financingPortion = +(salePrice - cashPortion).toFixed(2);
  }
  // Cash deal: never emit a financing portion (conditional rules out the field)
  if (isCash) financingPortion = null;

  // Ensure validator arithmetic passes: 3A + 3B = 3C exactly (when both A+B set)
  if (salePrice != null && cashPortion != null && financingPortion != null) {
    const sum = +(Number(cashPortion) + Number(financingPortion)).toFixed(2);
    if (Math.abs(sum - salePrice) > 0.01) {
      // Recompute cashPortion as residual; loan_amount wins as ground truth.
      cashPortion = +(salePrice - financingPortion).toFixed(2);
    }
  }
  if (cashPortion != null) {
    assignments.sales_price_cash_portion = {
      value: cashPortion,
      confidence: CONFIDENCE_DERIVED,
      matchReason: 'derived:sale_price-loan_amount',
    };
  }
  if (financingPortion != null) {
    assignments.sales_price_financing_portion = {
      value: financingPortion,
      confidence: CONFIDENCE_DERIVED,
      matchReason: 'derived:loan_amount',
    };
  }
  if (salePrice != null) {
    assignments.sales_price_total = {
      value: salePrice,
      confidence: CONFIDENCE_DIRECT,
      matchReason: 'legacy:sale_price',
    };
  }

  // ---- §7.D As-Is ----
  if (fv.as_is === true) {
    assignments.accept_as_is = {
      value: true,
      confidence: CONFIDENCE_DIRECT,
      matchReason: 'legacy:as_is',
    };
  }
  if (fv.as_is_with_repairs === true) {
    assignments.accept_as_is_with_repairs = {
      value: true,
      confidence: CONFIDENCE_DIRECT,
      matchReason: 'legacy:as_is_with_repairs',
    };
  }

  // ---- §5 Option fee credited box (default true per fill-form line 716) ----
  if (fv.sale_price_credited === true || fv.option_fee_credited === true) {
    assignments.option_fee_credited_box = {
      value: true,
      confidence: CONFIDENCE_DIRECT,
      matchReason: 'legacy:option_fee_credited',
    };
  }

  // ---- §8 Broker representation ----
  if (fv.listing_only_seller_agent === true) {
    assignments.rep_seller_only = {
      value: true,
      confidence: CONFIDENCE_DIRECT,
      matchReason: 'legacy:listing_only_seller_agent',
    };
  }
  if (fv.listing_broker_firm) {
    assignments.listing_broker_firm = {
      value: fv.listing_broker_firm,
      confidence: CONFIDENCE_DIRECT,
      matchReason: 'legacy:listing_broker_firm',
    };
  }

  // ---- §22 Addenda checkbox routing ----
  // financing_addendum_present is a generic "some financing addendum exists" flag.
  // add_third_party_financing is the SPECIFIC §22 box for the TREC third-party
  // financing addendum, which by rule applies ONLY to conventional / FHA / VA.
  // Seller-financed and assumption deals get a different addendum (NOT this one).
  if (fv.addendum_financing === true) {
    assignments.financing_addendum_present = {
      value: true,
      confidence: CONFIDENCE_DIRECT,
      matchReason: 'legacy:addendum_financing',
    };
    const thirdPartyFinancingTypes = new Set(['conventional', 'fha', 'va']);
    if (thirdPartyFinancingTypes.has(String(financingType || '').toLowerCase())) {
      assignments.add_third_party_financing = {
        value: true,
        confidence: CONFIDENCE_DIRECT,
        matchReason: 'legacy:addendum_financing+financing_type',
      };
    }
  }

  // ---- Notice block (best-effort; legacy doesn't extract these directly) ----
  // The legacy extractor doesn't pull notice_* fields. Atlas leaves them
  // UNMATCHED unless caller pre-populated. Per Heath: surface UNMATCHED,
  // never fabricate.

  // ---- intake derivation (validator uses these for conditional eval) ----
  const intakeOut = intakeIn ? { ...intakeIn } : {};
  if (intakeOut.financing_type == null && fv.financing_type) {
    intakeOut.financing_type = String(fv.financing_type).toLowerCase();
  }
  if (intakeOut.has_second_buyer == null) {
    intakeOut.has_second_buyer = /\sand\s|,/.test(String(fv.buyer_name || ''));
  }
  if (intakeOut.has_second_seller == null) {
    intakeOut.has_second_seller = /\sand\s|,/.test(String(fv.seller_name || ''));
  }
  if (intakeOut.hoa_is_subject == null) {
    intakeOut.hoa_is_subject = fv.hoa_exists === true;
  }
  if (intakeOut.add_other_text == null) {
    intakeOut.add_other_text = fv.special_provisions || null;
  }

  return { assignments, intake: intakeOut };
}

function numeric(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Layer 3: validate + self-correction loop
// ---------------------------------------------------------------------------

const MAX_RETRIES_PER_FIELD = 2;

/**
 * validateWithRetry(opts)
 *   opts.assignments  - Layer 2 output
 *   opts.intake       - strict intake
 *   opts.rules        - Heath's rules (loaded once at module init or passed)
 *   opts.validator    - { validate, CONFIDENCE_FLOOR }
 *   opts.extractor    - async ({fieldIds, rules, context, attempt}) => assignmentsPatch
 *                       Re-runs Opus extraction for ONLY failing fieldIds.
 *                       Returns partial assignments dict to merge.
 *
 * Returns { report, pass, fillable, flags, retries, unmatched }
 *   retries  = { fieldId: attemptsUsed }
 *   unmatched = fieldIds that remained UNMATCHED after max retries
 */
async function validateWithRetry({ assignments, intake, rules, validator, extractor, log, sourceMessage, transactionContext }) {
  const retries = {};
  let cur = { ...assignments };
  let final = validator.validate(rules, cur, intake);
  let attempt = 0;

  while (final.flags && final.flags.length > 0 && attempt < MAX_RETRIES_PER_FIELD) {
    attempt += 1;
    const failingIds = final.flags.slice();

    // Build per-field context from rules.
    const byId = {};
    rules.fields.forEach((f) => (byId[f.fieldId] = f));
    const contextForRetry = failingIds.map((fid) => {
      const rule = byId[fid] || {};
      const fr = final.report.find((r) => r.fieldId === fid) || {};
      return {
        fieldId: fid,
        purpose: rule.purpose,
        paragraph: rule.paragraph,
        valueType: rule.valueType,
        format: rule.format,
        priorValue: (cur[fid] && cur[fid].value) ?? null,
        priorConfidence: (cur[fid] && cur[fid].confidence) ?? null,
        failureReason: fr.reason,
        failureStatus: fr.status,
      };
    });

    if (log) log({ stage: 'retry', attempt, failingIds });

    let patch = {};
    if (typeof extractor === 'function') {
      try {
        patch = (await extractor({
          fieldIds: failingIds,
          rules,
          context: contextForRetry,
          attempt,
          intake,
          sourceMessage,
          transactionContext,
        })) || {};
      } catch (err) {
        if (log) log({ stage: 'retry-error', attempt, error: err.message });
        patch = {};
      }
    }

    // Merge patch. Reject any patch entry whose confidence is below the
    // validator floor — that's the "never fabricate to pass" rule.
    for (const [fid, a] of Object.entries(patch)) {
      if (!a || a.value == null || a.value === '') continue;
      if (a.confidence != null && a.confidence < CONFIDENCE_RETRY_FLOOR) continue;
      cur[fid] = a;
      retries[fid] = (retries[fid] || 0) + 1;
    }

    final = validator.validate(rules, cur, intake);
  }

  // Any field still in flags after retries -> unmatched (human review).
  const unmatched = final.report
    .filter((r) => r.status === 'UNMATCHED' || r.status === 'FAIL')
    .map((r) => r.fieldId);

  return { ...final, assignments: cur, retries, unmatched };
}

// ---------------------------------------------------------------------------
// fillable -> legacy fv conversion
// ---------------------------------------------------------------------------
// After validator passes, we need to feed the existing fillResaleContract()
// renderer in api/fill-form.js. That function reads `fv.*` keys, so we
// invert mapToAssignments() for the subset that's relevant to PDF rendering.
// ---------------------------------------------------------------------------
function fillableToLegacy(fillable, originalFv) {
  const out = { ...(originalFv || {}) };
  const set = (k, v) => {
    if (v != null && v !== '') out[k] = v;
  };

  if (fillable.buyer_name) set('buyer_name', fillable.buyer_name);
  if (fillable.seller_name) set('seller_name', fillable.seller_name);
  if (fillable.property_street_address) set('property_address', fillable.property_street_address);
  if (fillable.legal_lot) set('legal_lot', fillable.legal_lot);
  if (fillable.legal_block) set('legal_block', fillable.legal_block);
  if (fillable.legal_addition) set('addition_name', fillable.legal_addition);
  if (fillable.property_county) set('county', fillable.property_county);
  if (fillable.earnest_money_amount) set('earnest_money', fillable.earnest_money_amount);
  if (fillable.option_fee_amount) set('option_fee', fillable.option_fee_amount);
  if (fillable.option_period_days) set('option_days', fillable.option_period_days);
  if (fillable.closing_date) set('closing_date', fillable.closing_date);
  if (fillable.escrow_agent_name) set('title_company', fillable.escrow_agent_name);
  if (fillable.escrow_agent_address) set('title_company_address', fillable.escrow_agent_address);
  if (fillable.sales_price_total) set('sale_price', fillable.sales_price_total);
  if (fillable.sales_price_financing_portion) set('loan_amount', fillable.sales_price_financing_portion);
  if (fillable.sales_price_cash_portion) set('down_payment_amt', fillable.sales_price_cash_portion);

  return out;
}

// ---------------------------------------------------------------------------
// Default LLM extractor — Opus 4.7 with rule.purpose as context.
// Returns a partial assignments dict { fieldId: {value, confidence, matchReason} }.
// Called once per retry round; we ask for ALL failing fieldIds in a single call.
// ---------------------------------------------------------------------------
async function defaultLlmExtractor({ fieldIds, context, intake, attempt, sourceMessage, transactionContext }) {
  let Anthropic;
  try {
    // eslint-disable-next-line global-require
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    return {};
  }
  if (!process.env.ANTHROPIC_API_KEY) return {};

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const fieldList = context
    .map(
      (c) =>
        `- ${c.fieldId} (${c.valueType}${c.format ? ', format=' + c.format : ''}): ${c.purpose}\n  paragraph: ${c.paragraph}\n  prior value: ${JSON.stringify(c.priorValue)} (failure: ${c.failureStatus} — ${c.failureReason})`
    )
    .join('\n');

  const systemPrompt = `You are repairing a TREC 20-18 contract field assignment that failed Layer-3 validation.
You will be given a list of field ids, each with their legal purpose, expected valueType/format, and the prior failure reason.

Return a strict JSON object: { fieldId: { value, confidence } }
- value:      the correct typed value (number for currency, ISO string for dates, boolean for checkboxes, string otherwise)
- confidence: 0.0 to 1.0 self-rated, based on how certain you are the value is correct AND matches the format

HARD RULES:
- Never fabricate. If you cannot determine a value with confidence >= 0.85, OMIT that field id from your response entirely.
- For currency, return a number (no $ or commas).
- For percent (option_period_days regex ^\\d{1,3}$), return digits only.
- Respect the field's legal purpose — for example, if the purpose is "Buyer email address" return a real email string.
- Return ONLY JSON. No markdown, no commentary.

Attempt ${attempt} of ${MAX_RETRIES_PER_FIELD}. Be conservative — better to leave unmatched than guess wrong.`;

  const userPrompt = `Source agent message (the original natural-language request — extract values from THIS):
"""
${sourceMessage || '(no source message available)'}
"""

Transaction context (existing dossier facts):
${JSON.stringify(transactionContext || {}, null, 2)}

Strict intake (already resolved):
${JSON.stringify(intake, null, 2)}

Failing fields to repair (extract a correct value for each from the source message above):
${fieldList}

Return JSON only.`;

  let resp;
  try {
    resp = await client.messages.create({
      model: 'claude-opus-4-5-20250929', // Opus 4.7 (1M ctx) is "opus-4-7"; fallback to 4.5 if 4.7 not available
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    try {
      resp = await client.messages.create({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
    } catch (err2) {
      return {};
    }
  }

  const text = (resp.content[0] && resp.content[0].type === 'text' && resp.content[0].text) || '';
  let parsed;
  try {
    const cleaned = text.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return {};
  }

  const out = {};
  for (const fid of fieldIds) {
    const a = parsed[fid];
    if (!a || a.value == null || a.value === '') continue;
    const conf = typeof a.confidence === 'number' ? a.confidence : 0.7;
    out[fid] = {
      value: a.value,
      confidence: conf,
      matchReason: `llm-retry-attempt-${attempt}`,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public end-to-end runner
// ---------------------------------------------------------------------------

/**
 * runPipeline({ fieldValues, intake, log, extractor })
 *   Convenience: maps -> validates with retry -> emits everything.
 *   - fieldValues : legacy fv-shape from /api/extract-form-fields
 *   - intake      : optional strict intake (derived from fv if absent)
 *   - extractor   : optional async LLM extractor; defaults to Opus 4.7
 *
 * Returns:
 *   {
 *     pass, fillable, report, flags, retries, unmatched,
 *     assignments,           // final canonical assignments after retry
 *     legacyFv,              // fv-shape ready for fillResaleContract()
 *     intake                 // resolved intake (with defaults applied)
 *   }
 */
async function runPipeline({ fieldValues, intake, log, extractor, sourceMessage, transactionContext }) {
  const { rules, validator } = loadHeathArtifacts();
  const { assignments, intake: resolvedIntake } = mapToAssignments(fieldValues, intake);

  const useExtractor =
    typeof extractor === 'function' ? extractor : defaultLlmExtractor;

  const result = await validateWithRetry({
    assignments,
    intake: resolvedIntake,
    rules,
    validator,
    extractor: useExtractor,
    log,
    sourceMessage,
    transactionContext,
  });

  const legacyFv = fillableToLegacy(result.fillable, fieldValues);

  return {
    pass: result.pass,
    fillable: result.fillable,
    report: result.report,
    flags: result.flags,
    retries: result.retries,
    unmatched: result.unmatched,
    assignments: result.assignments,
    legacyFv,
    intake: resolvedIntake,
  };
}

module.exports = {
  loadHeathArtifacts,
  mapToAssignments,
  validateWithRetry,
  fillableToLegacy,
  defaultLlmExtractor,
  runPipeline,
  DIRECT_KEY_MAP,
  MAX_RETRIES_PER_FIELD,
};
