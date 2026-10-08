'use strict';

// api/_lib/packet-recipients-contacts.test.js
//
// Run: node --test api/_lib/packet-recipients-contacts.test.js
//
// The join between the two halves of this feature: contacts the contract scan
// writes must be contacts the SENDER can actually resolve. Those were two
// different sets of columns until 2026-09-20, which is the whole reason Dossie
// could read a buyer's agent off a contract and still say she had no address
// for them.
//
// Fixture is the real 14 Sablewood deal. Heath is the LISTING agent; the buyers
// (the Corlisses) are the other side's clients.

const test = require('node:test');
const assert = require('node:assert');

const { planContactWrites } = require('./contact-persistence');
const { resolveRoleRecipients, assertNotOpposingPrincipal } = require('./packet-recipients');

const EXTRACTED = {
  buyerName: 'Nathan Corliss, Priya Corliss',
  sellerName: 'Marcus Thorne, Catherine Thorne',
  buyerAgent: 'Dale Whitaker',
  listingAgent: 'Heath Shepard',
  buyerNoticeEmail: 'nrc07@mail.example',
  buyerNoticePhone: '(210)555-0147',
  titleCompany: 'Crosswind Title and Escrow',
  titleOfficerName: 'Rachel Vance',
  parties: {
    buyerAgentEmail: 'dwhitaker@riverbendrealty.example',
    buyerAgentPhone: '(210)555-0182',
    buyerBrokerage: 'Riverbend Realty',
    listingAgentEmail: 'heath.shepard@kw.com',
    listingAgentPhone: '(830)555-0119',
    listingBrokerage: 'Keller Williams City View',
  },
};

const BEFORE = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  role: 'listing',
  seller_name: 'Cathy Thorne',
  parties: {},
};

const PROFILE = { full_name: 'Heath Shepard', email: 'heath.shepard@kw.com', brokerage: 'KW City View' };

// The row as it stands AFTER the scan persists contacts.
function afterScan() {
  const plan = planContactWrites({
    tx: BEFORE,
    extracted: EXTRACTED,
    source: { fileName: 'contract.pdf' },
    profile: PROFILE,
  });
  return { ...BEFORE, ...plan.updates, parties: plan.parties };
}

test('BEFORE: the send capability has no recipient — the live failure', () => {
  const r = resolveRoleRecipients({ tx: BEFORE, profile: PROFILE, role: 'buyer_agent' });
  assert.equal(r.ok, false);
  assert.match(r.error, /don't have an email address/);
});

test("AFTER: send_packet_to_party resolves the buyer's agent", () => {
  const r = resolveRoleRecipients({ tx: afterScan(), profile: PROFILE, role: 'buyer_agent' });
  assert.equal(r.ok, true);
  assert.equal(r.recipients.length, 1);
  assert.equal(r.recipients[0].email, 'dwhitaker@riverbendrealty.example');
  assert.equal(r.recipients[0].name, 'Dale Whitaker');
});

test('AFTER: title resolves to the named escrow officer', () => {
  // Nothing on this contract carries a title EMAIL, so this must still refuse
  // — honestly, naming what is missing. A resolved-but-wrong address would be
  // worse than this.
  const r = resolveRoleRecipients({ tx: afterScan(), profile: PROFILE, role: 'title' });
  assert.equal(r.ok, false);
  assert.match(r.error, /title \/ escrow officer/i);
});

test('AFTER: the buyers are still unreachable by role', () => {
  const r = resolveRoleRecipients({ tx: afterScan(), profile: PROFILE, role: 'buyer' });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'opposing_principal');
  assert.match(r.error, /buyer's agent/);
});

test("AFTER: the buyer's address typed by hand is refused", () => {
  // This is the case the scan CREATED the risk for: before it ran, Dossie had
  // never seen nrc07@mail.example and could not have blocked it. The address is
  // deliberately kept out of buyer_email and put in parties.buyer instead, so
  // the blocklist has to read there — otherwise persisting it would have made
  // the member MORE able to reach the other side's client, not less.
  const r = assertNotOpposingPrincipal({ tx: afterScan(), email: 'nrc07@mail.example' });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, 'opposing_principal');
});

test('THE SPLIT BRAIN: a deal scanned by the browser is sendable again', () => {
  // dossie-app.jsx handleUploadDocument writes agent contacts ONLY into
  // `parties` — mapAppTransactionToDb never writes other_agent_email_addr.
  // Every deal scanned through the UI therefore had the address on file and
  // unreachable at the same time. The jsonb fallback is what fixes those
  // deals without a re-scan, a backfill or a bundle deploy.
  const browserScanned = {
    role: 'listing',
    parties: {
      buyerAgent: { name: 'Dale Whitaker', email: 'dwhitaker@riverbendrealty.example', phone: '(210) 555-0182' },
    },
  };
  const r = resolveRoleRecipients({ tx: browserScanned, profile: PROFILE, role: 'buyer_agent' });
  assert.equal(r.ok, true);
  assert.equal(r.recipients[0].email, 'dwhitaker@riverbendrealty.example');
});

test('a typed column still outranks the parsed jsonb', () => {
  const both = {
    role: 'listing',
    other_agent_name: 'Corrected Name',
    other_agent_email_addr: 'corrected@riverbendrealty.example',
    parties: { buyerAgent: { name: 'Dale Whitaker', email: 'dwhitaker@riverbendrealty.example' } },
  };
  const r = resolveRoleRecipients({ tx: both, profile: PROFILE, role: 'buyer_agent' });
  assert.equal(r.recipients[0].email, 'corrected@riverbendrealty.example');
  assert.equal(r.recipients[0].name, 'Corrected Name');
});

test('the browser cannot promote a blocked address into a send column', () => {
  // Dossie/src/utils/transactions.js mapAppTransactionToDb does:
  //   buyer_email: toStrOrNull(deal.buyerEmail || deal.parties?.buyer?.email)
  // so anything stored under parties.buyer.email becomes buyer_email the next
  // time the member saves that deal from the UI. Storing an opposing
  // principal's ¶21 address there would have handed it to a send column by a
  // route this module does not control. It goes under contact_blocked instead.
  const after = afterScan();
  assert.equal(after.parties.buyer.email, undefined);
  assert.equal(after.parties.buyer.contact_blocked.email, 'nrc07@mail.example');

  // Simulate the UI round-trip and confirm buyer_email is still empty.
  const promoted = after.buyer_email || after.parties?.buyer?.email || null;
  assert.equal(promoted, null);
});

test('a malformed address in the jsonb does not become a recipient', () => {
  const junk = {
    role: 'listing',
    parties: { buyerAgent: { name: 'Dale Whitaker', email: 'Email: dwhitaker@riverbendrealty.example' } },
  };
  const r = resolveRoleRecipients({ tx: junk, profile: PROFILE, role: 'buyer_agent' });
  assert.equal(r.ok, false);
});
