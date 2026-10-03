'use strict';

// api/_lib/transaction-send-gate.test.js
//
// Run: node --test api/_lib/transaction-send-gate.test.js
//
// Gate 1 + Gate 2 (docs/DOSSIE-TRANSACTION-AGENT-SPEC.md §3) — proves the
// real exported gateOutboundRecipient() refuses:
//   - the other side's represented principal (Gate 2 / Gate 3)
//   - an identity that cannot be confirmed because the side is unknown
//     (fail-closed on ambiguity, not fail-open)
//   - a transaction whose contract isn't confirmed executed, or is
//     ambiguous (two "executed" copies) — Gate 1
// and ALLOWS:
//   - the member's own client
//   - a non-principal role (title/lender/opposing agent) — emailing the
//     other side's AGENT is the correct route, never blocked
//   - any recipient when there is no transaction context at all
//
// Stubs global.fetch — never touches a real Supabase project.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const { gateOutboundRecipient } = require('./transaction-send-gate');

const USER = '00000000-1111-4111-8111-000000000001';
const TX_ID = '00000000-2222-4222-8222-000000000002';

// 23 Nopalito shape — Heath is the LISTING agent, the Bryans are the
// buyers (the other side's clients). One executed contract on file.
const LISTING_SIDE_TX = {
  id: TX_ID,
  role: 'listing',
  transaction_type: 'listing',
  seller_name: 'Barry Whyte',
  seller_email: 'barry@example.com',
  buyer_name: 'Christopher Bryan',
  buyer_email: 'buyercontact2@example.net',
  buyer2_name: 'Monica Bryan',
  buyer2_email: 'monica.bryan@example.com',
  parties: {},
};

const BUYER_SIDE_TX = {
  ...LISTING_SIDE_TX,
  role: 'buyer',
  transaction_type: 'buyer_purchase',
};

const SIDE_UNKNOWN_TX = {
  id: TX_ID,
  role: null,
  transaction_type: null,
  seller_name: 'Barry Whyte',
  seller_email: 'barry@example.com',
  buyer_name: 'Christopher Bryan',
  buyer_email: 'buyercontact2@example.net',
  parties: {},
};

const NO_PARTIES_YET_TX = {
  id: TX_ID,
  role: null,
  transaction_type: 'listing',
  seller_name: null,
  seller_email: null,
  buyer_name: null,
  buyer_email: null,
  parties: {},
};

function oneExecutedContractDoc() {
  return [{ id: 'doc-1', file_name: 'contract.pdf', executed_at: '2026-09-01T00:00:00Z' }];
}

/**
 * @param {object} opts
 * @param {object[]} opts.documents  rows returned for the documents?document_type=eq.trec-20-17 query
 * @param {object}   opts.tx         the transaction row to return (or null for "not found")
 * @param {Function} [opts.onFetch]  called with the URL for every call — use to assert nothing
 *                                   unexpected (e.g. DocuSeal/Resend) is ever reached by this module
 */
function stubFetch({ documents, tx, onFetch }) {
  global.fetch = async (url) => {
    if (onFetch) onFetch(String(url));
    const u = new URL(url);
    if (u.pathname.includes('/rest/v1/documents')) {
      return { ok: true, json: async () => documents };
    }
    if (u.pathname.includes('/rest/v1/transactions')) {
      return { ok: true, json: async () => (tx ? [tx] : []) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

test('no transactionId — nothing to protect, always allowed', async () => {
  stubFetch({ documents: [], tx: null, onFetch: () => { throw new Error('must not fetch — no transactionId'); } });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: null, email: 'anyone@example.com' });
  assert.equal(result.ok, true);
});

test('no email — nothing to classify, always allowed', async () => {
  stubFetch({ documents: [], tx: null, onFetch: () => { throw new Error('must not fetch — no email'); } });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: '' });
  assert.equal(result.ok, true);
});

test('REFUSES the other side\'s principal — listing agent, buyer is the opposing client', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'buyercontact2@example.net' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.blocked, 'opposing_principal');
  assert.match(result.error, /other side's client/i);
});

test('REFUSES the other side\'s principal — second buyer slot also blocked', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'monica.bryan@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, 'opposing_principal');
});

test('ALLOWS the member\'s own client — listing agent emailing the seller', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'barry@example.com' });
  assert.equal(result.ok, true);
});

test('ALLOWS a non-principal address not on the opposing blocklist (e.g. a lender)', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'loanofficer@examplebank.com' });
  assert.equal(result.ok, true);
});

test('side flips correctly on a buyer-side dossier — now the SELLER is blocked, buyer is fine', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: BUYER_SIDE_TX });
  const blocked = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'barry@example.com' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, 'opposing_principal');

  const allowed = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'buyercontact2@example.net' });
  assert.equal(allowed.ok, true);
});

test('AMBIGUOUS IDENTITY fails closed — side unknown AND parties are on file', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: SIDE_UNKNOWN_TX });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'buyercontact2@example.net' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.blocked, 'side_unknown');
});

test('no parties on file at all (brand-new listing) — side unknown is fine, nothing to protect', async () => {
  stubFetch({ documents: [], tx: NO_PARTIES_YET_TX });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'newlead@example.com' });
  assert.equal(result.ok, true);
});

test('GATE 1 — zero executed contracts on file refuses, even for the member\'s own client', async () => {
  stubFetch({
    documents: [{ id: 'doc-1', file_name: 'contract.pdf', executed_at: null }],
    tx: LISTING_SIDE_TX,
  });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'barry@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.blocked, 'no_executed_contract');
});

test('GATE 1 — two "executed" contract copies is ambiguous, refuses rather than guessing', async () => {
  stubFetch({
    documents: [
      { id: 'doc-1', file_name: 'contract-v1.pdf', executed_at: '2026-08-01T00:00:00Z' },
      { id: 'doc-2', file_name: 'contract-v2.pdf', executed_at: '2026-08-15T00:00:00Z' },
    ],
    tx: LISTING_SIDE_TX,
  });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'barry@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, 'ambiguous_contract');
});

test('no contract on file at all (pre-contract listing) does not block the member\'s own seller', async () => {
  stubFetch({ documents: [], tx: LISTING_SIDE_TX });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'barry@example.com' });
  assert.equal(result.ok, true);
});

test('transaction not found / not owned by this user — fails closed, not a silent pass', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: null });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'anyone@example.com' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.blocked, 'transaction_not_found');
});

test('an already-loaded tx row (passed by the caller) is reused, no transactions fetch', async () => {
  stubFetch({
    documents: oneExecutedContractDoc(),
    tx: null, // would 404 if the module re-fetched instead of reusing `tx`
    onFetch: (url) => {
      if (url.includes('/rest/v1/transactions')) throw new Error('must not re-fetch transactions — tx was provided');
    },
  });
  const result = await gateOutboundRecipient({ userId: USER, transactionId: TX_ID, email: 'buyercontact2@example.net', tx: LISTING_SIDE_TX });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, 'opposing_principal');
});

test('"just send it anyway" has no effect — the gate takes only userId/transactionId/email, never a conversational override flag', async () => {
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX });
  // Even if a caller tried to smuggle an override through extra fields, the
  // gate's signature does not read or honor one.
  const result = await gateOutboundRecipient({
    userId: USER,
    transactionId: TX_ID,
    email: 'buyercontact2@example.net',
    override: true,
    force: true,
    confirmed_by_member: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, 'opposing_principal');
});
