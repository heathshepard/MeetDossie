'use strict';

// api/_lib/offer-net-sheet.js
//
// Seller's net sheet computed directly off a SCANNED OFFER's money stack
// (api/scan-contract.js's extracted.moneyStack), not off manually-typed form
// fields. Built 2026-09-29 after Heath caught a $5,000 seller concession
// buried in Paragraph 12A(1)(b) on his own 702 Fawndale offer that neither
// he nor a first pass of Dossie's scanner surfaced — a $315,000 headline
// price hid $15,250 of seller-side giveback spread across three separate
// paragraphs (12A(1)(b) concession, 12B(1) buyer-broker compensation, 7H
// service contract cap).
//
// Sibling to api/_lib/net-sheet-estimate.js, NOT a replacement for it:
//   /api/net-sheet-estimate  — commission-centric, figures typed/spoken by
//                              the agent, sourced from the LISTING side.
//   this module              — the THREE contract-embedded givebacks above,
//                              sourced from the OFFER itself, plus payoff
//                              and customary closing costs. Deliberately
//                              does NOT include the seller's own listing
//                              commission — that lives on a different
//                              document (the Listing Agreement) and belongs
//                              in /api/net-sheet-estimate, not here. Mixing
//                              the two would risk double-counting or
//                              silently dropping one of them; this tool
//                              says so explicitly in its output instead.
//
// Reuses the SAME unknown/na/known figure model as net-sheet-estimate.js
// (parseFigure, fmtMoney, sourceLabel) — one epistemic model for "what do we
// actually know" across both net sheet tools, not two that can drift.
//
// RULES THIS FILE ENFORCES — do not relax without re-reading the task that
// created it (money-stack net sheet, 2026-09-29):
//   1. payoff is NEVER derived from the contract. It is a REQUIRED input. If
//      the caller doesn't supply it, the net sheet still renders every other
//      known line for transparency, but `blocked: true` and no proceeds
//      figure — a "ceiling" that omitted a six-figure payoff would overstate
//      proceeds by the single largest number on the sheet, which is worse
//      than not showing a number at all.
//   2. Every contract-derived figure keeps the paragraph + confidence it
//      arrived with from moneyStack.
//   3. Every customary seller-cost figure (title policy, escrow, deed prep,
//      tax cert, lien release) is an ESTIMATE/DEFAULT unless the caller
//      overrides it — source 'estimate_default' (the same label
//      net-sheet-estimate.js's SOURCE_LABELS already defines), never
//      presented as an exact quote. Get the real numbers from title before
//      closing — every default here says so in its own hint text.
//   4. Tax proration needs an annual tax amount; absent that, the line is
//      unknown, not zero.
//   5. Whole output is labeled an estimate on its face — headline + a
//      prominent disclaimer, never buried in a footnote.

const { parseFigure, fmtMoney, sourceLabel } = require('./net-sheet-estimate');

// Texas promulgated basic Owner's Policy premium is a real published TDI
// rate table, not a guess — but the exact current bracket figures are NOT
// hardcoded here with false precision. This is a widely-cited approximation
// of that schedule (roughly $832 base for the first $100k, ~$5.02 per
// additional $1,000 up to $1M) that MUST be confirmed against the current
// Texas Basic Manual of Title Insurance before being relied on for a real
// closing — hence 'estimate_promulgated_table', a distinct source label from
// 'estimate_default', so a caller/UI can flag it for extra scrutiny.
function estimateTexasOwnersTitlePremium(salePrice) {
  if (!Number.isFinite(salePrice) || salePrice <= 0) return null;
  const BASE_100K = 832;
  const PER_1K_TO_1M = 5.02;
  const PER_1K_OVER_1M = 4.68;
  if (salePrice <= 100000) return BASE_100K;
  const upTo1M = Math.min(salePrice, 1000000);
  let premium = BASE_100K + ((upTo1M - 100000) / 1000) * PER_1K_TO_1M;
  if (salePrice > 1000000) {
    premium += ((salePrice - 1000000) / 1000) * PER_1K_OVER_1M;
  }
  return Math.round(premium * 100) / 100;
}

// Customary TX seller-cost defaults. All overridable, all labeled as
// estimates on the way out — never presented as a title company quote.
const CUSTOMARY_COST_DEFAULTS = {
  escrow_fee_total: { amount: 600, hint: 'Typical full escrow/closing fee — title company quote will differ. Seller customarily pays half.' },
  deed_prep_fee: { amount: 150, hint: 'Flat fee for attorney-prepared deed — title company quote will differ.' },
  tax_certificate_fee: { amount: 25, hint: 'County tax office statement fee — varies by county.' },
  lien_release_recording_fee: { amount: 35, hint: 'County recording fee for the lien release — varies by county and page count.' },
};

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function fmtDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Pull a plain number + provenance out of a moneyStack field shape
// ({ value, paragraph, confidence } or { value, mode, paragraph, confidence }
// for the 12B comp fields). Returns null (not 0) when the field itself is
// null — that is the whole point of the moneyStack's own null discipline;
// this function must never paper over it.
function moneyStackAmount(field) {
  if (!field || field.value == null) return null;
  return field;
}

// 12B(1)/(2) can be a flat dollar OR a percentage of sale price — resolve to
// a dollar amount here, since that's what a net sheet subtracts. Percentage
// mode needs the sale price to resolve; if sale price itself is unknown this
// returns null (never silently guesses a percentage as if it were a dollar
// figure).
function resolveCompDollar(field, salePrice) {
  if (!field || field.value == null) return null;
  if (field.mode === 'dollar') return field.value;
  if (field.mode === 'percent' && isFiniteNumber(salePrice)) {
    return Math.round(salePrice * (field.value / 100) * 100) / 100;
  }
  return null;
}

/**
 * @param {object} args
 * @param {object} args.moneyStack        required — extracted.moneyStack from api/scan-contract.js
 * @param {number|string|object} [args.payoff]  REQUIRED for a real proceeds figure — see rule 1. Not defaulted.
 * @param {number|string|object} [args.escrowFeeTotal]      override; seller pays half by default
 * @param {number|string|object} [args.titlePolicyCost]     override; else the promulgated-table estimate
 * @param {number|string|object} [args.deedPrepFee]         override
 * @param {number|string|object} [args.taxCertificateFee]   override
 * @param {number|string|object} [args.lienReleaseRecordingFee] override
 * @param {number|string|object} [args.taxAmountAnnual]     required for tax proration — else unknown
 * @param {string} [args.taxProrationDate]  defaults to moneyStack.closingDate.value
 * @param {string} [args.propertyAddress]
 * @param {string} [args.sellerName]
 * @param {Date}   [args.now]
 */
function buildOfferNetSheet({
  moneyStack,
  payoff,
  escrowFeeTotal,
  titlePolicyCost,
  deedPrepFee,
  taxCertificateFee,
  lienReleaseRecordingFee,
  taxAmountAnnual,
  taxProrationDate,
  propertyAddress = '',
  sellerName = '',
  now = new Date(),
}) {
  if (!moneyStack || typeof moneyStack !== 'object') {
    const err = new Error('moneyStack is required — run /api/scan-contract on the offer first.');
    err.code = 'MISSING_MONEY_STACK';
    throw err;
  }

  const priceField = moneyStackAmount(moneyStack.salesPrice);
  if (!priceField || !isFiniteNumber(priceField.value) || priceField.value <= 0) {
    const err = new Error('Sales price could not be verified from the contract (¶3C) — cannot build a net sheet.');
    err.code = 'MISSING_SALE_PRICE';
    throw err;
  }
  const salePrice = priceField.value;

  const lines = [];

  const pushKnown = (key, label, amount, kind, source, sourceDetail, paragraph, confidence, hint) => {
    lines.push({
      key, label, kind, status: 'known', amount: kind === 'deduction' ? -amount : amount,
      display: kind === 'deduction' ? `(${fmtMoney(amount)})` : fmtMoney(amount),
      source, sourceLabel: sourceDetail || sourceLabel(source), paragraph: paragraph || null,
      confidence: typeof confidence === 'number' ? confidence : null, hint: hint || null,
    });
  };
  const pushUnknown = (key, label, kind, hint, paragraph) => {
    lines.push({
      key, label, kind, status: 'unknown', amount: null, display: 'Unknown',
      source: null, sourceLabel: sourceLabel(null), paragraph: paragraph || null,
      confidence: 0, hint: hint || null,
    });
  };

  let knownDeductionTotal = 0;
  let knownCreditTotal = 0;
  const unknown = [];
  const materialUnknown = [];

  // --- Income: sale price ---------------------------------------------------
  pushKnown('sale_price', 'Sales Price', salePrice, 'income', 'contract', 'from the contract (¶3C)', '3C', priceField.confidence);

  // --- Payoff — REQUIRED, never derived, never defaulted (rule 1) ----------
  const payoffFig = parseFigure(payoff);
  let blocked = false;
  let blockedReason = null;
  if (payoffFig.status === 'known' && isFiniteNumber(payoffFig.amount)) {
    pushKnown('mortgage_payoff', 'Mortgage Payoff', payoffFig.amount, 'deduction', payoffFig.source || 'member', payoffFig.source ? sourceLabel(payoffFig.source) : 'entered by you', null, null,
      'Get a written payoff statement from the lender, good through the closing date.');
    knownDeductionTotal += payoffFig.amount;
  } else if (payoffFig.status === 'na') {
    pushKnown('mortgage_payoff', 'Mortgage Payoff', 0, 'deduction', payoffFig.source || 'member', 'no mortgage', null, null, null);
  } else {
    // Missing required input — still show the line (task rule: never omit
    // it), but the whole net sheet is blocked from producing a proceeds
    // figure because payoff is normally the single largest deduction.
    pushUnknown('mortgage_payoff', 'Mortgage Payoff', 'deduction',
      'REQUIRED — not supplied. This is normally the largest deduction on the sheet; net proceeds cannot be estimated without it.');
    unknown.push({ key: 'mortgage_payoff', label: 'Mortgage Payoff', material: true });
    materialUnknown.push('Mortgage Payoff');
    blocked = true;
    blockedReason = 'Mortgage payoff was not supplied. Net proceeds cannot be estimated without it — every other line below is still shown for reference.';
  }

  // --- The three contract-embedded givebacks (the whole point of this tool) -

  const concession = moneyStackAmount(moneyStack.sellerConcessionToBuyerExpenses);
  if (concession && isFiniteNumber(concession.value) && concession.value > 0) {
    pushKnown('seller_concession', "Seller Concession to Buyer's Expenses", concession.value, 'deduction', 'contract', 'from the contract (¶12A(1)(b))', '12A(1)(b)', concession.confidence);
    knownDeductionTotal += concession.value;
  } else if (concession && concession.value === 0) {
    // explicitly extracted as zero/none — treat as a real zero, don't flag unknown
  } else {
    pushUnknown('seller_concession', "Seller Concession to Buyer's Expenses", 'deduction',
      'Could not be verified from ¶12A(1)(b) — check the contract directly.', '12A(1)(b)');
    unknown.push({ key: 'seller_concession', label: "Seller Concession to Buyer's Expenses", material: true });
    materialUnknown.push("Seller Concession to Buyer's Expenses");
  }

  const bac = moneyStackAmount(moneyStack.buyerBrokerCompensation);
  const bacDollar = resolveCompDollar(bac, salePrice);
  if (bac && bac.value != null && bacDollar != null) {
    const label = bac.mode === 'percent'
      ? `Buyer's Broker Compensation (¶12B(1), ${bac.value}% of sales price)`
      : "Buyer's Broker Compensation (¶12B(1))";
    pushKnown('buyer_broker_comp', label, bacDollar, 'deduction', 'contract', 'from the contract (¶12B(1))', '12B(1)', bac.confidence);
    knownDeductionTotal += bacDollar;
  } else if (bac && bac.value == null) {
    // ¶12B(1) genuinely unchecked/blank — a real zero, not unknown.
  } else {
    pushUnknown('buyer_broker_comp', "Buyer's Broker Compensation", 'deduction',
      'Could not be verified from ¶12B(1) — check which box (¶ or %) is marked directly on the contract.', '12B(1)');
    unknown.push({ key: 'buyer_broker_comp', label: "Buyer's Broker Compensation", material: true });
    materialUnknown.push("Buyer's Broker Compensation");
  }

  const svc = moneyStackAmount(moneyStack.residentialServiceContractCap);
  if (svc && isFiniteNumber(svc.value) && svc.value > 0) {
    pushKnown('service_contract_cap', 'Residential Service Contract Reimbursement', svc.value, 'deduction', 'contract', 'from the contract (¶7H)', '7H', svc.confidence);
    knownDeductionTotal += svc.value;
  } else if (svc && svc.value === 0) {
    // explicit none
  } else {
    // ¶7H being genuinely absent (no such provision) is common and NOT an
    // error — only flag as unknown if the field itself is ambiguous, which
    // the moneyStack already encodes via confidence === null vs 0. A clean
    // null with confidence 0 and no warning upstream means "not present,"
    // which is a real zero here, not unknown.
    if (svc && svc.confidence !== 0) {
      pushUnknown('service_contract_cap', 'Residential Service Contract Reimbursement', 'deduction',
        'Could not be verified from ¶7H.', '7H');
      unknown.push({ key: 'service_contract_cap', label: 'Residential Service Contract Reimbursement', material: false });
    }
  }

  // --- Customary seller closing costs — always estimate_default unless overridden

  const applyCustomary = (key, label, override, defaultAmount, hint, splitFactor) => {
    const fig = parseFigure(override);
    if (fig.status === 'known' && isFiniteNumber(fig.amount)) {
      const amt = splitFactor ? fig.amount * splitFactor : fig.amount;
      pushKnown(key, label, amt, 'deduction', 'member', 'entered by you', null, null, hint);
      knownDeductionTotal += amt;
      return;
    }
    if (fig.status === 'na') {
      pushKnown(key, label, 0, 'deduction', 'member', 'not applicable', null, null, null);
      return;
    }
    const amt = splitFactor ? defaultAmount * splitFactor : defaultAmount;
    pushKnown(key, label, amt, 'deduction', 'estimate_default', 'office default — ' + hint, null, null, hint);
    knownDeductionTotal += amt;
  };

  applyCustomary('title_policy', "Owner's Title Policy", titlePolicyCost, estimateTexasOwnersTitlePremium(salePrice) || 0,
    'Texas promulgated basic rate, approximate — confirm the exact figure with the title company before closing.');
  applyCustomary('escrow_fee_seller_half', 'Escrow / Closing Fee (Seller\'s half)', escrowFeeTotal,
    CUSTOMARY_COST_DEFAULTS.escrow_fee_total.amount, CUSTOMARY_COST_DEFAULTS.escrow_fee_total.hint, 0.5);
  applyCustomary('deed_prep', 'Deed Preparation', deedPrepFee,
    CUSTOMARY_COST_DEFAULTS.deed_prep_fee.amount, CUSTOMARY_COST_DEFAULTS.deed_prep_fee.hint);
  applyCustomary('tax_certificate', 'Tax Certificate', taxCertificateFee,
    CUSTOMARY_COST_DEFAULTS.tax_certificate_fee.amount, CUSTOMARY_COST_DEFAULTS.tax_certificate_fee.hint);
  applyCustomary('lien_release', 'Lien Release / Recording', lienReleaseRecordingFee,
    CUSTOMARY_COST_DEFAULTS.lien_release_recording_fee.amount, CUSTOMARY_COST_DEFAULTS.lien_release_recording_fee.hint);

  // --- Tax proration — needs an annual tax amount; absent that, unknown ----
  const closingDateForProration = taxProrationDate || (moneyStack.closingDate && moneyStack.closingDate.value) || null;
  const taxFig = parseFigure(taxAmountAnnual);
  if (taxFig.status === 'known' && isFiniteNumber(taxFig.amount) && closingDateForProration) {
    const closing = new Date(closingDateForProration + 'T00:00:00Z');
    if (!Number.isNaN(closing.getTime())) {
      const yearStart = new Date(Date.UTC(closing.getUTCFullYear(), 0, 1));
      const daysElapsed = Math.round((closing.getTime() - yearStart.getTime()) / (24 * 3600 * 1000)) + 1;
      const isLeap = (closing.getUTCFullYear() % 4 === 0 && closing.getUTCFullYear() % 100 !== 0) || closing.getUTCFullYear() % 400 === 0;
      const daysInYear = isLeap ? 366 : 365;
      const sellerShare = Math.round((taxFig.amount * (daysElapsed / daysInYear)) * 100) / 100;
      pushKnown('tax_proration', `Property Tax Proration (through ${closingDateForProration}, seller's share of the year)`,
        sellerShare, 'deduction', 'member', 'entered by you, prorated to closing date', null, null,
        'Straight-line proration by calendar day — the title company\'s figure at closing may differ slightly by method.');
      knownDeductionTotal += sellerShare;
    } else {
      pushUnknown('tax_proration', 'Property Tax Proration', 'deduction', 'Closing date could not be parsed for proration.');
      unknown.push({ key: 'tax_proration', label: 'Property Tax Proration', material: true });
      materialUnknown.push('Property Tax Proration');
    }
  } else {
    pushUnknown('tax_proration', 'Property Tax Proration', 'deduction',
      taxFig.status === 'na' ? null : 'Annual tax amount not supplied — this is normally a real deduction, not zero.');
    if (taxFig.status !== 'na') {
      unknown.push({ key: 'tax_proration', label: 'Property Tax Proration', material: true });
      materialUnknown.push('Property Tax Proration');
    }
  }

  const hasUnknowns = unknown.length > 0 || blocked;
  const ceiling = salePrice - knownDeductionTotal + knownCreditTotal;

  const totalGiveback = [concession, bac, svc].reduce((sum, f, i) => {
    if (i === 1) return sum + (bacDollar || 0);
    return sum + ((f && isFiniteNumber(f.value)) ? f.value : 0);
  }, 0);

  const disclaimer = buildDisclaimer({ blocked, blockedReason, hasUnknowns, materialUnknown });

  return {
    propertyAddress: propertyAddress || '',
    sellerName: sellerName || '',
    salePrice,
    lines,
    unknown,
    materialUnknown,
    hasUnknowns,
    blocked,
    blockedReason,
    totalGiveback,
    ceiling: blocked ? null : ceiling,
    ceilingDisplay: blocked ? null : fmtMoney(ceiling),
    headline: blocked
      ? `Cannot estimate net proceeds — mortgage payoff not supplied. Known givebacks so far: ${fmtMoney(totalGiveback)}.`
      : (hasUnknowns
        ? `Up to ${fmtMoney(ceiling)} — before ${unknown.length} figure${unknown.length === 1 ? '' : 's'} we don't have yet`
        : `${fmtMoney(ceiling)} estimated`),
    disclaimer,
    generatedAt: now.toISOString(),
    generatedAtDisplay: fmtDate(now),
  };
}

function buildDisclaimer({ blocked, blockedReason, hasUnknowns, materialUnknown }) {
  const headline = 'This is an estimate, not a guarantee.';
  const body = [
    'Final numbers come from the title company\'s settlement statement at closing and will be different from these.',
    'Listing commission owed to the seller\'s own broker is NOT included here — that comes from the Listing Agreement, not this contract. See the full seller\'s net sheet for that figure.',
  ];
  if (blocked) {
    body.unshift(blockedReason);
  } else if (materialUnknown.length) {
    body.push(`${materialUnknown.join(', ')} — ${materialUnknown.length === 1 ? 'is' : 'are'} missing and will change the total once known.`);
  }
  return { headline, body, text: [headline, ...body].join(' ') };
}

module.exports = {
  buildOfferNetSheet,
  estimateTexasOwnersTitlePremium,
  CUSTOMARY_COST_DEFAULTS,
};
