// api/_lib/commission-math.js
// Parses transactions.commission_rate — a free-text field populated by
// scan-contract.js's AI extraction from whatever commission language the
// Listing Agreement actually used — into a structured, sanity-checkable
// number.
//
// VERIFIED AGAINST REAL LIVE DATA before writing this (2026-08-25): of the 3
// transactions with commission_rate populated in production, the values were:
//   "2.5%"
//   "$3,500.00 flat fee (no percentage specified)"
//   "5.500% total (2.500% to buyer's broker)"
// This is not a clean numeric column — it is prose. The naive parse already
// used elsewhere (api/net-sheet.js's contract-default path:
// `parseFloat(String(rate).replace(/[^0-9.]/g,''))`) silently turns the flat
// fee example into commissionPct = 3500 (it strips the $ and the "no
// percentage specified" text and reads the digits as a percent) — which
// would compute a $2.29M commission on a $65,500 sale if that default were
// ever used unmodified. That specific failure mode is exactly what
// cron-financial-sanity.js's commission check exists to catch.
//
// Owner: Carter, 2026-08-25 (Alpha TC Roadmap #1 — financial sanity check)

// Real TX commissions run roughly 4-8% total in typical practice. 10% is a
// deliberately generous ceiling — anything parsed above it is far more
// likely a mis-extraction (flat fee read as a percent, stray digits) than a
// real commission rate, so it's flagged for a human to confirm rather than
// silently trusted.
const MAX_PLAUSIBLE_PCT = 10;
const MIN_PLAUSIBLE_PCT = 0.5;

/**
 * @param {string|number|null} raw commission_rate value off the transaction
 * @returns {{
 *   kind: 'percent'|'flat'|'ambiguous'|'empty',
 *   totalPct: number|null,
 *   flatAmount: number|null,
 *   raw: string,
 * }}
 */
function parseCommissionRate(raw) {
  const text = (raw == null ? '' : String(raw)).trim();
  if (!text) return { kind: 'empty', totalPct: null, flatAmount: null, raw: text };

  // "5.500% total (2.500% to buyer's broker)" / "6% total" style — take the
  // percentage explicitly labeled "total" when more than one % appears.
  const totalMatch = text.match(/([\d.]+)\s*%\s*total/i);
  if (totalMatch) {
    const pct = parseFloat(totalMatch[1]);
    if (Number.isFinite(pct)) return { kind: 'percent', totalPct: pct, flatAmount: null, raw: text };
  }

  const allPcts = [...text.matchAll(/([\d.]+)\s*%/g)].map((m) => parseFloat(m[1])).filter(Number.isFinite);
  const flatMatch = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  const flatAmount = flatMatch ? parseFloat(flatMatch[1].replace(/,/g, '')) : null;
  const mentionsFlat = /flat\s*fee/i.test(text);

  if (allPcts.length === 1 && flatAmount == null) {
    return { kind: 'percent', totalPct: allPcts[0], flatAmount: null, raw: text };
  }

  if (mentionsFlat && flatAmount != null && allPcts.length === 0) {
    return { kind: 'flat', totalPct: null, flatAmount, raw: text };
  }

  // More than one un-labeled percentage (a split with no "total" marker), a
  // flat dollar amount that also carries stray % text, or nothing usable at
  // all — don't guess which number is the real total.
  if (allPcts.length > 1 || (flatAmount != null && allPcts.length >= 1)) {
    return { kind: 'ambiguous', totalPct: null, flatAmount: null, raw: text };
  }
  if (flatAmount != null) {
    return { kind: 'flat', totalPct: null, flatAmount, raw: text };
  }
  return { kind: 'ambiguous', totalPct: null, flatAmount: null, raw: text };
}

/**
 * Given a parsed commission_rate and the transaction's sale_price, decide
 * whether the implied commission dollar figure is plausible enough to trust
 * without a human double-checking it.
 * @returns {{ implausible: boolean, reason: string|null, impliedAmount: number|null, impliedPct: number|null }}
 */
function checkCommissionPlausibility(parsed, salePrice) {
  const sp = Number(salePrice);
  if (parsed.kind === 'empty') {
    return { implausible: false, reason: null, impliedAmount: null, impliedPct: null };
  }
  if (parsed.kind === 'ambiguous') {
    return {
      implausible: true,
      reason: `commission_rate is not a single clear number ("${parsed.raw}") — can't verify it without a human reading the contract`,
      impliedAmount: null,
      impliedPct: null,
    };
  }
  if (parsed.kind === 'percent') {
    const impliedAmount = Number.isFinite(sp) ? Math.round(sp * parsed.totalPct) / 100 : null;
    if (parsed.totalPct > MAX_PLAUSIBLE_PCT) {
      return {
        implausible: true,
        reason: `${parsed.totalPct}% of the sale price is well outside a normal Texas commission range (this is almost always a mis-extraction, e.g. a flat fee misread as a percent)`,
        impliedAmount,
        impliedPct: parsed.totalPct,
      };
    }
    if (parsed.totalPct < MIN_PLAUSIBLE_PCT) {
      return {
        implausible: true,
        reason: `${parsed.totalPct}% is unusually low for a total commission — confirm this wasn't truncated during extraction`,
        impliedAmount,
        impliedPct: parsed.totalPct,
      };
    }
    return { implausible: false, reason: null, impliedAmount, impliedPct: parsed.totalPct };
  }
  if (parsed.kind === 'flat') {
    if (!Number.isFinite(sp) || sp <= 0) {
      return { implausible: false, reason: null, impliedAmount: parsed.flatAmount, impliedPct: null };
    }
    const impliedPct = Math.round((parsed.flatAmount / sp) * 10000) / 100;
    if (impliedPct > MAX_PLAUSIBLE_PCT) {
      return {
        implausible: true,
        reason: `the flat fee ($${parsed.flatAmount.toLocaleString('en-US')}) works out to ${impliedPct}% of the sale price — confirm this is really flat and not a mis-scanned percentage`,
        impliedAmount: parsed.flatAmount,
        impliedPct,
      };
    }
    return { implausible: false, reason: null, impliedAmount: parsed.flatAmount, impliedPct };
  }
  return { implausible: false, reason: null, impliedAmount: null, impliedPct: null };
}

module.exports = { parseCommissionRate, checkCommissionPlausibility, MAX_PLAUSIBLE_PCT, MIN_PLAUSIBLE_PCT };
