// api/_lib/net-sheet-estimate.js
//
// The ESTIMATE layer on top of api/_lib/net-sheet-calc.js.
//
// net-sheet-calc.js does pure arithmetic and treats every absent input as 0.
// That is correct for arithmetic and dangerous for a seller. A missing
// mortgage payoff silently becomes "$0 payoff", which turns an unknown into
// the most flattering possible number and hands the seller a proceeds figure
// that is not merely wrong but wrong in the direction they want to believe.
//
// Heath, 2026-09-20: "Net sheets are estimates so make sure that's known by
// all." In Texas, presenting an estimate as a guarantee of proceeds is a real
// liability — the binding numbers come off the title company's settlement
// statement at closing, not from us.
//
// So this module enforces three rules the raw calculator cannot:
//
//   1. UNKNOWN IS NOT ZERO. A figure nobody has supplied is reported as
//      unknown and excluded from the arithmetic. It is never silently
//      defaulted. A figure that genuinely does not apply (no HOA, seller
//      pays no warranty) must be said explicitly — status 'na' — and only
//      then does it count as a real zero.
//
//   2. UNKNOWNS MAKE THE TOTAL A RANGE, NOT A POINT. With anything unknown
//      we can only state a ceiling: sale price less the deductions we
//      actually know. The floor is genuinely unbounded, because we do not
//      know what the missing items cost, and we refuse to invent a
//      "typical" value to close the range. The range is therefore
//      [unknown, ceiling] and it is labelled that way in words.
//
//   3. EVERY FIGURE CARRIES A SOURCE AND A DATE — never a "confirmed" flag.
//      Marking some numbers confirmed invites a seller to read those as
//      final and the rest as soft. They are all estimates. Saying where a
//      number came from and when lets the agent judge staleness without
//      implying any of it is binding.
//
// The arithmetic itself is still delegated to calculateNetSheet() so there
// remains exactly ONE formula in the codebase and
// api/cron-financial-sanity.js's reconciliation check stays meaningful.
//
// Owner: 2026-09-20. Consumes whatever supplies the figures — today the
// chat tool and the /api/net-sheet form, tomorrow a seller-intake record.
// The input shape is deliberately generic so a new source plugs in without
// touching this file.

const { calculateNetSheet, reconcileBreakdown } = require('./net-sheet-calc');

// The deduction/credit line items, in the order a seller should read them.
// `material: true` marks a line big enough that a missing value makes the
// whole estimate untrustworthy rather than merely incomplete — these get
// called out by name instead of being counted in a footnote.
const LINE_DEFS = [
  { key: 'mortgage_payoff', label: 'Mortgage Payoff', kind: 'deduction', material: true,
    hint: 'Ask the lender for a written payoff good through the closing date.' },
  { key: 'escrow_fee', label: 'Escrow / Closing Fee', kind: 'deduction',
    hint: 'Title company quote.' },
  { key: 'title_policy_cost', label: "Owner's Title Policy", kind: 'deduction', material: true,
    hint: 'Promulgated rate — title company can quote it exactly.' },
  { key: 'hoa_transfer_fee', label: 'HOA Transfer Fee', kind: 'deduction',
    hint: 'HOA or management company. Mark not-applicable if there is no HOA.' },
  { key: 'home_warranty_cap', label: 'Home Warranty Reimbursement', kind: 'deduction',
    hint: 'From the contract if the seller agreed to pay it.' },
  { key: 'survey_cost', label: 'Survey', kind: 'deduction',
    hint: 'Only if the seller is providing a new survey.' },
  { key: 'repairs', label: 'Agreed Repairs', kind: 'deduction',
    hint: 'Unknown until the amendment is negotiated.' },
  { key: 'other_credits', label: 'Other Credits to Buyer', kind: 'deduction',
    hint: 'Closing-cost help, concessions.' },
  { key: 'option_fee_credit', label: 'Option Fee Credit', kind: 'credit',
    hint: 'Credited back to the seller at closing (TREC Para 23).' },
];

const LINE_BY_KEY = new Map(LINE_DEFS.map((d) => [d.key, d]));

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Parse one supplied figure into { status, amount, source, asOf }.
//
// Accepted shapes, deliberately permissive because callers differ:
//   undefined | null            -> unknown
//   42 | "42" | "$1,200.00"     -> known, source unattributed
//   { value, source, as_of }    -> known with provenance
//   { na: true, source }        -> explicitly not applicable (a real zero)
//   { unknown: true }           -> explicitly unknown
//
// An empty string is unknown, NOT zero — a blank form field means the agent
// has not filled it in, which is the single most likely way a bad number
// gets in.
function parseFigure(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { status: 'unknown', amount: null, source: null, asOf: null };
  }

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const source = raw.source ? String(raw.source) : null;
    const asOf = raw.as_of || raw.asOf || null;
    if (raw.na === true || raw.not_applicable === true) {
      return { status: 'na', amount: 0, source, asOf };
    }
    if (raw.unknown === true) {
      return { status: 'unknown', amount: null, source, asOf };
    }
    const inner = parseFigure(raw.value);
    return { ...inner, source: source || inner.source, asOf: asOf || inner.asOf };
  }

  // Scalar. Strip currency formatting but reject anything that leaves no
  // digits behind ("TBD", "ask title", "-") rather than coercing it to 0.
  const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    return { status: 'unknown', amount: null, source: null, asOf: null };
  }
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    return { status: 'unknown', amount: null, source: null, asOf: null };
  }
  return { status: 'known', amount: Math.abs(n), source: null, asOf: null };
}

// Wrap raw values the member supplied (spoken, or typed into a form) with
// their provenance, and translate the words people actually use for "this one
// doesn't apply" and "I don't know" into the two distinct states the estimate
// depends on. Shared by /api/net-sheet-estimate and the net sheet that rides
// along with /api/send-compliance-packet, so a figure carries the same source
// label whichever surface rendered it.
const NA_WORDS = new Set(['n/a', 'na', 'none', 'not applicable', 'no', 'nil', 'zero - none']);
const UNKNOWN_WORDS = new Set(['unknown', 'tbd', '?', 'dont know', "don't know", 'not sure']);

function normalizeMemberFigure(value, asOf) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value; // already shaped
  const s = String(value).trim().toLowerCase();
  if (NA_WORDS.has(s)) return { na: true, source: 'member', as_of: asOf };
  if (UNKNOWN_WORDS.has(s)) return { unknown: true };
  return { value, source: 'member', as_of: asOf };
}

function normalizeMemberFigures(raw, asOf) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const def of LINE_DEFS) {
    const shaped = normalizeMemberFigure(raw[def.key], asOf);
    if (shaped !== undefined) out[def.key] = shaped;
  }
  return out;
}

function fmtMoney(n) {
  if (!isFiniteNumber(n)) return null;
  return n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2,
  });
}

function fmtDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Human label for where a number came from. Deliberately descriptive
// ("from the contract") rather than evaluative ("confirmed") — see rule 3.
const SOURCE_LABELS = {
  contract: 'from the contract',
  listing_agreement: 'from the listing agreement',
  member: 'entered by you',
  agent: 'entered by you',
  title_quote: 'title company quote',
  lender_payoff: 'lender payoff statement',
  hoa: 'HOA / management company',
  intake: 'from the seller intake',
  estimate_default: 'office default',
};

function sourceLabel(source) {
  if (!source) return 'source not recorded';
  return SOURCE_LABELS[source] || String(source);
}

/**
 * Build an estimated seller's net sheet that is explicit about what it does
 * not know.
 *
 * @param {object} args
 * @param {number|string|object} args.salePrice      required
 * @param {number|string|object} args.commissionPct  required (total % off the top)
 * @param {object} args.figures  map of LINE_DEFS key -> figure (see parseFigure)
 * @param {string} [args.propertyAddress]
 * @param {string} [args.sellerName]
 * @param {Date}   [args.now]
 */
function buildNetSheetEstimate({
  salePrice,
  commissionPct,
  figures = {},
  propertyAddress = '',
  sellerName = '',
  now = new Date(),
}) {
  const priceFig = parseFigure(salePrice);
  if (priceFig.status !== 'known' || !priceFig.amount) {
    const err = new Error('A sale price is required before I can estimate net proceeds.');
    err.code = 'MISSING_SALE_PRICE';
    throw err;
  }
  const price = priceFig.amount;

  // Commission is its own special case: it is a percentage, it is almost
  // always the largest deduction after the payoff, and defaulting it (the
  // old endpoint quietly used 3) is exactly the substitution this module
  // exists to prevent. Unknown commission => unknown commission.
  const commFig = parseFigure(commissionPct);
  const commissionKnown = commFig.status === 'known' && isFiniteNumber(commFig.amount);
  const commissionPctValue = commissionKnown ? commFig.amount : null;
  const commissionAmount = commissionKnown ? (price * commissionPctValue) / 100 : null;

  const lines = [];
  let knownDeductionTotal = 0;
  let knownCreditTotal = 0;
  const unknown = [];
  const materialUnknown = [];

  // Sale price row first — it is income, and it is the one figure that is
  // never unknown by the time we get here.
  lines.push({
    key: 'sale_price',
    label: 'Sale Price',
    kind: 'income',
    status: 'known',
    amount: price,
    display: fmtMoney(price),
    source: priceFig.source || null,
    sourceLabel: sourceLabel(priceFig.source),
    asOf: fmtDate(priceFig.asOf || now),
  });

  // Commission row.
  lines.push({
    key: 'commission',
    label: commissionKnown
      ? `Commission (${commissionPctValue.toFixed(2)}%)`
      : 'Commission (rate not recorded)',
    kind: 'deduction',
    material: true,
    status: commissionKnown ? 'known' : 'unknown',
    amount: commissionKnown ? -commissionAmount : null,
    display: commissionKnown ? `(${fmtMoney(commissionAmount)})` : 'Unknown',
    source: commFig.source || null,
    sourceLabel: sourceLabel(commFig.source),
    asOf: fmtDate(commFig.asOf || (commissionKnown ? now : null)),
    hint: commissionKnown ? null : 'Total commission % from the listing agreement.',
  });
  if (commissionKnown) {
    knownDeductionTotal += commissionAmount;
  } else {
    unknown.push({ key: 'commission', label: 'Commission', material: true,
      hint: 'Total commission % from the listing agreement.' });
    materialUnknown.push('Commission');
  }

  for (const def of LINE_DEFS) {
    const fig = parseFigure(figures[def.key]);
    const isCredit = def.kind === 'credit';

    if (fig.status === 'unknown') {
      lines.push({
        key: def.key,
        label: def.label,
        kind: def.kind,
        material: Boolean(def.material),
        status: 'unknown',
        amount: null,
        display: 'Unknown',
        source: null,
        sourceLabel: sourceLabel(null),
        asOf: null,
        hint: def.hint || null,
      });
      unknown.push({ key: def.key, label: def.label, material: Boolean(def.material), hint: def.hint || null });
      if (def.material) materialUnknown.push(def.label);
      continue;
    }

    const amt = fig.amount || 0;
    if (fig.status === 'na') {
      lines.push({
        key: def.key,
        label: def.label,
        kind: def.kind,
        status: 'na',
        amount: 0,
        display: 'Does not apply',
        source: fig.source || null,
        sourceLabel: sourceLabel(fig.source),
        asOf: fmtDate(fig.asOf),
      });
      continue;
    }

    if (isCredit) knownCreditTotal += amt;
    else knownDeductionTotal += amt;

    lines.push({
      key: def.key,
      label: def.label,
      kind: def.kind,
      status: 'known',
      amount: isCredit ? amt : -amt,
      display: isCredit ? fmtMoney(amt) : `(${fmtMoney(amt)})`,
      source: fig.source || null,
      sourceLabel: sourceLabel(fig.source),
      asOf: fmtDate(fig.asOf),
    });
  }

  const hasUnknowns = unknown.length > 0;

  // The ceiling: what is left after only the costs we actually know. With
  // anything unknown this is an upper bound the seller will not exceed, not
  // a prediction.
  const ceiling = price - knownDeductionTotal + knownCreditTotal;

  // A point estimate exists ONLY when nothing is unknown. In that case run
  // it back through the shared calculator so there is one formula and the
  // financial-sanity cron's reconciliation still applies.
  let point = null;
  let reconciliation = null;
  if (!hasUnknowns) {
    const known = (k) => {
      const f = parseFigure(figures[k]);
      return f.status === 'known' || f.status === 'na' ? (f.amount || 0) : 0;
    };
    const calc = calculateNetSheet({
      salePrice: price,
      commissionPct: commissionPctValue,
      mortgagePayoff: known('mortgage_payoff'),
      escrowFee: known('escrow_fee'),
      titlePolicyCost: known('title_policy_cost'),
      hoaTransferFee: known('hoa_transfer_fee'),
      homeWarrantyCap: known('home_warranty_cap'),
      surveyCost: known('survey_cost'),
      repairs: known('repairs'),
      otherCredits: known('other_credits'),
      optionFeeCredit: known('option_fee_credit'),
    });
    point = calc.netProceeds;
    reconciliation = reconcileBreakdown({
      salePrice: price,
      breakdown: calc.breakdown,
      netProceeds: calc.netProceeds,
    });
  }

  const disclaimer = buildDisclaimer({ hasUnknowns, unknown, materialUnknown });

  return {
    propertyAddress: propertyAddress || '',
    sellerName: sellerName || '',
    salePrice: price,
    commissionPct: commissionPctValue,
    lines,
    unknown,
    materialUnknown,
    hasUnknowns,
    knownDeductionTotal,
    knownCreditTotal,
    ceiling,
    point,
    reconciliation,
    // The headline figure, already phrased. Callers should render THIS
    // rather than formatting `point`/`ceiling` themselves, so no surface can
    // accidentally present a ceiling as if it were a prediction.
    headline: hasUnknowns
      ? `Up to ${fmtMoney(ceiling)} — before ${unknown.length} figure${unknown.length === 1 ? '' : 's'} we don't have yet`
      : `${fmtMoney(ceiling)} estimated`,
    headlineAmount: hasUnknowns ? null : ceiling,
    ceilingDisplay: fmtMoney(ceiling),
    disclaimer,
    generatedAt: now.toISOString(),
    generatedAtDisplay: fmtDate(now),
  };
}

// The disclaimer is content, not chrome. It is returned as structured text so
// every surface (chat bubble, HTML document, email body) renders the same
// words, and it is placed next to the number rather than in a footer.
function buildDisclaimer({ hasUnknowns, unknown, materialUnknown }) {
  const headline = 'This is an estimate, not a guarantee.';

  const body = [
    'Final numbers come from the title company’s settlement statement at closing and will be different from these.',
  ];

  if (hasUnknowns) {
    const names = unknown.map((u) => u.label).join(', ');
    body.push(
      `${unknown.length} figure${unknown.length === 1 ? ' is' : 's are'} still unknown (${names}), ` +
      'so they are not included in the total above. Actual proceeds will be LOWER than the figure shown ' +
      'by whatever those come to.',
    );
  }

  if (materialUnknown.length) {
    body.push(
      `${materialUnknown.join(' and ')} ${materialUnknown.length === 1 ? 'is' : 'are'} missing — ` +
      `${materialUnknown.length === 1 ? 'that is' : 'those are'} usually among the largest ` +
      'line items, so treat this as a rough ceiling rather than a working number until it is filled in.',
    );
  }

  return {
    headline,
    body,
    // One flattened string for plain-text surfaces (SMS, email text part).
    text: [headline, ...body].join(' '),
  };
}

// Prominent on-document disclaimer block. Deliberately NOT the 11px grey
// footer the old net sheet used — that is a footnote, and a footnote is how
// a seller ends up believing the bottom line is binding.
function disclaimerHtml(disclaimer) {
  const paras = disclaimer.body
    .map((p) => `<p style="margin:0 0 8px;">${escapeHtml(p)}</p>`)
    .join('');
  return (
    '<div style="border:2px solid #C9A96E;background:#FBF6EC;border-radius:6px;' +
    'padding:14px 16px;margin:20px 0;font-size:13px;line-height:1.55;color:#4A4033;">' +
    `<p style="margin:0 0 8px;font-weight:700;font-size:14px;color:#1A1A2E;">${escapeHtml(disclaimer.headline)}</p>` +
    paras +
    '</div>'
  );
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Printable / emailable net sheet.
 *
 * Layout order is deliberate: the disclaimer sits ABOVE the proceeds line,
 * so it cannot be scrolled past or cropped off a screenshot of the number.
 * Each row shows its own source and date in a column of its own.
 */
function buildEstimateHtml(est) {
  const rowsHtml = est.lines.map((line) => {
    const isUnknown = line.status === 'unknown';
    const isNa = line.status === 'na';
    const amountColor = isUnknown ? '#B8860B' : (line.kind === 'deduction' ? '#c0392b' : '#2c3e50');
    const prov = isUnknown
      ? (line.hint ? escapeHtml(line.hint) : 'Not supplied')
      : `${escapeHtml(line.sourceLabel)}${line.asOf ? ` &bull; ${escapeHtml(line.asOf)}` : ''}`;
    return (
      '<tr>' +
      `<td style="padding:9px 12px;border-bottom:1px solid #f0e8e4;">${escapeHtml(line.label)}` +
      (line.material && isUnknown ? ' <span style="color:#B8860B;font-weight:700;">&#9888;</span>' : '') +
      '</td>' +
      `<td style="padding:9px 12px;border-bottom:1px solid #f0e8e4;font-size:11px;color:#8A8578;">${prov}</td>` +
      `<td style="padding:9px 12px;border-bottom:1px solid #f0e8e4;text-align:right;color:${amountColor};` +
      (isUnknown || isNa ? 'font-style:italic;' : '') +
      `">${escapeHtml(line.display)}</td>` +
      '</tr>'
    );
  }).join('');

  const netLabel = est.hasUnknowns ? 'Estimated Proceeds Ceiling' : 'Estimated Net Proceeds';
  const netValue = est.hasUnknowns
    ? `No more than ${escapeHtml(est.ceilingDisplay)}`
    : escapeHtml(est.ceilingDisplay);

  return '<!DOCTYPE html>' +
    '<html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Seller’s Net Sheet — Estimate</title>' +
    '<style>' +
    'body{font-family:Georgia,serif;background:#fff;color:#2c3e50;max-width:680px;margin:40px auto;padding:24px;}' +
    '@media print{body{margin:0;padding:16px;}}' +
    '.header{text-align:center;margin-bottom:20px;}' +
    '.header h1{font-size:22px;color:#1A1A2E;margin:0 0 4px;}' +
    '.header .est{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#B8860B;font-weight:700;}' +
    '.header p{color:#666;font-size:13px;margin:2px 0 0;}' +
    'table{width:100%;border-collapse:collapse;font-size:14px;margin-bottom:4px;}' +
    'th{background:#F5E6E0;color:#1A1A2E;padding:9px 12px;text-align:left;font-weight:600;font-size:12px;}' +
    'th:last-child{text-align:right;}' +
    '.net-row td{background:#1A1A2E;color:#fff;font-weight:700;font-size:16px;padding:14px 12px;}' +
    '.net-row td:last-child{text-align:right;color:#C9A96E;}' +
    '.footer{font-size:11px;color:#999;text-align:center;margin-top:16px;}' +
    '</style>' +
    '</head><body>' +
    '<div class="header">' +
    '<div class="est">Estimate</div>' +
    '<h1>Seller’s Net Sheet</h1>' +
    (est.propertyAddress ? `<p>${escapeHtml(est.propertyAddress)}</p>` : '') +
    (est.sellerName ? `<p>Prepared for: ${escapeHtml(est.sellerName)}</p>` : '') +
    `<p>Prepared ${escapeHtml(est.generatedAtDisplay)}</p>` +
    '</div>' +
    // Disclaimer ABOVE the table and the total — see comment on this function.
    disclaimerHtml(est.disclaimer) +
    '<table>' +
    '<thead><tr><th>Item</th><th>Where it came from</th><th>Amount</th></tr></thead>' +
    `<tbody>${rowsHtml}</tbody>` +
    `<tfoot><tr class="net-row"><td colspan="2">${netLabel}</td><td>${netValue}</td></tr></tfoot>` +
    '</table>' +
    (est.hasUnknowns
      ? '<p style="font-size:12px;color:#B8860B;margin:10px 0 0;">⚠ Items marked <em>Unknown</em> are not included in the figure above. ' +
        'They will reduce it.</p>'
      : '') +
    `<p class="footer">Prepared by Dossie &bull; meetdossie.com &bull; ${escapeHtml(est.disclaimer.headline)}</p>` +
    '</body></html>';
}

module.exports = {
  LINE_DEFS,
  LINE_BY_KEY,
  parseFigure,
  normalizeMemberFigure,
  normalizeMemberFigures,
  buildNetSheetEstimate,
  buildEstimateHtml,
  disclaimerHtml,
  fmtMoney,
  sourceLabel,
};
