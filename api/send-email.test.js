'use strict';

// api/send-email.test.js
//
// Run: node --test api/send-email.test.js
//
// Gate 2 (docs/DOSSIE-TRANSACTION-AGENT-SPEC.md §3) — api/send-email.js is
// the real network endpoint behind the chat `send_email` tool, which until
// this change had ZERO check on `to_email`. These tests call the REAL
// exported handler (no mocking of the gate itself) and prove:
//   - a represented opposing-side recipient is refused BEFORE Resend is
//     ever called — the refusal is server-side, not something a model's
//     phrasing or a "just send it anyway" follow-up can talk around, since
//     this endpoint has no conversation to talk to at all.
//   - a legitimate send to the member's own client still goes through.
//
// Stubs global.fetch for every downstream call (Supabase auth/documents/
// transactions/email_queue, Resend) — never touches a real service.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.RESEND_API_KEY = 'test-resend-key';

const handler = require('./send-email.js');

const USER = '00000000-1111-4111-8111-000000000001';
const TX_ID = '00000000-2222-4222-8222-000000000002';

const LISTING_SIDE_TX = {
  id: TX_ID,
  role: 'listing',
  seller_name: 'Barry Whyte',
  seller_email: 'barry@example.com',
  buyer_name: 'Christopher Bryan',
  buyer_email: 'buyercontact2@example.net',
  buyer2_email: null,
  seller2_email: null,
  parties: {},
};

function oneExecutedContractDoc() {
  return [{ id: 'doc-1', file_name: 'contract.pdf', executed_at: '2026-09-01T00:00:00Z' }];
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  return res;
}

function stubFetch({ documents, tx, resendCalled }) {
  global.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.pathname === '/auth/v1/user') {
      return { ok: true, status: 200, json: async () => ({ id: USER, email: 'heath.shepard@kw.com' }) };
    }
    if (u.pathname.includes('/rest/v1/documents')) {
      return { ok: true, json: async () => documents };
    }
    if (u.pathname.includes('/rest/v1/transactions')) {
      return { ok: true, json: async () => (tx ? [tx] : []) };
    }
    if (u.pathname.includes('/rest/v1/email_queue')) {
      return { ok: true, json: async () => ({}) };
    }
    if (u.hostname === 'api.resend.com') {
      if (resendCalled) resendCalled.hit = true;
      return { ok: true, json: async () => ({ id: 'resend-test-id' }) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

function req(body) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-jwt' },
    body,
  };
}

test('REFUSES an email to the other side\'s represented client — Resend is never called', async () => {
  const resendCalled = {};
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX, resendCalled });

  const res = makeRes();
  await handler(req({
    to: 'buyercontact2@example.net', // the buyer — the OTHER side's client on this listing-side dossier
    subject: 'Your contract',
    body: 'Here is the fully executed contract.',
    transactionId: TX_ID,
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.blocked, 'opposing_principal');
  assert.match(res.body.error, /other side's client/i);
  assert.equal(resendCalled.hit, undefined, 'Resend must never be called when the gate refuses');
});

test('"just send it anyway" has no server-side effect — resending the same request still refuses', async () => {
  const resendCalled = {};
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX, resendCalled });

  for (let i = 0; i < 2; i += 1) {
    const res = makeRes();
    await handler(req({
      to: 'buyercontact2@example.net',
      subject: 'Your contract',
      body: 'Sending this now regardless.',
      transactionId: TX_ID,
    }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.blocked, 'opposing_principal');
  }
  assert.equal(resendCalled.hit, undefined);
});

test('ALLOWS a legitimate send to the member\'s own client', async () => {
  const resendCalled = {};
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX, resendCalled });

  const res = makeRes();
  await handler(req({
    to: 'barry@example.com', // the seller — the member's own client on this listing-side dossier
    subject: 'Update on your sale',
    body: 'Quick update on where things stand.',
    transactionId: TX_ID,
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(resendCalled.hit, true, 'Resend should be called for a legitimate send');
});

test('ALLOWS a send with no transactionId at all (no deal context to protect)', async () => {
  const resendCalled = {};
  stubFetch({ documents: [], tx: null, resendCalled });

  const res = makeRes();
  await handler(req({
    to: 'somelead@example.com',
    subject: 'Thanks for reaching out',
    body: 'Following up on your inquiry.',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(resendCalled.hit, true);
});

test('AMBIGUOUS IDENTITY fails closed — Gate 1 unexecuted contract blocks even the member\'s own client', async () => {
  const resendCalled = {};
  stubFetch({
    documents: [{ id: 'doc-1', file_name: 'contract.pdf', executed_at: null }],
    tx: LISTING_SIDE_TX,
    resendCalled,
  });

  const res = makeRes();
  await handler(req({
    to: 'barry@example.com',
    subject: 'Update',
    body: 'Body text.',
    transactionId: TX_ID,
  }), res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.blocked, 'no_executed_contract');
  assert.equal(resendCalled.hit, undefined);
});

test('multiple recipients — EVERY address is gated before ANYTHING is sent', async () => {
  const resendCalled = {};
  stubFetch({ documents: oneExecutedContractDoc(), tx: LISTING_SIDE_TX, resendCalled });

  const res = makeRes();
  await handler(req({
    // First address is fine (own client), second is the opposing principal —
    // the whole send must refuse, not partially send to the first address.
    to: ['barry@example.com', 'buyercontact2@example.net'],
    subject: 'Update',
    body: 'Body text.',
    transactionId: TX_ID,
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.blocked, 'opposing_principal');
  assert.equal(resendCalled.hit, undefined, 'nothing should send when any recipient fails the gate');
});
