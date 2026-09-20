const { buildNetSheetEstimate, buildEstimateHtml } = require('../api/_lib/net-sheet-estimate');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// Nopalito: the real shipped offer.
const e1 = buildNetSheetEstimate({
  salePrice: 999000, commissionPct: { value: 5.5, source: 'listing_agreement' },
  figures: {}, propertyAddress: '23 Nopalito', sellerName: 'Test Seller',
});
ok(e1.hasUnknowns === true, 'unknowns present when nothing supplied');
ok(e1.point === null, 'no point estimate when unknowns exist');
ok(e1.ceiling === 999000 - 54945, 'ceiling = price - known commission only, got ' + e1.ceiling);
ok(e1.unknown.length === 9, 'all 9 line items unknown, got ' + e1.unknown.length);
ok(e1.materialUnknown.includes('Mortgage Payoff'), 'payoff flagged material');
ok(/Up to/.test(e1.headline), 'headline is a ceiling: ' + e1.headline);
ok(/LOWER/.test(e1.disclaimer.text), 'disclaimer warns proceeds will be lower');

// THE CRITICAL TEST: a missing payoff must not become $0.
ok(!e1.lines.find((l) => l.key === 'mortgage_payoff' && l.amount === 0), 'missing payoff is NOT zero');
ok(e1.lines.find((l) => l.key === 'mortgage_payoff').status === 'unknown', 'missing payoff is unknown');

// n/a is a real zero and does NOT count as unknown.
const e2 = buildNetSheetEstimate({
  salePrice: 999000, commissionPct: 5.5,
  figures: {
    mortgage_payoff: { value: 400000, source: 'lender_payoff' },
    escrow_fee: 450, title_policy_cost: 5200,
    hoa_transfer_fee: { na: true }, home_warranty_cap: { na: true },
    survey_cost: { na: true }, repairs: { na: true }, other_credits: { na: true },
    option_fee_credit: 500,
  },
});
ok(e2.hasUnknowns === false, 'no unknowns when all supplied or n/a');
ok(e2.point !== null, 'point estimate exists when complete');
const expected = 999000 - 54945 - 400000 - 450 - 5200 + 500;
ok(Math.abs(e2.point - expected) < 0.01, 'point math: got ' + e2.point + ' want ' + expected);
ok(e2.reconciliation && e2.reconciliation.ok, 'reconciles against shared calculator');
ok(!/still unknown/.test(e2.disclaimer.text), 'no unknown clause when complete');
ok(/estimate, not a guarantee/.test(e2.disclaimer.headline), 'disclaimer still present when complete');

// Unknown commission must not default to 3%.
const e3 = buildNetSheetEstimate({ salePrice: 500000, commissionPct: undefined, figures: {} });
ok(e3.lines.find((l) => l.key === 'commission').status === 'unknown', 'unstated commission is unknown, not 3%');
ok(e3.ceiling === 500000, 'ceiling untouched by unknown commission');

// Garbage strings are unknown, not zero.
const e4 = buildNetSheetEstimate({ salePrice: 500000, commissionPct: 3, figures: { escrow_fee: 'TBD', title_policy_cost: 'ask title' } });
ok(e4.lines.find((l) => l.key === 'escrow_fee').status === 'unknown', '"TBD" is unknown not 0');
ok(e4.lines.find((l) => l.key === 'title_policy_cost').status === 'unknown', '"ask title" is unknown not 0');

// Empty string (blank form field) is unknown, not zero.
const e5 = buildNetSheetEstimate({ salePrice: 500000, commissionPct: 3, figures: { mortgage_payoff: '' } });
ok(e5.lines.find((l) => l.key === 'mortgage_payoff').status === 'unknown', 'blank is unknown not 0');

// Missing sale price throws rather than guessing.
try { buildNetSheetEstimate({ salePrice: null, commissionPct: 3, figures: {} }); ok(false, 'should throw'); }
catch (err) { ok(err.code === 'MISSING_SALE_PRICE', 'missing price throws'); }

// Disclaimer must appear in the HTML ABOVE the proceeds total.
const html = buildEstimateHtml(e1);
const dIdx = html.indexOf('estimate, not a guarantee');
const tIdx = html.indexOf('Estimated Proceeds Ceiling');
ok(dIdx > -1, 'disclaimer in html');
ok(dIdx < tIdx, 'disclaimer appears BEFORE the total (not a footnote)');
ok(/Where it came from/.test(html), 'source column rendered');
ok(!/confirmed/i.test(html), 'never labels a figure "confirmed"');
ok(/No more than/.test(html), 'total phrased as ceiling when unknowns exist');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
