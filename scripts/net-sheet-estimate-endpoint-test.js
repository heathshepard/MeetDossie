// Integration test for /api/net-sheet-estimate — the route the chat tool
// calls. The arithmetic and the unknown/zero rules are covered by
// scripts/net-sheet-estimate-test.js; this checks the wiring: auth, the
// owner-scoped transaction read, contract fallbacks, and the response shape
// the NetSheetCard renders.
//
// Nothing here touches a real database. global.fetch is fully mocked.

const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

const authPath = require.resolve(path.join(ROOT, 'api/_middleware/auth.js'));
const realAuth = require(authPath);
require.cache[authPath].exports = {
  ...realAuth,
  verifySupabaseToken: async () => ({ userId: 'user-1', email: 'member@example.com' }),
};

const TX = {
  property_address: '23 Nopalito', sale_price: 999000,
  commission_rate: '5.5%', seller_name: 'Linton', option_fee: 500,
  updated_at: '2026-09-18T00:00:00Z',
};
let txRows = [TX];
let lastTxQuery = '';

global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/rest/v1/transactions')) {
    lastTxQuery = u;
    return { ok: true, status: 200, json: async () => txRows, text: async () => '' };
  }
  return { ok: false, status: 404, text: async () => 'unmocked ' + u, json: async () => ({}) };
};

const handler = require(path.join(ROOT, 'api/net-sheet-estimate.js'));

function mkRes() {
  const r = { statusCode: null, payload: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.payload = p; return r; };
  r.end = () => r;
  return r;
}
async function call(body) {
  const req = { method: 'POST', headers: { origin: 'https://meetdossie.com', authorization: 'Bearer x' }, body };
  const res = mkRes();
  await handler(req, res);
  return res;
}

(async () => {
  // ---- contract-only: everything the contract doesn't hold is unknown ----
  const r1 = await call({ transaction_id: 'tx-1' });
  ok(r1.statusCode === 200, 'contract-only 200, got ' + r1.statusCode);
  ok(r1.payload.ok === true, 'ok');
  ok(r1.payload.has_unknowns === true, 'unknowns present');
  ok(r1.payload.point === null, 'no point estimate');
  ok(/Up to/.test(r1.payload.headline), 'headline is a ceiling: ' + r1.payload.headline);
  ok(r1.payload.sale_price === 999000, 'sale price off the contract');
  ok(r1.payload.commission_pct === 5.5, 'commission parsed from "5.5%"');
  ok(Array.isArray(r1.payload.lines) && r1.payload.lines.length > 0, 'lines returned for the card');
  ok(typeof r1.payload.html === 'string' && r1.payload.html.includes('<!DOCTYPE html>'), 'printable html returned');
  ok(r1.payload.disclaimer && /estimate, not a guarantee/.test(r1.payload.disclaimer.headline), 'disclaimer returned');

  // option fee from the contract is a credit, sourced as such
  const optLine = r1.payload.lines.find((l) => l.key === 'option_fee_credit');
  ok(optLine && optLine.status === 'known', 'option fee credit picked up from the contract');
  ok(optLine && /contract/.test(optLine.sourceLabel), 'option fee attributed to the contract');

  // mortgage payoff must be unknown, never 0
  const payoff = r1.payload.lines.find((l) => l.key === 'mortgage_payoff');
  ok(payoff && payoff.status === 'unknown', 'payoff unknown, not zero');

  // ---- multi-tenant: query must be scoped to the caller ----
  ok(lastTxQuery.includes('user_id=eq.user-1'), 'transaction read is owner-scoped');

  // ---- member figures override and are attributed to them ----
  const r2 = await call({
    transaction_id: 'tx-1',
    mortgage_payoff: 400000,
    escrow_fee: 450,
    title_policy_cost: 5200,
    hoa_transfer_fee: 'n/a',
    home_warranty_cap: 'none',
    survey_cost: 'n/a',
    repairs: 'n/a',
    other_credits: 'n/a',
  });
  ok(r2.payload.has_unknowns === false, 'complete once member supplies the rest');
  ok(r2.payload.point !== null, 'point estimate now exists');
  const expected = 999000 - 54945 - 400000 - 450 - 5200 + 500;
  ok(Math.abs(r2.payload.point - expected) < 0.01, 'endpoint math: got ' + r2.payload.point + ' want ' + expected);
  const payoff2 = r2.payload.lines.find((l) => l.key === 'mortgage_payoff');
  ok(/entered by you/.test(payoff2.sourceLabel), 'member figure attributed to the member');
  const hoa = r2.payload.lines.find((l) => l.key === 'hoa_transfer_fee');
  ok(hoa.status === 'na', '"n/a" recorded as does-not-apply, not unknown');
  ok(r2.payload.reconciliation && r2.payload.reconciliation.ok, 'reconciles against the shared calculator');

  // ---- "unknown" words stay unknown ----
  const r3 = await call({ transaction_id: 'tx-1', mortgage_payoff: 'TBD' });
  ok(r3.payload.lines.find((l) => l.key === 'mortgage_payoff').status === 'unknown', '"TBD" stays unknown');

  // ---- another member's dossier is simply not found ----
  txRows = [];
  const r4 = await call({ transaction_id: 'tx-other' });
  ok(r4.statusCode === 404, "other member's dossier is 404, got " + r4.statusCode);
  txRows = [TX];

  // ---- no transaction_id ----
  const r5 = await call({});
  ok(r5.statusCode === 400, 'missing transaction_id is 400');

  // ---- a dossier with no sale price refuses rather than inventing one ----
  txRows = [{ ...TX, sale_price: null }];
  const r6 = await call({ transaction_id: 'tx-1' });
  ok(r6.statusCode === 400 && /sale price/i.test(r6.payload.error), 'no sale price => refuses, does not guess');
  txRows = [TX];

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
