process.env.PACKET_CONFIRM_SECRET = 'test-secret-not-a-real-key';
const P = require('../api/_lib/packet-recipients');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('FAIL:', m); } };

// A listing-side deal: Heath represents the sellers; the Corlisses are the buyers.
const listing = {
  role: 'listing', transaction_type: 'seller_listing',
  seller_name: 'Hale', seller_email: 'seller@example.com',
  seller2_name: 'Hale Two', seller2_email: 'seller2@example.com',
  buyer_name: 'Nathan Corliss', buyer_email: 'nathan.corliss@example.com',
  buyer2_name: 'Priya Corliss', buyer2_email: 'priya.corliss@example.com',
  other_agent_name: 'Dana Reed', other_agent_email_addr: 'dana.reed@example.com',
  title_officer_name: 'Title Officer', title_officer_email: 'title@example.com',
};
const buyerSide = {
  role: 'buyer', transaction_type: 'buyer_purchase',
  buyer_name: 'Nadia', buyer_email: 'nadia@example.com',
  seller_name: 'Other Seller', seller_email: 'otherseller@example.com',
  listing_agent_name: 'LA', listing_agent_email_addr: 'la@example.com',
};
const profile = { full_name: 'Heath Shepard', email: 'heath@example.com', brokerage: 'KW', compliance_email: 'compliance@example.com' };

// --- own client is reachable ---
const r1 = P.resolveRoleRecipients({ tx: listing, profile, role: 'seller' });
ok(r1.ok, 'listing side CAN email its own sellers');
ok(r1.recipients.length === 2, 'both sellers resolved, got ' + (r1.recipients || []).length);

// --- THE CRITICAL GUARD: other side's client is NOT reachable ---
const r2 = P.resolveRoleRecipients({ tx: listing, profile, role: 'buyer' });
ok(!r2.ok, 'listing side CANNOT email the buyer');
ok(r2.blocked === 'opposing_principal', 'blocked reason is opposing_principal');
ok(/buyer's agent/.test(r2.error), 'error redirects to their agent: ' + r2.error);

const r3 = P.resolveRoleRecipients({ tx: buyerSide, profile, role: 'seller' });
ok(!r3.ok, 'buyer side CANNOT email the seller');
ok(r3.blocked === 'opposing_principal', 'buyer-side block reason');

// --- hand-typed address cannot smuggle the opposing principal through ---
const g1 = P.assertNotOpposingPrincipal({ tx: listing, email: 'nathan.corliss@example.com' });
ok(!g1.ok, 'typed buyer address refused on a listing');
const g2 = P.assertNotOpposingPrincipal({ tx: listing, email: 'PRIYA.CORLISS@EXAMPLE.COM' });
ok(!g2.ok, 'case-insensitive match still refused');
const g3 = P.assertNotOpposingPrincipal({ tx: listing, email: 'dana.reed@example.com' });
ok(g3.ok, "cooperating agent's own address is allowed");
const g4 = P.assertNotOpposingPrincipal({ tx: buyerSide, email: 'otherseller@example.com' });
ok(!g4.ok, 'typed seller address refused on a purchase');

// --- the other side's AGENT is always fine ---
ok(P.resolveRoleRecipients({ tx: listing, profile, role: 'other_agent' }).ok, 'cooperating agent reachable');
ok(P.resolveRoleRecipients({ tx: buyerSide, profile, role: 'listing_agent' }).ok, 'listing agent reachable from buyer side');
ok(P.resolveRoleRecipients({ tx: listing, profile, role: 'title' }).ok, 'title reachable');
ok(P.resolveRoleRecipients({ tx: listing, profile, role: 'compliance' }).ok, 'compliance reachable');

// --- unknown side refuses to email a principal at all ---
const noSide = { ...listing, role: null, transaction_type: null };
const r4 = P.resolveRoleRecipients({ tx: noSide, profile, role: 'seller' });
ok(!r4.ok, 'no declared side => refuses to email a client');

// --- missing address is a clear error, not a silent skip ---
const r5 = P.resolveRoleRecipients({ tx: { ...listing, title_officer_email: null }, profile, role: 'title' });
ok(!r5.ok && /don't have an email/.test(r5.error), 'missing address reported');

// --- confirmation tokens ---
const parts = {
  userId: 'u1', transactionId: 't1',
  recipients: [{ email: 'seller@example.com' }],
  subject: 'Docs', documentIds: ['d1', 'd2'],
};
const tok = P.issueConfirmationToken(parts);
ok(P.verifyConfirmationToken(tok, parts).ok, 'token verifies for the exact packet');

// order of recipients/docs must not matter
const reordered = { ...parts, documentIds: ['d2', 'd1'] };
ok(P.verifyConfirmationToken(tok, reordered).ok, 'doc order does not invalidate');

// THE POINT OF THE TOKEN: any change to the packet invalidates it.
ok(P.verifyConfirmationToken(tok, { ...parts, recipients: [{ email: 'someone.else@example.com' }] }).reason === 'packet_changed', 'recipient swap invalidates');
ok(P.verifyConfirmationToken(tok, { ...parts, subject: 'Different' }).reason === 'packet_changed', 'subject change invalidates');
ok(P.verifyConfirmationToken(tok, { ...parts, documentIds: ['d1', 'd2', 'd3'] }).reason === 'packet_changed', 'added document invalidates');
ok(P.verifyConfirmationToken(tok, { ...parts, userId: 'u2' }).reason === 'packet_changed', 'different member invalidates');

// forgery
ok(P.verifyConfirmationToken('abc.123.def', parts).reason === 'bad_signature', 'forged token rejected');
ok(P.verifyConfirmationToken('', parts).reason === 'malformed', 'empty token rejected');
ok(P.verifyConfirmationToken(null, parts).reason === 'malformed', 'null token rejected');
const tampered = tok.split('.'); tampered[1] = String(Date.now() + 99999999);
ok(P.verifyConfirmationToken(tampered.join('.'), parts).reason === 'bad_signature', 'extending expiry breaks signature');

// expiry
const expired = (() => {
  const crypto = require('crypto');
  const digest = P.packetDigest(parts);
  const exp = Date.now() - 1000;
  const body = digest + '.' + exp;
  const sig = crypto.createHmac('sha256', process.env.PACKET_CONFIRM_SECRET).update(body).digest('hex');
  return body + '.' + sig;
})();
ok(P.verifyConfirmationToken(expired, parts).reason === 'expired', 'expired token rejected');

// side detection
ok(P.memberSide({ role: 'listing' }) === 'listing', 'role listing');
ok(P.memberSide({ role: 'buyer' }) === 'buyer', 'role buyer');
ok(P.memberSide({ role: null, transaction_type: 'residential_listing_seller' }) === 'listing', 'fallback via transaction_type');
ok(P.memberSide({ role: null, transaction_type: null }) === null, 'unknown side is null');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
