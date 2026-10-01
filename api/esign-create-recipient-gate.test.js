'use strict';

// api/esign-create-recipient-gate.test.js
//
// Run: node --test api/esign-create-recipient-gate.test.js
//
// Gate 2 + Gate 3 (docs/DOSSIE-TRANSACTION-AGENT-SPEC.md §3) — api/esign-
// create.js is the real network endpoint behind every e-sign invite
// (chat's send_for_signature, via api/esign-packet-send.js; the scanned-
// disclosure acknowledgment action). Until this change it had ZERO check
// on signer identity. These tests call the REAL exported handler and prove
// a signer resolving to the other side's represented principal is refused
// BEFORE DocuSeal is ever reached — "never push an e-sign invite into
// another brokerage's workflow."
//
// Stubs global.fetch for every downstream call. DOCUSEAL/RESEND calls throw
// if reached at all in the refusal tests — proof nothing was created.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.DOCUSEAL_API_KEY = 'test-docuseal-key';
process.env.RESEND_API_KEY = 'test-resend-key';

const handler = require('./esign-create.js');

const USER = '00000000-1111-4111-8111-000000000001';
const TX_ID = '00000000-2222-4222-8222-000000000002';
const DOC_ID = '00000000-3333-4333-8333-000000000003';

const LISTING_SIDE_TX = {
  id: TX_ID,
  role: 'listing',
  seller_name: 'Barry Whyte',
  seller_email: 'barry@example.com',
  buyer_name: 'Christopher Bryan',
  buyer_email: 'cwb03@hotmail.com',
  buyer2_email: null,
  seller2_email: null,
  parties: {},
  property_address: '23 Nopalito',
};

function executedContractDoc() {
  return { id: 'contract-doc-1', file_name: 'contract.pdf', executed_at: '2026-09-01T00:00:00Z' };
}

function sellersDisclosureDoc() {
  return {
    id: DOC_ID,
    user_id: USER,
    transaction_id: TX_ID,
    storage_path: `${USER}/${TX_ID}/sellers-disclosure.pdf`,
    file_name: "Seller's Disclosure Notice.pdf",
    document_type: 'uploaded_scan',
    form_type: null,
    status: 'final',
    form_template_id: null,
  };
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

// Routes every downstream fetch this handler could reach for the
// send_for_acknowledgment branch. docuseal.com / api.resend.com calls THROW
// — they must never be reached when the recipient gate refuses.
function rateLimitOkResponse() {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ([]) };
}

function stubFetch({ docusealCalled, resendCalled } = {}) {
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/auth/v1/user') {
      return { ok: true, status: 200, json: async () => ({ id: USER, email: 'heath.shepard@kw.com' }) };
    }
    if (u.pathname.includes('/rest/v1/rate_limits')) {
      return rateLimitOkResponse();
    }
    if (u.pathname.includes('/rest/v1/profiles')) {
      return { ok: true, json: async () => ([]) };
    }
    if (u.pathname.includes('/rest/v1/documents')) {
      // Gate 1's own query (document_type=eq.trec-20-17) and getDocumentRow
      // (id=eq.<DOC_ID>) share this path — distinguish by query string.
      if (u.searchParams.get('document_type') === 'eq.trec-20-17') {
        return { ok: true, json: async () => [executedContractDoc()] };
      }
      return { ok: true, json: async () => [sellersDisclosureDoc()] };
    }
    if (u.pathname.includes('/rest/v1/transactions')) {
      return { ok: true, json: async () => [LISTING_SIDE_TX] };
    }
    if (u.hostname.includes('docuseal.com')) {
      if (docusealCalled) docusealCalled.hit = true;
      throw new Error(`DocuSeal must not be reached when the gate refuses: ${url}`);
    }
    if (u.hostname === 'api.resend.com') {
      if (resendCalled) resendCalled.hit = true;
      throw new Error(`Resend must not be reached when the gate refuses: ${url}`);
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

test('REFUSES send_for_acknowledgment to the other side\'s buyer — DocuSeal is never reached', async () => {
  const docusealCalled = {};
  stubFetch({ docusealCalled });

  const res = makeRes();
  await handler(req({
    action: 'send_for_acknowledgment',
    document_id: DOC_ID,
    transaction_id: TX_ID,
    // This dossier's member represents the SELLER (listing side) — the
    // buyer is the other side's represented client, never a direct signer.
    buyer_email: 'cwb03@hotmail.com',
    buyer_name: 'Christopher Bryan',
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.blocked, 'opposing_principal');
  assert.equal(docusealCalled.hit, undefined, 'DocuSeal must never be reached when the gate refuses');
});

test('REFUSES even when a second buyer slot is the one that matches the opposing principal', async () => {
  const docusealCalled = {};
  stubFetch({ docusealCalled });

  const res = makeRes();
  await handler(req({
    action: 'send_for_acknowledgment',
    document_id: DOC_ID,
    transaction_id: TX_ID,
    buyer_email: 'unrelated@example.com', // not on file at all — not itself a match
    buyer_name: 'Someone Else',
    buyer_email_2: 'cwb03@hotmail.com', // IS the deal's actual buyer — the other side's client
    buyer_name_2: 'Christopher Bryan',
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.blocked, 'opposing_principal');
  assert.equal(docusealCalled.hit, undefined);
});

test('GATE 1 fails closed — contract on file is not confirmed executed, refuses before DocuSeal', async () => {
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/auth/v1/user') {
      return { ok: true, status: 200, json: async () => ({ id: USER, email: 'heath.shepard@kw.com' }) };
    }
    if (u.pathname.includes('/rest/v1/rate_limits')) {
      return rateLimitOkResponse();
    }
    if (u.pathname.includes('/rest/v1/profiles')) {
      return { ok: true, json: async () => ([]) };
    }
    if (u.pathname.includes('/rest/v1/documents')) {
      if (u.searchParams.get('document_type') === 'eq.trec-20-17') {
        return { ok: true, json: async () => [{ id: 'contract-doc-1', file_name: 'contract.pdf', executed_at: null }] };
      }
      return { ok: true, json: async () => [sellersDisclosureDoc()] };
    }
    if (u.pathname.includes('/rest/v1/transactions')) {
      return { ok: true, json: async () => [LISTING_SIDE_TX] };
    }
    throw new Error(`DocuSeal/Resend must not be reached: ${url}`);
  };

  const res = makeRes();
  await handler(req({
    action: 'send_for_acknowledgment',
    document_id: DOC_ID,
    transaction_id: TX_ID,
    // Even the member's OWN seller would be blocked here — the contract
    // itself is not confirmed executed, so nothing on this transaction is
    // trusted for identity purposes yet.
    buyer_email: 'barry@example.com',
    buyer_name: 'Barry Whyte',
  }), res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.body.blocked, 'no_executed_contract');
});

// ---------------------------------------------------------------------------
// Single-document path (documentId + signers[]) — the other wiring point,
// used e.g. by a direct documentId send outside the acknowledgment action.
// Same shared gate, different call site: proves the HTTP-level wiring, not
// just the function in isolation (already covered by transaction-send-
// gate.test.js).
// ---------------------------------------------------------------------------

function hoaAddendumDoc() {
  return {
    id: DOC_ID,
    user_id: USER,
    transaction_id: TX_ID,
    storage_path: `${USER}/${TX_ID}/hoa-addendum.pdf`,
    file_name: 'HOA Addendum.pdf',
    document_type: 'hoa_addendum',
    form_type: null,
    status: 'final',
    form_template_id: null,
  };
}

test('single-document path (documentId + signers[]) REFUSES a signer who is the other side\'s client', async () => {
  const docusealCalled = {};
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/auth/v1/user') {
      return { ok: true, status: 200, json: async () => ({ id: USER, email: 'heath.shepard@kw.com' }) };
    }
    if (u.pathname.includes('/rest/v1/rate_limits')) return rateLimitOkResponse();
    if (u.pathname.includes('/rest/v1/profiles')) return { ok: true, json: async () => ([]) };
    if (u.pathname.includes('/rest/v1/documents')) {
      if (u.searchParams.get('document_type') === 'eq.trec-20-17') {
        return { ok: true, json: async () => [executedContractDoc()] };
      }
      return { ok: true, json: async () => [hoaAddendumDoc()] };
    }
    if (u.pathname.includes('/rest/v1/transactions')) {
      return { ok: true, json: async () => [LISTING_SIDE_TX] };
    }
    if (u.hostname.includes('docuseal.com')) {
      docusealCalled.hit = true;
      throw new Error(`DocuSeal must not be reached when the gate refuses: ${url}`);
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };

  const res = makeRes();
  await handler(req({
    documentId: DOC_ID,
    // The buyer is the OTHER side's represented client on this listing-side
    // dossier — never a direct e-sign signer.
    signers: [{ name: 'Christopher Bryan', email: 'cwb03@hotmail.com', role: 'Buyer 1' }],
  }), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.blocked, 'opposing_principal');
  assert.equal(docusealCalled.hit, undefined, 'DocuSeal must never be reached when the gate refuses');
});
