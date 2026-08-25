// api/_lib/net-sheet-calc.js
// Pure Seller's Net Sheet arithmetic, extracted out of api/net-sheet.js so it
// can be called two ways without duplicating the formula:
//   1. api/net-sheet.js — the customer-facing HTTP endpoint (auth + defaults
//      lookup live there; this module only does the math).
//   2. api/cron-financial-sanity.js — the reconciliation check, which
//      independently re-sums the returned `breakdown` line items against the
//      reported `netProceeds`/`totalDeductions` to catch the exact bug class
//      this whole check exists for: a line item added to the display array
//      without the total being updated, or vice versa.
//
// Owner: Carter, 2026-08-25 (Alpha TC Roadmap #1 — financial sanity check)

function toNum(v, fallback) {
  if (v == null || v === '') return fallback != null ? fallback : 0;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : (fallback != null ? fallback : 0);
}

function fmtMoney(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

// Inputs are already-resolved numbers (caller merges body-over-contract
// defaults before calling this). Returns the same shape net-sheet.js has
// always returned to the client, unchanged.
function calculateNetSheet({
  salePrice,
  commissionPct,
  mortgagePayoff = 0,
  escrowFee = 0,
  titlePolicyCost = 0,
  hoaTransferFee = 0,
  homeWarrantyCap = 0,
  surveyCost = 0,
  repairs = 0,
  otherCredits = 0,
  optionFeeCredit = 0,
}) {
  const commissionAmount = (salePrice * commissionPct) / 100;
  const totalDeductions =
    commissionAmount + mortgagePayoff + escrowFee + titlePolicyCost + hoaTransferFee +
    homeWarrantyCap + surveyCost + repairs + otherCredits - optionFeeCredit;
  const netProceeds = salePrice - totalDeductions;

  const breakdown = [
    { label: 'Sale Price', amount: salePrice, type: 'income' },
    { label: 'Commission (' + commissionPct.toFixed(2) + '%)', amount: -commissionAmount, type: 'deduction' },
    { label: 'Mortgage Payoff', amount: -mortgagePayoff, type: 'deduction' },
    { label: 'Escrow / Closing Fee', amount: -escrowFee, type: 'deduction' },
    { label: 'Title Policy', amount: -titlePolicyCost, type: 'deduction' },
    { label: 'HOA Transfer Fee', amount: -hoaTransferFee, type: 'deduction' },
    { label: 'Home Warranty Reimbursement', amount: -homeWarrantyCap, type: 'deduction' },
    { label: 'Survey', amount: -surveyCost, type: 'deduction' },
    { label: 'Agreed Repairs', amount: -repairs, type: 'deduction' },
    { label: 'Other Credits to Buyer', amount: -otherCredits, type: 'deduction' },
    { label: 'Option Fee Credit', amount: optionFeeCredit, type: 'credit' },
  ].filter((item) => item.amount !== 0);

  return { breakdown, commissionAmount, totalDeductions, netProceeds };
}

// Independent reconciliation: sums the `breakdown` line items (which already
// encode sign via `amount`) and checks that the sum equals sale_price minus
// the reported net_proceeds' complement — i.e. that the list of items the
// customer actually SEES accounts for the whole gap between sale price and
// net proceeds. This is the check specified as "cross-check that generated
// net sheets reconcile... rather than trusting the generator's own output
// blindly" — it does not re-derive the formula, it verifies the two things
// calculateNetSheet() returns (the itemized list and the claimed total) still
// agree with each other.
function reconcileBreakdown({ salePrice, breakdown, netProceeds }) {
  const summedNet = (Array.isArray(breakdown) ? breakdown : [])
    .reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0);
  // Sum should equal netProceeds directly: sale price is itself one of the
  // (positive) line items, every deduction is already negative, every credit
  // already positive.
  const diff = Math.round((summedNet - netProceeds) * 100) / 100;
  return { ok: Math.abs(diff) < 0.01, summedNet, diff };
}

module.exports = { toNum, fmtMoney, calculateNetSheet, reconcileBreakdown };
