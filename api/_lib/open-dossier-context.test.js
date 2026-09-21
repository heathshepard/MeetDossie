// api/_lib/open-dossier-context.test.js
//
// Run with: node --test api/_lib/open-dossier-context.test.js
//
// Stubs global.fetch so this never hits a real Supabase project. Proves the
// two things that matter: the lookup is scoped to id AND user_id together
// (an id belonging to someone else must come back empty), and a miss is
// treated as "no open dossier" rather than thrown.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { loadOpenDossierContext } = require('./open-dossier-context.js');

const OWNER = '00000000-1111-4111-8111-000000000001';
const ATTACKER = '00000000-2222-4222-8222-000000000002';
const TX_ID = '00000000-3333-4333-8333-000000000003';

function stubFetch(rowsByUser) {
  global.fetch = async (url) => {
    const u = new URL(url);
    const idFilter = u.searchParams.get('id');
    const userFilter = u.searchParams.get('user_id');
    const id = idFilter && idFilter.replace('eq.', '');
    const uid = userFilter && userFilter.replace('eq.', '');
    const rows = (rowsByUser[uid] || []).filter((r) => r.id === id);
    return { ok: true, json: async () => rows };
  };
}

test('resolves the open dossier when it belongs to the caller', async () => {
  stubFetch({
    [OWNER]: [{ id: TX_ID, property_address: '23 Nopalito', sale_price: 999000, stage: 'under-contract' }],
  });
  const { block, transaction } = await loadOpenDossierContext(TX_ID, OWNER);
  assert.ok(block.includes('CURRENTLY OPEN DOSSIER'));
  assert.ok(block.includes('23 Nopalito'));
  assert.equal(transaction.id, TX_ID);
});

test('an id that belongs to a DIFFERENT user resolves to nothing — never leaks cross-tenant', async () => {
  stubFetch({
    [ATTACKER]: [{ id: TX_ID, property_address: 'Someone else\'s house', sale_price: 500000, stage: 'closed' }],
  });
  // OWNER asks for a transaction that only exists under ATTACKER's user_id.
  const { block, transaction } = await loadOpenDossierContext(TX_ID, OWNER);
  assert.equal(block, '');
  assert.equal(transaction, null);
});

test('no id given -> no block, no query needed', async () => {
  global.fetch = async () => { throw new Error('must not fetch'); };
  const { block, transaction } = await loadOpenDossierContext(null, OWNER);
  assert.equal(block, '');
  assert.equal(transaction, null);
});

test('a fetch failure degrades to no open dossier rather than throwing', async () => {
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ([]) });
  const { block, transaction } = await loadOpenDossierContext(TX_ID, OWNER);
  assert.equal(block, '');
  assert.equal(transaction, null);
});
