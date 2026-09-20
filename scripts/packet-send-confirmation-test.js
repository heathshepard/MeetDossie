// Integration test for /api/send-compliance-packet.
// Proves the dangerous half: nothing reaches the mail provider without a
// valid confirmation token, and the opposing principal is unreachable.
//
// NO REAL EMAIL IS SENT. global.fetch is replaced entirely; any attempt to
// reach api.resend.com is recorded and answered locally. If the endpoint ever
// tried to send for real, resendCalls would be non-empty where we assert it is.

const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.RESEND_API_KEY = 'fake-resend-key';
process.env.PACKET_CONFIRM_SECRET = 'test-secret';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// --- stub auth (fails closed in real life; here we hand it a fixed user) ---
const authPath = require.resolve(path.join(ROOT, 'api/_middleware/auth.js'));
const realAuth = require(authPath);
require.cache[authPath].exports = {
  ...realAuth,
  verifySupabaseToken: async () => ({ userId: 'user-1', email: 'member@example.com' }),
};

// --- stub rate limit ---
const rlPath = require.resolve(path.join(ROOT, 'api/_middleware/rateLimit.js'));
const realRl = require(rlPath);
require.cache[rlPath].exports = {
  ...realRl,
  checkRateLimit: async () => true,
  clientIpFromReq: () => '127.0.0.1',
};

// --- fixtures ---
const LISTING_TX = {
  id: 'tx-1', property_address: '23 Nopalito', city_state_zip: 'Boerne, TX',
  role: 'listing', transaction_type: 'seller_listing', closing_date: '2026-10-15',
  seller_name: 'Linton', seller_email: 'seller@example.com',
  seller2_name: null, seller2_email: null,
  buyer_name: 'Christopher Bryan', buyer_email: 'chris.bryan@example.com',
  buyer2_name: 'Monica Bryan', buyer2_email: 'monica.bryan@example.com',
  other_agent_name: 'Craig Browning', other_agent_email_addr: 'craig@example.com',
  title_officer_email: 'title@example.com',
  sale_price: 999000, commission_rate: '5.5', option_fee: 500,
};
const PROFILE = {
  full_name: 'Heath Shepard', email: 'member@example.com',
  brokerage: 'KW', compliance_email: 'compliance@example.com',
};
const DOCS = [
  { id: 'd1', file_name: 'Contract.pdf', file_type: 'application/pdf', file_size: 1000, storage_path: 'p/d1.pdf' },
  { id: 'd2', file_name: 'PreApproval.pdf', file_type: 'application/pdf', file_size: 900, storage_path: 'p/d2.pdf' },
];

let resendCalls = [];
let logRows = [];

global.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.resend.com')) {
    resendCalls.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'resend-msg-123' }) };
  }
  if (u.includes('/storage/v1/object/')) {
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 fake').buffer };
  }
  if (u.includes('/rest/v1/profiles')) {
    return { ok: true, status: 200, json: async () => [PROFILE], text: async () => '' };
  }
  if (u.includes('/rest/v1/transactions')) {
    return { ok: true, status: 200, json: async () => [LISTING_TX], text: async () => '' };
  }
  if (u.includes('/rest/v1/documents')) {
    return { ok: true, status: 200, json: async () => DOCS, text: async () => '' };
  }
  if (u.includes('/rest/v1/compliance_sends')) {
    logRows.push(JSON.parse(init.body));
    return { ok: true, status: 201, json: async () => [], text: async () => '' };
  }
  return { ok: false, status: 404, text: async () => 'unmocked ' + u, json: async () => ({}) };
};

const handler = require(path.join(ROOT, 'api/send-compliance-packet.js'));

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
  // ---- 1. PREVIEW SENDS NOTHING ----
  resendCalls = []; logRows = [];
  const prev = await call({ transaction_id: 'tx-1', recipient_role: 'seller' });
  ok(prev.statusCode === 200, 'preview 200, got ' + prev.statusCode);
  ok(prev.payload.ok === true, 'preview ok');
  ok(resendCalls.length === 0, 'PREVIEW SENT NOTHING (resend calls: ' + resendCalls.length + ')');
  ok(prev.payload.requires_confirmation === true, 'preview demands confirmation');
  ok(typeof prev.payload.confirmation_token === 'string', 'preview issues a token');
  ok(prev.payload.recipients[0].email === 'seller@example.com', 'resolved the seller');
  ok(prev.payload.attachments.length === 2, 'both documents listed');
  ok(logRows.length === 0, 'preview logs nothing');

  const token = prev.payload.confirmation_token;
  const subject = prev.payload.subject;

  // ---- 2. SEND WITHOUT A TOKEN IS REFUSED ----
  resendCalls = [];
  const noTok = await call({ transaction_id: 'tx-1', recipient_role: 'seller', mode: 'send' });
  ok(noTok.statusCode === 409, 'send w/o token = 409, got ' + noTok.statusCode);
  ok(resendCalls.length === 0, 'NO EMAIL without a token');
  ok(noTok.payload.needs_confirmation === true, 'flagged needs_confirmation');

  // ---- 3. FORGED TOKEN IS REFUSED ----
  resendCalls = [];
  const forged = await call({ transaction_id: 'tx-1', recipient_role: 'seller', mode: 'send', confirmation_token: 'a.b.c' });
  ok(forged.statusCode === 409, 'forged token refused');
  ok(resendCalls.length === 0, 'NO EMAIL with a forged token');

  // ---- 4. TOKEN BOUND TO THE PACKET: changing the recipient invalidates it ----
  resendCalls = [];
  const swapped = await call({
    transaction_id: 'tx-1', recipient_role: 'title', mode: 'send',
    subject, confirmation_token: token,
  });
  ok(swapped.statusCode === 409, 'recipient swap refused, got ' + swapped.statusCode);
  ok(swapped.payload.reason === 'packet_changed', 'reported as packet_changed');
  ok(resendCalls.length === 0, 'NO EMAIL when the packet changed after approval');

  // ---- 5. OPPOSING PRINCIPAL IS UNREACHABLE ----
  resendCalls = [];
  const buyer = await call({ transaction_id: 'tx-1', recipient_role: 'buyer' });
  ok(buyer.statusCode === 403, "buyer refused on a listing, got " + buyer.statusCode);
  ok(buyer.payload.blocked === 'opposing_principal', 'blocked as opposing_principal');
  ok(/agent/.test(buyer.payload.error), 'error redirects through their agent');
  ok(resendCalls.length === 0, "NO EMAIL to the other side's client");

  // hand-typed address for the buyer is refused too
  const typed = await call({ transaction_id: 'tx-1', recipient_role: 'title', recipient_email: 'monica.bryan@example.com' });
  ok(typed.statusCode === 403, 'typed buyer address refused, got ' + typed.statusCode);
  ok(resendCalls.length === 0, 'NO EMAIL via a hand-typed opposing address');

  // ---- 6. DRY RUN NEVER CALLS THE PROVIDER ----
  resendCalls = []; logRows = [];
  const p2 = await call({ transaction_id: 'tx-1', recipient_role: 'seller' });
  const dry = await call({
    transaction_id: 'tx-1', recipient_role: 'seller', mode: 'send',
    subject: p2.payload.subject, confirmation_token: p2.payload.confirmation_token, dry_run: true,
  });
  ok(dry.statusCode === 200, 'dry run 200, got ' + dry.statusCode);
  ok(dry.payload.dry_run === true && dry.payload.sent === false, 'dry run reports not sent');
  ok(resendCalls.length === 0, 'DRY RUN CALLED NO MAIL PROVIDER');
  ok(logRows.length === 1 && logRows[0][0].dry_run === true, 'dry run logged as dry_run');

  // ---- 7. THE HAPPY PATH ACTUALLY SENDS, AND LOGS A REAL MESSAGE ID ----
  resendCalls = []; logRows = [];
  const p3 = await call({ transaction_id: 'tx-1', recipient_role: 'seller' });
  const sent = await call({
    transaction_id: 'tx-1', recipient_role: 'seller', mode: 'send',
    subject: p3.payload.subject, confirmation_token: p3.payload.confirmation_token,
  });
  ok(sent.statusCode === 200, 'confirmed send 200, got ' + sent.statusCode + ' ' + JSON.stringify(sent.payload));
  ok(sent.payload.sent === true, 'reports sent');
  ok(resendCalls.length === 1, 'exactly one provider call');
  ok(resendCalls[0].to[0] === 'seller@example.com', 'went to the seller');
  ok(sent.payload.resend_message_id === 'resend-msg-123', 'real provider id returned');
  ok(logRows.length === 1 && logRows[0][0].resend_message_id === 'resend-msg-123', 'logged with the real id');
  // BCC must be the member, never Heath, on a party send (multi-tenant leak).
  ok(!JSON.stringify(resendCalls[0].bcc || []).includes('heath@meetdossie.com'), 'does NOT bcc Heath on a party send');
  ok((resendCalls[0].bcc || []).includes('member@example.com'), 'bccs the member');

  // ---- 8. A TOKEN IS SINGLE-PACKET, NOT SINGLE-USE-PROOF: net sheet changes it ----
  resendCalls = [];
  const withNs = await call({ transaction_id: 'tx-1', recipient_role: 'seller', net_sheet: { figures: {} } });
  ok(withNs.payload.attachments.includes('Sellers-Net-Sheet-ESTIMATE.html'), 'net sheet attached in preview');
  ok(withNs.payload.net_sheet.has_unknowns === true, 'net sheet reports unknowns');
  ok(withNs.payload.confirmation_token !== token, 'different packet => different token');
  // the old token must not authorise the net-sheet packet
  const cross = await call({
    transaction_id: 'tx-1', recipient_role: 'seller', mode: 'send',
    net_sheet: { figures: {} }, subject: withNs.payload.subject, confirmation_token: token,
  });
  ok(cross.statusCode === 409, 'old token cannot authorise a changed packet');
  ok(resendCalls.length === 0, 'NO EMAIL on cross-token reuse');

  // ---- 9. compliance default preserved (backward compatibility) ----
  const compat = await call({ transaction_id: 'tx-1' });
  ok(compat.payload.recipients[0].email === 'compliance@example.com', 'defaults to compliance as before');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('TOTAL REAL EMAILS SENT DURING TESTS: 0 (fetch was fully mocked)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW:', e); process.exit(1); });
