'use strict';

// api/_lib/contact-persistence.test.js
//
// Run: node --test api/_lib/contact-persistence.test.js
//
// The fixture in EXTRACTED_NOPALITO is the real 23 Nopalito offer — a TREC
// 20-19 executed 2026-09-19, read off
// .tmp/nopalito-offer/1-4_Family_Residential_Contract_Resale_-_526_ts37933.pdf.
// Every value in it appears verbatim on that contract:
//
//   page 11  BROKER CONTACT INFORMATION
//            "Pure Home River (Broker Firm) represents Buyer only as Buyer's agent"
//            Associate's Name: Clyde Johnson
//            Associate's Email: jojohnson@purehomeriver.com
//            Associate's Phone No.: (210)789-3727
//            "Keller Williams City View (Broker Firm) represents Seller only
//             as Seller's agent" / Heath Shepard / heath.shepard@kw.com
//   page 10  Buyer Christopher Bryan, Buyer Monica Bryan
//            Seller Barry Whyte, Seller Jennifer Whyte
//   page 9   ¶21 To Buyer at: Phone (210)467-2232  E-mail cwb03@hotmail.com
//   ¶5A      "must deliver to Upward Title and Closing (Lauren Lugo) (Escrow Agent)"
//   ¶6A      title insurance issued by Upward Title and Closing
//
// These are a real member's real clients, which is the point: the rules this
// file asserts are the ones that decide whether a stranger receives their
// contract.

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
// The real contract
// ---------------------------------------------------------------------------

const EXTRACTED_NOPALITO = {
  propertyAddress: '23 Nopalito',
  cityStateZip: 'San Antonio, TX 78261',
  buyerName: 'Christopher Bryan, Monica Bryan',
  sellerName: 'Barry Whyte, Jennifer Whyte',
  buyerAgent: 'Clyde Johnson',
  listingAgent: 'Heath Shepard',
  buyerNoticeEmail: 'cwb03@hotmail.com',
  buyerNoticePhone: '(210)467-2232',
  sellerNoticeEmail: null,
  sellerNoticePhone: null,
  titleCompany: 'Upward Title and Closing',
  titleOfficerName: 'Lauren Lugo',
  titleOfficerEmail: null,
  titleOfficerPhone: null,
  lenderName: null,
  loanOfficerName: null,
  loanOfficerEmail: null,
  loanOfficerPhone: null,
  parties: {
    buyerAgentEmail: 'jojohnson@purehomeriver.com',
    buyerAgentPhone: '(210)789-3727',
    buyerBrokerage: 'Pure Home River',
    listingAgentEmail: 'heath.shepard@kw.com',
    listingAgentPhone: '(808)392-3032',
    listingBrokerage: 'Keller Williams City View',
    lender: null,
  },
};

// The live row as it stood 2026-09-20: 69 fields extracted, every contact
// column null, and one value Heath typed himself.
const TX_NOPALITO = {
  id: '952e0d82-c453-4137-87b4-1ed46e738eb3',
  user_id: '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6',
  role: 'listing',
  property_address: '23 Nopalito',
  seller_name: 'Jenny Whyte', // HUMAN-ENTERED. The contract says "Barry Whyte".
  parties: {},
};

const SOURCE = {
  documentId: 'doc-1',
  fileName: '1-4_Family_Residential_Contract_Resale_-_526_ts37933.pdf',
  documentLabel: 'Residential contract',
  scanId: 'test-scan',
};

const PROFILE = { email: 'heath.shepard@kw.com' };

function plan(overrides = {}) {
  return planContactWrites({
    tx: { ...TX_NOPALITO, ...(overrides.tx || {}) },
    extracted: { ...EXTRACTED_NOPALITO, ...(overrides.extracted || {}) },
    source: SOURCE,
    profile: overrides.profile === undefined ? PROFILE : overrides.profile,
  });
}

// ---------------------------------------------------------------------------
// Validation — a wrong value is worse than a missing one
// ---------------------------------------------------------------------------

test('validateEmail accepts a real address and normalises case', () => {
  assert.equal(validateEmail('Jojohnson@purehomeriver.com'), 'jojohnson@purehomeriver.com');
  assert.equal(validateEmail('  heath.shepard@kw.com  '), 'heath.shepard@kw.com');
  assert.equal(validateEmail('Clyde Johnson <jojohnson@purehomeriver.com>'), 'jojohnson@purehomeriver.com');
});

test('validateEmail refuses a line that merely contains an address', () => {
  // The failure mode that matters: reading a whole form line and keeping it.
  assert.equal(validateEmail('Email: jojohnson@purehomeriver.com Phone: (210)789-3727'), null);
  assert.equal(validateEmail('a@b.com c@d.com'), null);
  assert.equal(validateEmail('jojohnson@@purehomeriver.com'), null);
});

test('validateEmail refuses form boilerplate that is not a party', () => {
  // The zipForm/DocuSign/TREC furniture stamped on every page.
  assert.equal(validateEmail('support@lwolf.com'), null);
  assert.equal(validateEmail('dse@docusign.net'), null);
  assert.equal(validateEmail('info@trec.texas.gov'), null);
});

test('validateEmail keeps a short local part — it is a real address shape', () => {
  // memory: parseFromHeader once turned bwhyte@hotmail.com into name "b" +
  // address whyte@hotmail.com. The lesson is to validate, NOT to start
  // rejecting short local parts — j@kw.com is a legitimate address and
  // dropping it would invent a second bug to cover the first.
  assert.equal(validateEmail('j@kw.com'), 'j@kw.com');
  assert.equal(validateEmail('cwb03@hotmail.com'), 'cwb03@hotmail.com');
});

test('validatePhone normalises one number to one spelling', () => {
  assert.equal(validatePhone('(210)789-3727'), '(210) 789-3727');
  assert.equal(validatePhone('210-789-3727'), '(210) 789-3727');
  assert.equal(validatePhone('12107893727'), '(210) 789-3727');
  assert.equal(validatePhone('2107893727 ext 12'), '(210) 789-3727 x12');
});

test('validatePhone drops anything that is not a plausible US number', () => {
  assert.equal(validatePhone('789-3727'), null);       // half a number
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
  assert.equal(validateName('Docusign Envelope ID: AA6EA8F5-957F-8A97-8353-5E1D6AEED395'), null);
  assert.equal(validateName('Produced with Lone Wolf Transactions (zipForm Edition)'), null);
  assert.equal(validateName('Clyde Johnson'), 'Clyde Johnson');
  assert.equal(validateName('  Pure  Home   River '), 'Pure Home River');
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
  assert.equal(p.updates.buyer_name, 'Christopher Bryan');
  assert.equal(p.updates.buyer2_name, 'Monica Bryan');

  // Their notice email and phone must NOT reach a column the sender resolves.
  assert.equal(p.updates.buyer_email, undefined);
  assert.equal(p.updates.buyer_phone, undefined);

  // They are recorded, flagged, and explained.
  assert.equal(p.parties.buyer.contact_blocked.email, "cwb03@hotmail.com");
  assert.equal(p.parties.buyer.email, undefined); // never under a key the UI promotes
  assert.equal(p.parties.buyer.contactable, false);
  assert.ok(p.blocked.some((b) => b.party === 'buyer' && b.kind === 'email'));
});

test('buyer side: the same buyer IS the member’s own client and becomes sendable', () => {
  const p = plan({ tx: { role: 'buyer', seller_name: null } });
  assert.equal(p.updates.buyer_email, 'cwb03@hotmail.com');
  assert.equal(p.updates.buyer_phone, '(210) 467-2232');
  assert.ok(!p.blocked.some((b) => b.party === 'buyer'));
});

test('unknown side is treated as opposing for BOTH principals', () => {
  // Erring the safe way costs a manual paste. Erring the other way is an
  // improper contact with a represented party.
  const p = plan({ tx: { role: null, transaction_type: null, seller_name: null } });
  assert.equal(p.side, null);
  assert.equal(p.updates.buyer_email, undefined);
  assert.equal(p.updates.seller_email, undefined);
  assert.equal(p.updates.buyer_name, 'Christopher Bryan'); // name still recorded
});

// ---------------------------------------------------------------------------
// Rule 1 — a human value always wins
// ---------------------------------------------------------------------------

test('a member-typed value is never overwritten, and the disagreement is surfaced', () => {
  const p = plan();

  // Heath typed "Jenny Whyte". The contract says "Barry Whyte". Dossie does
  // not get to decide which is right.
  assert.equal(p.updates.seller_name, undefined);

  const c = p.conflicts.find((x) => x.column === 'seller_name');
  assert.ok(c, 'the disagreement must be surfaced, not swallowed');
  assert.equal(c.existing, 'Jenny Whyte');
  assert.equal(c.parsed, 'Barry Whyte');
  assert.equal(c.source_block, 'signature block');
  assert.equal(c.document.file_name, SOURCE.fileName);
});

test('a disputed first name does not half-fill the party list', () => {
  // Caught running this against the real contract. seller_name is "Jenny
  // Whyte" (typed by Heath); the contract says "Barry Whyte, Jennifer Whyte".
  // Writing the empty second slot from the parsed list produced "Jenny Whyte"
  // + "Jennifer Whyte" — the same woman twice — and dropped Barry, who is an
  // actual seller. Half a party list looks complete and is not.
  const p = plan();
  assert.equal(p.updates.seller_name, undefined);
  assert.equal(p.updates.seller2_name, undefined);
  assert.ok(p.rejected.some((r) => r.party === 'seller' && r.kind === 'name2'));

  const c = p.conflicts.find((x) => x.column === 'seller_name');
  assert.deepEqual(c.parsed_all, ['Barry Whyte', 'Jennifer Whyte']);
  assert.match(c.detail, /Barry Whyte and Jennifer Whyte/);
  assert.match(c.detail, /saved neither name/);
});

test('an undisputed party list fills both slots', () => {
  const p = plan({ tx: { seller_name: null } });
  assert.equal(p.updates.seller_name, 'Barry Whyte');
  assert.equal(p.updates.seller2_name, 'Jennifer Whyte');
});

test('a combined party string is agreement, not a conflict', () => {
  // TREC prints a multi-person party as one string and Dossie stores it that
  // way. Found on the real Pfeiffers Gate deal: dossier buyer_name = "Andres
  // Ramirez, Vanessa Ramirez", contract says exactly those two people, and the
  // naive comparison called it a disagreement on every such deal.
  const p = plan({
    tx: {
      seller_name: 'Barry Whyte, Jennifer Whyte',
      buyer_name: 'Christopher Bryan, Monica Bryan',
    },
  });
  assert.equal(p.conflicts.length, 0);
  assert.equal(p.updates.seller_name, undefined);
  assert.equal(p.updates.seller2_name, undefined);
  assert.equal(p.updates.buyer2_name, undefined);
});

test('a combined string in the SECOND slot also counts as present', () => {
  // Real shape on 104 Wild Cherry: seller2_name held "Thomas Linton, William
  // Linton".
  const p = plan({ tx: { seller_name: 'Barry Whyte', seller2_name: 'Jennifer Whyte, Barry Whyte' } });
  assert.equal(p.conflicts.length, 0);
});

test('a generational suffix is not a second person', () => {
  // Real buyer on 104 Wild Cherry: "Clark L. Champie, Jr.". Splitting on the
  // comma made "Jr" a human being headed for buyer2_name.
  const p = plan({
    tx: { role: 'buyer', seller_name: null },
    extracted: { buyerName: 'Clark L. Champie, Jr.' },
  });
  assert.equal(p.updates.buyer_name, 'Clark L. Champie, Jr.');
  assert.equal(p.updates.buyer2_name, undefined);

  const two = plan({
    tx: { role: 'buyer', seller_name: null },
    extracted: { buyerName: 'Clark L. Champie, Jr., Kathleen Champie' },
  });
  assert.equal(two.updates.buyer_name, 'Clark L. Champie, Jr.');
  assert.equal(two.updates.buyer2_name, 'Kathleen Champie');
});

test('an identical existing value is not reported as a conflict', () => {
  const p = plan({ tx: { other_agent_email_addr: 'JoJohnson@PureHomeRiver.com' } });
  assert.equal(p.updates.other_agent_email_addr, undefined);
  assert.ok(!p.conflicts.some((c) => c.column === 'other_agent_email_addr'));
});

// ---------------------------------------------------------------------------
// Rule 3 — guards against the extraction being wrong
// ---------------------------------------------------------------------------

test('identical agent emails mean one broker block was read twice — save neither', () => {
  const p = plan({
    extracted: {
      parties: { ...EXTRACTED_NOPALITO.parties, buyerAgentEmail: 'heath.shepard@kw.com' },
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
        ...EXTRACTED_NOPALITO.parties,
        buyerAgentEmail: 'heath.shepard@kw.com',
        listingAgentEmail: 'jojohnson@purehomeriver.com',
      },
    },
  });
  assert.equal(p.updates.other_agent_email_addr, undefined);
  assert.ok(p.conflicts.some((c) => c.kind === 'agent_block_reversed'));
});

test('a mangled value is dropped rather than written', () => {
  const p = plan({
    extracted: { parties: { ...EXTRACTED_NOPALITO.parties, buyerAgentPhone: '789-3727' } },
  });
  assert.equal(p.updates.other_agent_phone, undefined);
  assert.ok(p.rejected.some((r) => r.party === 'buyerAgent' && r.kind === 'phone'));
  // …and the good fields on the same block still land.
  assert.equal(p.updates.other_agent_email_addr, 'jojohnson@purehomeriver.com');
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
// The whole thing, on the real deal
// ---------------------------------------------------------------------------

test('23 Nopalito: the buyer’s agent becomes a resolvable recipient', () => {
  const p = plan();

  // The exact thing Heath asked for and could not do.
  assert.equal(p.updates.other_agent_name, 'Clyde Johnson');
  assert.equal(p.updates.other_agent_email_addr, 'jojohnson@purehomeriver.com');
  assert.equal(p.updates.other_broker_name, 'Pure Home River');

  assert.equal(p.updates.listing_agent_name, 'Heath Shepard');
  assert.equal(p.updates.listing_agent_email_addr, 'heath.shepard@kw.com');
  assert.equal(p.updates.listing_agent_phone_no, '(808) 392-3032');
  assert.equal(p.updates.listing_broker_name, 'Keller Williams City View');

  assert.equal(p.updates.title_company, 'Upward Title and Closing');
  assert.equal(p.updates.title_officer_name, 'Lauren Lugo');

  // Mirrored into `parties` so the four existing jsonb consumers see it.
  assert.equal(p.parties.buyerAgent.email, 'jojohnson@purehomeriver.com');
  assert.equal(p.parties.title.company, 'Upward Title and Closing');
});

test('the summary tells the member what happened, including what it refused to do', () => {
  const s = summarizePlan(plan());
  assert.match(s, /buyer's agent/);
  assert.match(s, /Jenny Whyte/);          // the conflict is spoken, not buried
  assert.match(s, /did not make them sendable/);
});

test('a second scan of the same contract changes nothing', () => {
  const first = plan();
  const settled = { ...TX_NOPALITO, ...first.updates, parties: first.parties };
  const second = planContactWrites({ tx: settled, extracted: EXTRACTED_NOPALITO, source: SOURCE, profile: PROFILE });
  assert.deepEqual(second.updates, {});
  assert.equal(second.filled.length, 0);
  // The one genuine disagreement is still reported, because it is still true.
  assert.ok(second.conflicts.some((c) => c.column === 'seller_name'));
});

test('an empty extraction is a no-op, not a wipe', () => {
  const p = planContactWrites({ tx: TX_NOPALITO, extracted: {}, source: SOURCE, profile: PROFILE });
  assert.deepEqual(p.updates, {});
  assert.equal(p.parties, null);
});
