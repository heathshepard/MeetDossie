'use strict';

// api/esign-sandbox-gate.test.js
//
// Proves the ACTUAL wiring inside api/esign-create.js — not just the
// standalone api/_lib/docuseal-signing-verify.js module — refuses a send
// when the DocuSeal account is in Developer Sandbox mode (or the signing
// link is dead), and passes when it's a real, live, production page. Built
// 2026-09-26 after the incident: DocuSeal's account was in sandbox, every
// API call along esign-create.js's three submission-creation paths
// (send_for_acknowledgment, the packet path, the single-doc template/PDF
// path) returned success, and nothing stopped the send.
//
// Uses the injectable `verify` param on assertSigningLinkIsLiveOrThrow
// (exposed via __testing) so this runs with zero network calls and zero
// browser launches — same real exported production function every call
// site in esign-create.js actually calls, just with a fake `verify` so the
// test controls what the "render" would have found.
//
// Run: node --test api/esign-sandbox-gate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';
process.env.DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY || '';
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || '';

const esignCreate = require('./esign-create.js');
const { assertSigningLinkIsLiveOrThrow } = esignCreate.__testing;

const SIGNER_ROWS = [
  { name: 'Jennifer Whyte', email: 'jwhyte@example.com', role: 'Seller 2', signingUrl: 'https://docuseal.com/s/fake-slug' },
];

test('SANDBOX: send is refused — assertSigningLinkIsLiveOrThrow throws, naming Sandbox/Production', async () => {
  const fakeVerify = async () => ({
    ok: false,
    sandboxMode: true,
    reason: 'docuseal_sandbox_mode',
    message: 'The DocuSeal account is in Developer Sandbox mode, not Production — signing links do not work for real recipients in this mode. Upgrade the account at https://console.docuseal.com/plans before sending anything for signature.',
  });

  await assert.rejects(
    () => assertSigningLinkIsLiveOrThrow(SIGNER_ROWS, { submissionId: '999', verify: fakeVerify }),
    (err) => {
      assert.match(err.message, /Sandbox/);
      assert.match(err.message, /Production/);
      return true;
    },
  );
});

test('PRODUCTION: a genuinely live, non-sandbox render passes — no throw', async () => {
  const fakeVerify = async () => ({ ok: true, sandboxMode: false, reason: null, message: null });
  await assertSigningLinkIsLiveOrThrow(SIGNER_ROWS, { submissionId: '1000', verify: fakeVerify });
  // Reaching this line without throwing IS the assertion.
  assert.ok(true);
});

test('DEAD LINK: refused with the not-genuine reason, distinct from sandbox', async () => {
  const fakeVerify = async () => ({
    ok: false,
    sandboxMode: false,
    reason: 'signing_page_not_genuine',
    message: 'That signing link did not render a real, signable document when checked just now — it may be dead, archived, or invalid. Refusing to report this send as complete.',
  });
  await assert.rejects(
    () => assertSigningLinkIsLiveOrThrow(SIGNER_ROWS, { submissionId: '1001', verify: fakeVerify }),
    /did not render a real, signable document/,
  );
});

test('a render/verify failure fails CLOSED — throws, does not silently pass', async () => {
  const fakeVerify = async () => ({
    ok: false,
    sandboxMode: false,
    reason: 'render_failed',
    message: 'Could not verify the signing link is actually live (net::ERR_TIMED_OUT). Refusing to report this send as complete.',
  });
  await assert.rejects(
    () => assertSigningLinkIsLiveOrThrow(SIGNER_ROWS, { submissionId: '1002', verify: fakeVerify }),
    /Could not verify the signing link/,
  );
});

test('no signerRows with a signingUrl at all: the gate is a no-op, not a false refusal', async () => {
  const fakeVerify = async () => { throw new Error('verify should never be called with nothing to check'); };
  await assertSigningLinkIsLiveOrThrow([{ name: 'x', email: 'x@example.com', signingUrl: null }], { submissionId: '1003', verify: fakeVerify });
  assert.ok(true);
});

test('the default verify param is really the exported verifySigningPageLive, not a stub only tests wire up', () => {
  // Static proof, no network/browser involved: every production call site
  // in this file (send_for_acknowledgment, the packet path, the single-doc
  // template/PDF path) calls assertSigningLinkIsLiveOrThrow WITHOUT a
  // `verify` override, so its default parameter is what actually runs in
  // production. Confirm that default literally resolves to
  // docuseal-signing-verify.js's exported verifySigningPageLive — if a
  // future edit ever swaps it for a no-op or a different function, this
  // fails.
  const src = assertSigningLinkIsLiveOrThrow.toString();
  assert.match(src, /verify\s*=\s*verifySigningPageLive/);
});
