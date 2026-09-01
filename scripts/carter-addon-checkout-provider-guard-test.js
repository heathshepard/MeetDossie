#!/usr/bin/env node
// Integration test for the checkout-time mail-provider guard added to
// api/create-addon-checkout-session.js 2026-09-01
// (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH) — the fix for "a customer can buy
// Email Integration and only discover afterward their mailbox provider
// isn't supported."
//
// Runs the REAL handler (require'd directly, same pattern as
// api/scan-contract.test.mjs) against a mocked fetch (Supabase auth +
// subscriptions lookup) and a mocked dns.resolveMx (provider detection) and
// a mocked `stripe` module (so no real Stripe call happens). Run with:
//   node scripts/carter-addon-checkout-provider-guard-test.js

'use strict';

process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.ADDON_EMAIL_INTEGRATION_PRICE_ID = 'price_fake';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
}

// Fake `stripe` module — checkout.sessions.create records whether it was
// ever called, which is the real assertion: a blocked purchase must never
// reach Stripe.
let stripeSessionCreateCalls = 0;
const stripeModulePath = require.resolve('stripe');
require.cache[stripeModulePath] = {
  id: stripeModulePath,
  filename: stripeModulePath,
  loaded: true,
  exports: function FakeStripe() {
    return {
      checkout: {
        sessions: {
          create: async (params) => {
            stripeSessionCreateCalls++;
            return { url: 'https://checkout.stripe.com/fake-session', id: 'cs_fake' };
          },
        },
      },
    };
  },
};

let currentSubRow = null;
let currentUser = { id: 'user-abc', email: 'heath@kw.com' };

const originalFetch = global.fetch;
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/auth/v1/user')) return jsonResponse(200, currentUser);
  if (u.includes('/rest/v1/profiles')) return jsonResponse(200, {}); // touchLastSeen fire-and-forget
  if (u.includes('/rest/v1/subscriptions')) return jsonResponse(200, currentSubRow ? [currentSubRow] : []);
  return jsonResponse(200, {});
};

const dns = require('node:dns');
const originalResolveMx = dns.promises.resolveMx;
dns.promises.resolveMx = async (domain) => {
  if (domain === 'kw.com') return [{ exchange: 'aspmx.l.google.com', priority: 1 }];
  if (domain === 'phyllisbrowning.com') return [{ exchange: 'phyllisbrowning-com.mail.protection.outlook.com', priority: 10 }];
  if (domain === 'somecustomdomain.example') return [{ exchange: 'mx1.somehost.example', priority: 10 }];
  return [];
};

const handlerPath = require.resolve('../api/create-addon-checkout-session');
// The handler module reads MICROSOFT_CLIENT_ID/SECRET into top-level consts
// at require time, so each case that flips those env vars needs a FRESH
// require (clearing the module cache) to pick up the new value — matches
// how a real redeploy would pick up a newly-set Vercel env var.
function freshHandler() {
  delete require.cache[handlerPath];
  return require('../api/create-addon-checkout-session');
}

function makeReqRes() {
  const req = { method: 'POST', headers: { authorization: 'Bearer fake-user-jwt' }, query: {} };
  const res = {
    statusCode: 200,
    body: undefined,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return { req, res };
}

async function main() {
  // Case 1: Google-hosted email (kw.com), no MICROSOFT env set, no addon yet -> allowed through to Stripe.
  currentUser = { id: 'user-1', email: 'heath@kw.com' };
  currentSubRow = { plan: 'solo', status: 'active', stripe_customer_id: 'cus_1', email_integration_enabled: false };
  stripeSessionCreateCalls = 0;
  {
    const { req, res } = makeReqRes();
    await freshHandler()(req, res);
    check('google-domain buyer: 200 ok', res.statusCode === 200, res.body);
    check('google-domain buyer: reaches Stripe checkout', stripeSessionCreateCalls === 1, stripeSessionCreateCalls);
    check('google-domain buyer: gets a checkout url', res.body && res.body.ok && !!res.body.url, res.body);
  }

  // Case 2: Microsoft-hosted email (phyllisbrowning.com), MICROSOFT_CLIENT_ID/SECRET NOT set -> blocked before Stripe.
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;
  currentUser = { id: 'user-2', email: 'tgill@phyllisbrowning.com' };
  currentSubRow = { plan: 'solo', status: 'active', stripe_customer_id: 'cus_2', email_integration_enabled: false };
  stripeSessionCreateCalls = 0;
  {
    const { req, res } = makeReqRes();
    await freshHandler()(req, res);
    check('microsoft buyer, MS not configured: 400 blocked', res.statusCode === 400, res.body);
    check('microsoft buyer, MS not configured: never reaches Stripe', stripeSessionCreateCalls === 0, stripeSessionCreateCalls);
    check('microsoft buyer, MS not configured: error message mentions Outlook/Microsoft', /Outlook|Microsoft/i.test((res.body && res.body.error) || ''), res.body);
  }

  // Case 3: Microsoft-hosted email, MICROSOFT_CLIENT_ID/SECRET SET (post-Azure-registration) -> allowed through.
  process.env.MICROSOFT_CLIENT_ID = 'fake-ms-client-id';
  process.env.MICROSOFT_CLIENT_SECRET = 'fake-ms-client-secret';
  stripeSessionCreateCalls = 0;
  {
    const { req, res } = makeReqRes();
    await freshHandler()(req, res);
    check('microsoft buyer, MS configured: 200 ok', res.statusCode === 200, res.body);
    check('microsoft buyer, MS configured: reaches Stripe checkout', stripeSessionCreateCalls === 1, stripeSessionCreateCalls);
  }
  delete process.env.MICROSOFT_CLIENT_ID;
  delete process.env.MICROSOFT_CLIENT_SECRET;

  // Case 4: unrecognised provider (neither Google nor Microsoft MX) -> blocked before Stripe.
  currentUser = { id: 'user-3', email: 'someone@somecustomdomain.example' };
  currentSubRow = { plan: 'solo', status: 'active', stripe_customer_id: 'cus_3', email_integration_enabled: false };
  stripeSessionCreateCalls = 0;
  {
    const { req, res } = makeReqRes();
    await freshHandler()(req, res);
    check('unsupported-provider buyer: 400 blocked', res.statusCode === 400, res.body);
    check('unsupported-provider buyer: never reaches Stripe', stripeSessionCreateCalls === 0, stripeSessionCreateCalls);
  }

  // Case 5: already-enabled guard still fires BEFORE the provider guard (existing behavior preserved).
  currentUser = { id: 'user-4', email: 'someone@somecustomdomain.example' };
  currentSubRow = { plan: 'solo', status: 'active', stripe_customer_id: 'cus_4', email_integration_enabled: true };
  stripeSessionCreateCalls = 0;
  {
    const { req, res } = makeReqRes();
    await freshHandler()(req, res);
    check('already-enabled buyer: 400 blocked for the RIGHT reason', res.statusCode === 400 && /already active/i.test((res.body && res.body.error) || ''), res.body);
  }

  dns.promises.resolveMx = originalResolveMx;
  global.fetch = originalFetch;

  console.log(`\n${fail === 0 ? 'ALL CHECKOUT PROVIDER GUARD TESTS PASSED' : 'CHECKOUT PROVIDER GUARD TESTS FAILED'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exit(1);
});
