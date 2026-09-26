'use strict';

// api/_lib/docuseal-signing-verify.test.js
//
// Real, executed proof for the DocuSeal sandbox/dead-link gate added
// 2026-09-26 after Heath's sellers spent hours unable to sign a packet
// because the DocuSeal account was in Developer Sandbox mode and every API
// call along the way returned success anyway.
//
// The two fixture strings below are not synthetic guesses — SANDBOX_PAGE_TEXT
// is the real innerText captured live 2026-09-26 (Playwright, headless
// chromium) off an actual pending Nopalito seller's-disclosure submission on
// the real DocuSeal account, at the exact moment it was confirmed to be in
// sandbox mode. PRODUCTION_PAGE_TEXT is that SAME real capture with only the
// sandbox banner line removed — i.e. "what this exact account's signing page
// looks like once it is genuinely in Production," constructed from evidence,
// not invented from scratch. DEAD_LINK_PAGE_TEXT is the real innerText/raw
// response for an archived submission on the same account (200 OK, ~9KB
// generic app shell, none of the real signing UI) — proof that a 200 status
// code alone (what curl checked before this fix) says nothing about whether
// the document ever rendered.
//
// Run: node --test api/_lib/docuseal-signing-verify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateSigningPageText,
  verifySigningPageLive,
  SANDBOX_MARKERS,
  GENUINE_SIGNING_PAGE_MARKERS,
} = require('./docuseal-signing-verify');

const SANDBOX_PAGE_TEXT = `Enter screen reader mode
Developer Sandbox. Upgrade to start using in Production.
DocuSeal
23 Nopalito - Seller Disclosure Resend (e-sign)
DECLINE
DOWNLOAD
Enter screen reader mode
Seller 2 Signature (Jennifer)
Powered by DocuSeal - open source documents software
SIGN NOW
Decline`;

const PRODUCTION_PAGE_TEXT = `Enter screen reader mode
DocuSeal
23 Nopalito - Seller Disclosure Resend (e-sign)
DECLINE
DOWNLOAD
Enter screen reader mode
Seller 2 Signature (Jennifer)
Powered by DocuSeal - open source documents software
SIGN NOW
Decline`;

// Real captured innerText/body for an archived submission's signing link —
// 200 OK, generic DocuSeal marketing shell, no field content, no SIGN NOW /
// DOWNLOAD / DECLINE controls. This is what "curl -o /dev/null -w %{http_code}"
// called a healthy 200.
const DEAD_LINK_PAGE_TEXT = `DocuSeal
Open Source Document Signing
Sign in`;

test('sandbox banner text refuses the send, names the reason', () => {
  const result = evaluateSigningPageText(SANDBOX_PAGE_TEXT);
  assert.equal(result.ok, false);
  assert.equal(result.sandboxMode, true);
  assert.equal(result.reason, 'docuseal_sandbox_mode');
  assert.match(result.message, /Sandbox/);
  assert.match(result.message, /Production/);
});

test('real production-mode page (same content, sandbox banner gone) passes', () => {
  const result = evaluateSigningPageText(PRODUCTION_PAGE_TEXT);
  assert.equal(result.ok, true);
  assert.equal(result.sandboxMode, false);
  assert.equal(result.reason, null);
});

test('a dead/archived link (200 OK, generic shell) is refused as not genuine', () => {
  const result = evaluateSigningPageText(DEAD_LINK_PAGE_TEXT);
  assert.equal(result.ok, false);
  assert.equal(result.sandboxMode, false);
  assert.equal(result.reason, 'signing_page_not_genuine');
});

test('empty/null text is refused, never treated as a pass', () => {
  assert.equal(evaluateSigningPageText('').ok, false);
  assert.equal(evaluateSigningPageText(null).ok, false);
  assert.equal(evaluateSigningPageText(undefined).ok, false);
});

test('markers are the real, documented strings (regression guard against silent rewording)', () => {
  assert.deepEqual(SANDBOX_MARKERS, ['Developer Sandbox', 'Upgrade to start using in Production']);
  assert.deepEqual(GENUINE_SIGNING_PAGE_MARKERS, ['DOWNLOAD', 'DECLINE']);
});

// ---------------------------------------------------------------------------
// verifySigningPageLive — the full render -> evaluate flow, via an injected
// `render` so this proves the wiring without a real browser or network call.
// ---------------------------------------------------------------------------

test('verifySigningPageLive: sandbox render is refused end-to-end', async () => {
  const fakeRender = async () => ({ ok: true, text: SANDBOX_PAGE_TEXT });
  const result = await verifySigningPageLive('https://docuseal.com/s/fake-sandbox', { render: fakeRender });
  assert.equal(result.ok, false);
  assert.equal(result.sandboxMode, true);
});

test('verifySigningPageLive: production render passes end-to-end', async () => {
  const fakeRender = async () => ({ ok: true, text: PRODUCTION_PAGE_TEXT });
  const result = await verifySigningPageLive('https://docuseal.com/s/fake-production', { render: fakeRender });
  assert.equal(result.ok, true);
});

test('verifySigningPageLive: a render failure (network/timeout/crash) fails CLOSED, not open', async () => {
  const fakeRender = async () => ({ ok: false, text: null, error: 'net::ERR_TIMED_OUT' });
  const result = await verifySigningPageLive('https://docuseal.com/s/fake-timeout', { render: fakeRender });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'render_failed');
  assert.match(result.message, /ERR_TIMED_OUT/);
});

test('verifySigningPageLive: no URL at all is refused, never silently skipped as a pass', async () => {
  const fakeRender = async () => { throw new Error('render should never be called with no url'); };
  const result = await verifySigningPageLive(null, { render: fakeRender });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_url');
});

test('verifySigningPageLive: dead/archived link render is refused end-to-end', async () => {
  const fakeRender = async () => ({ ok: true, text: DEAD_LINK_PAGE_TEXT });
  const result = await verifySigningPageLive('https://docuseal.com/s/fake-archived', { render: fakeRender });
  assert.equal(result.ok, false);
  assert.equal(result.sandboxMode, false);
  assert.equal(result.reason, 'signing_page_not_genuine');
});
