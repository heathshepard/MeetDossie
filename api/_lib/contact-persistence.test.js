'use strict';

// api/_lib/contact-persistence.test.js
//
// Run: node --test api/_lib/contact-persistence.test.js
//
// FIXTURE DATA IS SYNTHETIC. NEVER PUT A REAL PARTY IN THIS FILE.
// This repo is public. Real names, addresses and phone numbers belonging to a
// member's clients are served anonymously from raw.githubusercontent.com the
// moment they are pushed, and a later edit does not remove them from history.
// `scripts/check-no-personal-data.js` fails the commit if one shows up.
//
// EXTRACTED_SABLEWOOD models a TREC 20-19 offer field-for-field — same blocks,
// same page layout, same edge cases as the executed contract this module was
// built against — with every party replaced by an invented one:
//
//   page 11  BROKER CONTACT INFORMATION
//            "Riverbend Realty (Broker Firm) represents Buyer only as Buyer's agent"
//            Associate's Name: Dale Whitaker
//            Associate's Email: dwhitaker@riverbendrealty.example
//            Associate's Phone No.: (210)555-0182
//            "Keller Williams City View (Broker Firm) represents Seller only
//             as Seller's agent" / Heath Shepard / heath.shepard@kw.com
//   page 10  Buyer Nathan Corliss, Buyer Priya Corliss
//            Seller Marcus Thorne, Seller Catherine Thorne
//   page 9   ¶21 To Buyer at: Phone (210)555-0147  E-mail nrc07@mail.example
//   ¶5A      "must deliver to Crosswind Title and Escrow (Rachel Vance) (Escrow Agent)"
//   ¶6A      title insurance issued by Crosswind Title and Escrow
//
// The shape is what matters: these rules decide whether a stranger receives a
// member's contract, so the fixture has to carry the same ambiguities a real
// one does — two principals per side, a nickname the member typed by hand, a
// generational suffix, and a broker block that can be read backwards.

const test = require('node:test');
const assert = require('node:assert');

const {
  validateEmail,
  validatePhone,
  validateName,
  memberSide,
  planContactWrites,
  summarizePlan,
} = require('./contact-persistence');

const { memberSide: senderMemberSide } = require('./packet-recipients');

// ---------------------------------------------------------------------------
// The contract fixture
// ---------------------------------------------------------------------------

const EXTRACTED_SABLEWOOD = {
  propertyAddress: '14 Sablewood',
  cityStateZip: 'San Antonio, TX 78200',
  buyerName: 'Nathan Corliss, Priya Corliss',
  sellerName: 'Marcus Thorne, Catherine Thorne',
  buyerAgent: 'Dale Whitaker',
  listingAgent: 'Heath Shepard',
  buyerNoticeEmail: 'nrc07@mail.example',
  buyerNoticePhone: '(210)555-0147',
  sellerNoticeEmail: null,
  sellerNoticePhone: null,
  titleCompany: 'Crosswind Title and Escrow',
  titleOfficerName: 'Rachel Vance',
  titleOfficerEmail: null,
  titleOfficerPhone: null,
  lenderName: null,
  loanOfficerName: null,
  loanOfficerEmail: null,
  loanOfficerPhone: null,
  parties: {
    buyerAgentEmail: 'dwhitaker@riverbendrealty.example',
    buyerAgentPhone: '(210)555-0182',
    buyerBrokerage: 'Riverbend Realty',
    listingAgentEmail: 'heath.shepard@kw.com',
    listingAgentPhone: '(830)555-0119',
    listingBrokerage: 'Keller Williams City View',
    lender: null,
  },
};

// The dossier row as it stands before the scan: 69 fields already extracted,
// every contact column still null, and one seller name typed by hand.
const TX_SABLEWOOD = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  user_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  role: 'listing',
  property_address: '14 Sablewood',
  seller_name: 'Cathy Thorne', // HUMAN-ENTERED. The contract says "Marcus Thorne".
  parties: {},
};

const SOURCE = {
  documentId: 'doc-1',
  fileName: '1-4_Family_Residential_Contract_Resale.pdf',
  documentLabel: 'Residential contract',
  scanId: 'test-scan',
};

const PROFILE = { email: 'heath.shepard@kw.com' };

function plan(overrides = {}) {
  return planContactWrites({
    tx: { ...TX_SABLEWOOD, ...(overrides.tx || {}) },
    extracted: { ...EXTRACTED_SABLEWOOD, ...(overrides.extracted || {}) },
    source: SOURCE,
    profile: overrides.profile === undefined ? PROFILE : overrides.profile,
  });
}

// ---------------------------------------------------------------------------
// Validation — a wrong value is worse than a missing one
// ---------------------------------------------------------------------------

test('validateEmail accepts a real address and normalises case', () => {
  assert.equal(validateEmail('Dwhitaker@riverbendrealty.example'), 'dwhitaker@riverbendrealty.example');
  assert.equal(validateEmail('  heath.shepard@kw.com  '), 'heath.shepard@kw.com');
  assert.equal(validateEmail('Dale Whitaker <dwhitaker@riverbendrealty.example>'), 'dwhitaker@riverbendrealty.example');
});

test('validateEmail refuses a line that merely contains an address', () => {
  // The failure mode that matters: reading a whole form line and keeping it.
  assert.equal(validateEmail('Email: dwhitaker@riverbendrealty.example Phone: (210)555-0182'), null);
  assert.equal(validateEmail('a@b.com c@d.com'), null);
  assert.equal(validateEmail('dwhitaker@@riverbendrealty.example'), null);
});

test('validateEmail refuses form boilerplate that is not a party', () => {
  // The zipForm/DocuSign/TREC furniture stamped on every page.
  assert.equal(validateEmail('support@lwolf.com'), null);
  assert.equal(validateEmail('dse@docusign.net'), null);
  assert.equal(validateEmail('info@trec.texas.gov'), null);
});

test('validateEmail keeps a short local part — it is a real address shape', () => {
  // memory: parseFromHeader once turned mthorne@mail.example into name "b" +
  // address thorne@mail.example. The lesson is to validate, NOT to start
  // rejecting short local parts — j@kw.com is a legitimate address and
  // dropping it would invent a second bug to cover the first.
  assert.equal(validateEmail('j@kw.com'), 'j@kw.com');
  assert.equal(validateEmail('nrc07@mail.example'), 'nrc07@mail.example');
});

test('validatePhone normalises one number to one spelling', () => {
  assert.equal(validatePhone('(210)555-0182'), '(210) 555-0182');
  assert.equal(validatePhone('210-555-0182'), '(210) 555-0182');
  assert.equal(validatePhone('12105550182'), '(210) 555-0182');
  assert.equal(validatePhone('2105550182 ext 12'), '(210) 555-0182 x12');
});

test('validatePhone drops anything that is not a plausible US number', () => {
  assert.equal(validatePhone('555-0182'), null);       // half a number
  assert.equal(validatePhone('(000) 000-0000'), null); // placeholder
  assert.equal(validatePhone('1112223333'), null);     // exchange starts with 1
  assert.equal(validatePhone('547594'), null);         // a licence number
});

test('validateName rejects the form instead of the value', () => {
  assert.equal(validateName("Associate's Name:"), null);
  assert.equal(validateName('Team Name'), null);
  assert.equal(validateName('Licensed Supervisor of Associate'), null);
  assert.equal(validateName('_______'), null);
  assert.equal(validateName('N/A'), null);
  assert.equal(validateName('Docusign Envelope ID: 1234ABCD-5678-90EF-1234-567890ABCDEF'), null);
  assert.equal(validateName('Produced with Lone Wolf Transactions (zipForm Edition)'), null);
  assert.equal(validateName('Dale Whitaker'), 'Dale Whitaker');
  assert.equal(validateName('  Riverbend   Realty '), 'Riverbend Realty');
});

// ---------------------------------------------------------------------------
// Rule 4 — the other side's client is never a send target
// ---------------------------------------------------------------------------

test('memberSide agrees with the send path, or the whole guarantee is void', () => {
  // If these two disagree, persistence writes an opposing principal's address
  // into a column the sender treats as the member's own client.
  for (const tx of [
    { role: 'listing' }, { role: 'seller' }, { role: 'buyer' }, { role: '' },
    { transaction_type: 'listing' }, { transaction_type: 'buyer_purchase' },
    { transaction_type: 'tenant' }, { transaction_type: 'landlord' }, {},
  ]) {
    assert.equal(memberSide(tx), senderMemberSide(tx), JSON.stringify(tx));
  }
});

test("listing side: the buyers' names are recorded, their contact details are not sendable", () => {
  const p = plan();

  // Names go on the record — they are on the contract and the member needs them.
  assert.equal(p.updates.buyer_name, 'Nathan Corliss');
  assert.equal(p.updates.buyer2_name, 'Priya Corliss');

  // Their notice email and phone must NOT reach a column the sender resolves.
  assert.equal(p.updates.buyer_email, undefined);
  assert.equal(p.updates.buyer_phone, undefined);

  // They are recorded, flagged, and explained.
  assert.equal(p.parties.buyer.contact_blocked.email, "nrc07@mail.example");
  assert.equal(p.parties.buyer.email, undefined); // never under a key the UI promotes
  assert.equal(p.parties.buyer.contactable, false);
  assert.ok(p.blocked.some((b) => b.party === 'buyer' && b.kind === 'email'));
});

test('buyer side: the same buyer IS the member’s own client and becomes sendable', () => {
  const p = plan({ tx: { role: 'buyer', seller_name: null } });
  assert.equal(p.updates.buyer_email, 'nrc07@mail.example');
  assert.equal(p.updates.buyer_phone, '(210) 555-0147');
  assert.ok(!p.blocked.some((b) => b.party === 'buyer'));
});

test('unknown side is treated as opposing for BOTH principals', () => {
  // Erring the safe way costs a manual paste. Erring the other way is an
  // improper contact with a represented party.
  const p = plan({ tx: { role: null, transaction_type: null, seller_name: null } });
  assert.equal(p.side, null);
  assert.equal(p.updates.buyer_email, undefined);
  assert.equal(p.updates.seller_email, undefined);
  assert.equal(p.updates.buyer_name, 'Nathan Corliss'); // name still recorded
});

// ---------------------------------------------------------------------------
// Rule 1 — a human value always wins
// ---------------------------------------------------------------------------

test('a member-typed value is never overwritten, and the disagreement is surfaced', () => {
  const p = plan();

  // Heath typed "Cathy Thorne". The contract says "Marcus Thorne". Dossie does
  // not get to decide which is right.
  assert.equal(p.updates.seller_name, undefined);

  const c = p.conflicts.find((x) => x.column === 'seller_name');
  assert.ok(c, 'the disagreement must be surfaced, not swallowed');
  assert.equal(c.existing, 'Cathy Thorne');
  assert.equal(c.parsed, 'Marcus Thorne');
  assert.equal(c.source_block, 'signature block');
  assert.equal(c.document.file_name, SOURCE.fileName);
});

test('a disputed first name does not half-fill the party list', () => {
  // Caught running this against the real contract. seller_name is "Cathy
  // Thorne" (typed by Heath); the contract says "Marcus Thorne, Catherine Thorne".
  // Writing the empty second slot from the parsed list produced "Cathy Thorne"
  // + "Catherine Thorne" — the same woman twice — and dropped Marcus, who is an
  // actual seller. Half a party list looks complete and is not.
  const p = plan();
  assert.equal(p.updates.seller_name, undefined);
  assert.equal(p.updates.seller2_name, undefined);
  assert.ok(p.rejected.some((r) => r.party === 'seller' && r.kind === 'name2'));

  const c = p.conflicts.find((x) => x.column === 'seller_name');
  assert.deepEqual(c.parsed_all, ['Marcus Thorne', 'Catherine Thorne']);
  assert.match(c.detail, /Marcus Thorne and Catherine Thorne/);
  assert.match(c.detail, /saved neither name/);
});

test('an undisputed party list fills both slots', () => {
  const p = plan({ tx: { seller_name: null } });
  assert.equal(p.updates.seller_name, 'Marcus Thorne');
  assert.equal(p.updates.seller2_name, 'Catherine Thorne');
});

test('a combined party string is agreement, not a conflict', () => {
  // TREC prints a multi-person party as one string and Dossie stores it that
  // way. Found on a live deal: dossier buyer_name = "Miguel
  // Ortega, Carmen Ortega", contract says exactly those two people, and the
  // naive comparison called it a disagreement on every such deal.
  const p = plan({
    tx: {
      seller_name: 'Marcus Thorne, Catherine Thorne',
      buyer_name: 'Nathan Corliss, Priya Corliss',
    },
  });
  assert.equal(p.conflicts.length, 0);
  assert.equal(p.updates.seller_name, undefined);
  assert.equal(p.updates.seller2_name, undefined);
  assert.equal(p.updates.buyer2_name, undefined);
});

test('a combined string in the SECOND slot also counts as present', () => {
  // Real shape on 88 Amberwood: seller2_name held "Gregory Hale, William
  // Hale".
  const p = plan({ tx: { seller_name: 'Marcus Thorne', seller2_name: 'Catherine Thorne, Marcus Thorne' } });
  assert.equal(p.conflicts.length, 0);
});

test('a generational suffix is not a second person', () => {
  // Real buyer on 88 Amberwood: "Arthur W. Kendrick, Jr.". Splitting on the
  // comma made "Jr" a human being headed for buyer2_name.
  const p = plan({
    tx: { role: 'buyer', seller_name: null },
    extracted: { buyerName: 'Arthur W. Kendrick, Jr.' },
  });
  assert.equal(p.updates.buyer_name, 'Arthur W. Kendrick, Jr.');
  assert.equal(p.updates.buyer2_name, undefined);

  const two = plan({
    tx: { role: 'buyer', seller_name: null },
    extracted: { buyerName: 'Arthur W. Kendrick, Jr., Margaret Kendrick' },
  });
  assert.equal(two.updates.buyer_name, 'Arthur W. Kendrick, Jr.');
  assert.equal(two.updates.buyer2_name, 'Margaret Kendrick');
});

test('an identical existing value is not reported as a conflict', () => {
  const p = plan({ tx: { other_agent_email_addr: 'DWhitaker@RiverbendRealty.example' } });
  assert.equal(p.updates.other_agent_email_addr, undefined);
  assert.ok(!p.conflicts.some((c) => c.column === 'other_agent_email_addr'));
});

// ---------------------------------------------------------------------------
// Rule 3 — guards against the extraction being wrong
// ---------------------------------------------------------------------------

test('identical agent emails mean one broker block was read twice — save neither', () => {
  const p = plan({
    extracted: {
      parties: { ...EXTRACTED_SABLEWOOD.parties, buyerAgentEmail: 'heath.shepard@kw.com' },
    },
  });
  assert.equal(p.updates.other_agent_email_addr, undefined);
  assert.equal(p.updates.listing_agent_email_addr, undefined);
  assert.equal(p.updates.other_agent_name, undefined);
  assert.ok(p.conflicts.some((c) => c.kind === 'agent_block_ambiguous' || c.kind === 'agent_block_reversed'));
});

test("the member's own address as the cooperating agent is refused", () => {
  // Writing it would make send_packet_to_party mail Heath his own packet
  // while the real other agent stays unreachable — a silent dead end.
  const p = plan({
    extracted: {
      parties: {
        ...EXTRACTED_SABLEWOOD.parties,
        buyerAgentEmail: 'heath.shepard@kw.com',
        listingAgentEmail: 'dwhitaker@riverbendrealty.example',
      },
    },
  });
  assert.equal(p.updates.other_agent_email_addr, undefined);
  assert.ok(p.conflicts.some((c) => c.kind === 'agent_block_reversed'));
});

test('a mangled value is dropped rather than written', () => {
  const p = plan({
    extracted: { parties: { ...EXTRACTED_SABLEWOOD.parties, buyerAgentPhone: '555-0182' } },
  });
  assert.equal(p.updates.other_agent_phone, undefined);
  assert.ok(p.rejected.some((r) => r.party === 'buyerAgent' && r.kind === 'phone'));
  // …and the good fields on the same block still land.
  assert.equal(p.updates.other_agent_email_addr, 'dwhitaker@riverbendrealty.example');
});

// ---------------------------------------------------------------------------
// Rule 2 — provenance
// ---------------------------------------------------------------------------

test('every written value records which document and which block it came off', () => {
  const p = plan();
  for (const col of Object.keys(p.updates)) {
    const prov = p.provenance[col];
    assert.ok(prov, `${col} written with no provenance`);
    assert.equal(prov.value, p.updates[col]);
    assert.equal(prov.origin, 'contract_scan');
    assert.equal(prov.file_name, SOURCE.fileName);
    assert.ok(prov.source_block, `${col} has no source block`);
    assert.ok(prov.source_field, `${col} has no source field`);
  }
  assert.equal(p.provenance.other_agent_email_addr.source_block, 'BROKER CONTACT INFORMATION');
  assert.equal(p.provenance.title_company.source_block, 'Paragraph 6A');
});

// ---------------------------------------------------------------------------
// The whole thing, end to end
// ---------------------------------------------------------------------------

test('14 Sablewood: the buyer’s agent becomes a resolvable recipient', () => {
  const p = plan();

  // The exact thing Heath asked for and could not do.
  assert.equal(p.updates.other_agent_name, 'Dale Whitaker');
  assert.equal(p.updates.other_agent_email_addr, 'dwhitaker@riverbendrealty.example');
  assert.equal(p.updates.other_broker_name, 'Riverbend Realty');

  assert.equal(p.updates.listing_agent_name, 'Heath Shepard');
  assert.equal(p.updates.listing_agent_email_addr, 'heath.shepard@kw.com');
  assert.equal(p.updates.listing_agent_phone_no, '(830) 555-0119');
  assert.equal(p.updates.listing_broker_name, 'Keller Williams City View');

  assert.equal(p.updates.title_company, 'Crosswind Title and Escrow');
  assert.equal(p.updates.title_officer_name, 'Rachel Vance');

  // Mirrored into `parties` so the four existing jsonb consumers see it.
  assert.equal(p.parties.buyerAgent.email, 'dwhitaker@riverbendrealty.example');
  assert.equal(p.parties.title.company, 'Crosswind Title and Escrow');
});

test('the summary tells the member what happened, including what it refused to do', () => {
  const s = summarizePlan(plan());
  assert.match(s, /buyer's agent/);
  assert.match(s, /Cathy Thorne/);          // the conflict is spoken, not buried
  assert.match(s, /did not make them sendable/);
});

test('a second scan of the same contract changes nothing', () => {
  const first = plan();
  const settled = { ...TX_SABLEWOOD, ...first.updates, parties: first.parties };
  const second = planContactWrites({ tx: settled, extracted: EXTRACTED_SABLEWOOD, source: SOURCE, profile: PROFILE });
  assert.deepEqual(second.updates, {});
  assert.equal(second.filled.length, 0);
  // The one genuine disagreement is still reported, because it is still true.
  assert.ok(second.conflicts.some((c) => c.column === 'seller_name'));
});

test('an empty extraction is a no-op, not a wipe', () => {
  const p = planContactWrites({ tx: TX_SABLEWOOD, extracted: {}, source: SOURCE, profile: PROFILE });
  assert.deepEqual(p.updates, {});
  assert.equal(p.parties, null);
});
