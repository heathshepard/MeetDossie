#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/brokerage-funnel.js — the brokerage/
 * personal-brand funnel measurement (distinct from the Dossie funnel in
 * api/_lib/attribution.js).
 *
 * Covers:
 *   1. Leads are correctly split dossie vs heath-realtor via
 *      zernio_accounts.zernio_account_id -> owner.
 *   2. A lead whose account_id matches no known zernio_accounts row lands in
 *      'unknown', never silently dropped and never guessed into a brand.
 *   3. outcome_tracking degrades to an explicit "unavailable" state (never a
 *      crash, never a fabricated zero) when comment_dm_leads.outcome isn't
 *      migrated yet.
 *   4. downstream_tracking.automated is always false — this file must never
 *      claim to see past the DM itself.
 *
 * In-memory PostgREST-shaped mock, same pattern as scripts/regression-
 * attribution.js. ZERO production access.
 *
 * Run manually:
 *   node scripts/regression-brokerage-funnel.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { getBrokerageFunnelSummary } = require(path.join(REPO, 'api/_lib/brokerage-funnel.js'));

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(expr.slice(4));
  return true;
}

function makeMockSupabaseFetch(seed, { tables = ['zernio_accounts', 'comment_dm_leads'] } = {}) {
  const db = {};
  for (const t of tables) db[t] = (seed[t] || []).map((r) => ({ ...r }));
  return async function mockSupabaseFetch(pathAndQuery) {
    const [tablePath, queryString] = pathAndQuery.replace('/rest/v1/', '').split('?');
    const rows = db[tablePath];
    if (!rows) return { ok: false, status: 404, data: null };
    const params = new URLSearchParams(queryString || '');
    const filters = [...params.entries()].filter(([k]) => !['select', 'order', 'limit'].includes(k));
    const matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
    return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
  };
}

async function run() {
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => { pass++; console.log(`  PASS  ${name}`); })
      .catch((err) => { fail++; console.log(`  FAIL  ${name}\n        ${err.message}`); });
  }

  const now = new Date().toISOString();

  console.log('\n=== 1. Leads split correctly by owner via zernio_accounts.zernio_account_id ===');
  const seed1 = {
    zernio_accounts: [
      { zernio_account_id: 'zact_dossie_fb', owner: 'dossie', platform: 'facebook', is_active: true },
      { zernio_account_id: 'zact_heath_ig', owner: 'heath-realtor', platform: 'instagram', is_active: true },
    ],
    comment_dm_leads: [
      { id: 'lead-1', platform: 'facebook', account_id: 'zact_dossie_fb', keyword: 'TREC', dm_status: 'sent', delivered: true, read: false, triggered_at: now },
      { id: 'lead-2', platform: 'instagram', account_id: 'zact_heath_ig', keyword: 'DEADLINE', dm_status: 'sent', delivered: true, read: true, triggered_at: now },
      { id: 'lead-3', platform: 'instagram', account_id: 'zact_heath_ig', keyword: 'DEADLINE', dm_status: 'pending', delivered: false, read: false, triggered_at: now },
    ],
  };
  const summary1 = await getBrokerageFunnelSummary({ days: 30, supabaseFetch: makeMockSupabaseFetch(seed1) });

  await check('dossie bucket gets exactly the dossie-account lead', () => {
    assert.strictEqual(summary1.per_owner.dossie.leads_total, 1);
  });
  await check('heath-realtor bucket gets both heath-realtor-account leads', () => {
    assert.strictEqual(summary1.per_owner['heath-realtor'].leads_total, 2);
  });
  await check('dm_read only counts the one lead actually marked read', () => {
    assert.strictEqual(summary1.per_owner['heath-realtor'].dm_read, 1);
  });
  await check('by_keyword groups correctly within a bucket', () => {
    assert.strictEqual(summary1.per_owner['heath-realtor'].by_keyword.DEADLINE, 2);
  });
  await check('unknown_owner_count is 0 when every account_id resolves', () => {
    assert.strictEqual(summary1.unknown_owner_count, 0);
  });
  await check('downstream_tracking.automated is always false', () => {
    assert.strictEqual(summary1.downstream_tracking.automated, false);
  });

  console.log('\n=== 2. A lead from an unrecognized account_id lands in "unknown", never dropped, never guessed ===');
  const seed2 = {
    zernio_accounts: [
      { zernio_account_id: 'zact_dossie_fb', owner: 'dossie', platform: 'facebook', is_active: true },
    ],
    comment_dm_leads: [
      { id: 'lead-orphan', platform: 'facebook', account_id: 'zact_deleted_account', keyword: 'TREC', dm_status: 'sent', delivered: true, read: false, triggered_at: now },
    ],
  };
  const summary2 = await getBrokerageFunnelSummary({ days: 30, supabaseFetch: makeMockSupabaseFetch(seed2) });
  await check('orphaned lead counted in leads_total', () => {
    assert.strictEqual(summary2.leads_total, 1);
  });
  await check('orphaned lead counted in unknown_owner_count, not silently merged into dossie/heath-realtor', () => {
    assert.strictEqual(summary2.unknown_owner_count, 1);
    assert.strictEqual(summary2.per_owner.dossie.leads_total, 0);
    assert.strictEqual(summary2.per_owner['heath-realtor'].leads_total, 0);
  });
  await check('unknown_owner_note is present explaining why', () => {
    assert.ok(/retired\/deleted/.test(summary2.unknown_owner_note));
  });

  console.log('\n=== 3. outcome_tracking degrades explicitly when comment_dm_leads.outcome is not migrated yet ===');
  const seed3 = {
    zernio_accounts: [
      { zernio_account_id: 'zact_heath_ig', owner: 'heath-realtor', platform: 'instagram', is_active: true },
    ],
    comment_dm_leads: [
      { id: 'lead-4', platform: 'instagram', account_id: 'zact_heath_ig', keyword: 'DEADLINE', dm_status: 'sent', delivered: true, read: true, triggered_at: now },
    ],
  };
  // 'comment_dm_leads' IS a recognized table (so the leads query succeeds),
  // but the second (outcome-columns) query uses the exact same mock fetch,
  // which can't distinguish a missing COLUMN from a missing TABLE — so this
  // test simulates the real failure mode via a wrapping fetch that fails
  // only the second call, the one requesting outcome/outcome_at.
  let callCount = 0;
  const baseFetch = makeMockSupabaseFetch(seed3);
  const outageFetch = async (pathAndQuery) => {
    callCount++;
    if (pathAndQuery.includes('outcome')) {
      return { ok: false, status: 400, data: null }; // simulates "column outcome does not exist"
    }
    return baseFetch(pathAndQuery);
  };
  const summary3 = await getBrokerageFunnelSummary({ days: 30, supabaseFetch: outageFetch });
  await check('outcome_tracking reports "unavailable", not "ok"', () => {
    assert.ok(/unavailable/.test(summary3.outcome_tracking));
  });
  await check('per_owner bucket outcomes stays null, never a fabricated all-zero object', () => {
    assert.strictEqual(summary3.per_owner['heath-realtor'].outcomes, null);
  });
  await check('leads_total is still correct — the outcome-column failure never blocks the lead count itself', () => {
    assert.strictEqual(summary3.leads_total, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
