'use strict';

// api/_lib/contact-persistence.js
//
// Turn the people a contract scan already read into people Dossie can act on.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// api/scan-contract.js has extracted the broker block, the title company and
// the party names for months. Nothing ever wrote them down. Both callers --
// the dossier scan in the browser and import_email_attachments in
// api/_lib/inbox-tools.js -- take the returned `extracted` object, show it or
// hand it to the model, and drop the contacts on the floor. Verified on 23
// Nopalito 2026-09-20: 69 fields read off a TREC 20-19, all 17 contact columns
// null, `parties` = {}.
//
// Everything downstream that acts on a PERSON therefore fails on a deal that
// otherwise looks complete:
//
//   send_packet_to_party      resolveRoleRecipients() finds no address and
//                             refuses -- "I don't have an email address for
//                             the buyer's agent on this dossier."
//   cron-email-to-dossier     matches inbound mail to a deal BY SENDER
//                             ADDRESS. No addresses on file means a reply to
//                             a $20,000 tax question can never be matched,
//                             filed or found.
//   deal-watch-observe        reports "I can't watch this deal, no contacts".
//
// One missing write, three silent failures. This module is that write.
//
// ---------------------------------------------------------------------------
// THE FOUR RULES IT ENFORCES
// ---------------------------------------------------------------------------
//
// 1. A HUMAN VALUE ALWAYS WINS.
//    We only ever fill a column that is empty. When a parsed value disagrees
//    with a value already on the record, we do NOT resolve it -- we record a
//    conflict and leave the existing value alone. A member who typed a
//    corrected spelling is the authority, not the OCR.
//    (Live example: Nopalito has seller_name = "Jenny Whyte", typed by Heath.
//    The contract signature block says "Barry Whyte, Jennifer Whyte". That is
//    a conflict to surface, not a correction to apply.)
//
// 2. PARSED CONTACT DATA IS A CLAIM, NOT A FACT.
//    memory:acroform-field-names-lie documents 22+ mismapped TREC fields in
//    this codebase, including a checkbox that silently made a false legal
//    attestation. So every value we write carries provenance: which document,
//    which block, which scan, when. A wrong address is then traceable to the
//    page it came off instead of appearing to be something the member typed.
//
// 3. A WRONG EMAIL IS WORSE THAN A MISSING ONE.
//    It routes a client's contract to a stranger. So values are validated, and
//    anything structurally suspect is dropped rather than written. See
//    validateEmail/validatePhone/validateName below, plus the cross-assignment
//    guards in planContactWrites() that catch the single most likely
//    extraction failure on this form: reading the two broker blocks backwards.
//
// 4. THE OTHER SIDE'S CLIENT IS NEVER A SEND TARGET.
//    memory:feedback_never-contact-represented-parties. Their NAME belongs on
//    the record -- it is on the contract, it goes on documents, and the
//    member needs to see it. Their EMAIL AND PHONE must never land in a column
//    that api/_lib/packet-recipients.js resolves a recipient from. So they are
//    written to `parties.<role>` marked `contactable: false`, which feeds the
//    inbound matcher and the send-time blocklist but is not a send target.
//    See routeContact() for the side-aware rule.
//
// This module is pure: it reads a transaction row and an extraction and
// returns a plan. It performs no I/O and issues no writes. Callers apply the
// plan. That is what makes it testable against a real contract without
// touching a real deal.

// ---------------------------------------------------------------------------
// Validation -- rule 3
// ---------------------------------------------------------------------------

// Same shape packet-recipients.js accepts, so we can never persist an address
// that the sender would then reject as unusable.
const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,}$/;

// Addresses and domains that appear ON the form but belong to nobody on the
// deal. zipForm stamps its own producer footer on every page of a Lone Wolf
// contract ("Produced with Lone Wolf Transactions (zipForm Edition) 717 N
// Harwood St ... www.lwolf.com"), DocuSign stamps an envelope ID header, and
// TREC's own address block sits in the closing boilerplate. A scan that reads
// bottom-of-page text as a party field lands on one of these.
const NON_PARTY_DOMAINS = new Set([
  'lwolf.com',
  'zipform.com',
  'zipformplus.com',
  'docusign.com',
  'docusign.net',
  'trec.texas.gov',
  'texasrealestate.com',
  'example.com',
  'example.org',
  'email.com',
  'domain.com',
  'test.com',
]);

/**
 * Accept an email only if it is structurally sound AND belongs to a human on
 * this deal. Returns null for anything else -- never a guess, never a repair.
 */
function validateEmail(raw) {
  if (raw == null) return null;
  let v = String(raw).trim();
  if (!v) return null;

  // Strip a display-name wrapper if the scan handed one back whole.
  const angled = v.match(/^.*<\s*([^<>\s]+@[^<>\s]+?)\s*>$/);
  if (angled) v = angled[1];

  // Trailing form punctuation is common when a value is read off a ruled line.
  v = v.replace(/^[<("'\s]+/, '').replace(/[>)"'.,;:\s]+$/, '');
  v = v.toLowerCase();

  // Any internal whitespace or a second @ means we did not read one address;
  // we read a line. Refuse rather than take the first half.
  if (/\s/.test(v)) return null;
  if ((v.match(/@/g) || []).length !== 1) return null;
  if (!EMAIL_RE.test(v)) return null;

  const domain = v.split('@')[1];
  if (NON_PARTY_DOMAINS.has(domain)) return null;

  // A bare TLD-less or numeric-only domain is a misread, not an address.
  if (/^\d+\.\d+$/.test(domain)) return null;

  return v;
}

/**
 * Normalize a US phone to a single readable form so two spellings of the same
 * number compare equal. Anything that is not a plausible US number is dropped
 * -- a half-read phone number is useless and looks authoritative.
 */
function validatePhone(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Keep an extension if one was written, format the base number.
  const extMatch = s.match(/(?:\bext?\.?|\bx)\s*(\d{1,6})\s*$/i);
  const ext = extMatch ? extMatch[1] : null;
  const base = ext ? s.slice(0, extMatch.index) : s;

  const digits = base.replace(/\D/g, '');
  let ten = null;
  if (digits.length === 10) ten = digits;
  else if (digits.length === 11 && digits[0] === '1') ten = digits.slice(1);
  else return null;

  // A US area code or exchange never starts with 0 or 1. A run of one repeated
  // digit is a placeholder, not a number.
  if (ten[0] === '0' || ten[0] === '1') return null;
  if (ten[3] === '0' || ten[3] === '1') return null;
  if (/^(\d)\1{9}$/.test(ten)) return null;

  const formatted = `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return ext ? `${formatted} x${ext}` : formatted;
}

// Words that mean the scan read the FORM instead of a VALUE. TREC blanks are
// labelled, and an empty labelled blank reads back as its own label.
const LABEL_NOISE = /^(n\/?a|none|tbd|t\.b\.d\.?|unknown|not\s+(?:applicable|provided|listed|specified|available)|name|address|email|e-?mail\(?s?\)?|phone|phone\(?s?\)?|broker|associate|buyer|seller|agent|firm|broker\s*firm|title|escrow|escrow\s*agent|title\s*company|team\s*name|intermediary|licensed\s+supervisor(?:\s+of\s+associate)?|associate'?s?\s+(?:name|email|phone(?:\s+no\.?)?|license\s+no\.?)|print\s+name\(?s?\)?\s*only|do\s+not\s+sign|\(?address\s+of\s+property\)?|x+|-+|_+|\.+)$/i;

/**
 * A person's or company's name, or null. Rejects form labels, placeholder
 * runs, and anything too short or too long to be a real name.
 */
function validateName(raw) {
  if (raw == null) return null;
  let v = String(raw).replace(/\s+/g, ' ').trim();
  if (!v) return null;

  // Trim the punctuation a ruled form line leaves behind — but NOT a trailing
  // period, which is part of the name in "Clark L. Champie, Jr." and in a
  // trailing middle initial. Only a period standing on its own after a space
  // is stray.
  v = v.replace(/^[:\-–—,.\s]+/, '')
    .replace(/[:\-–—,\s]+$/, '')
    .replace(/\s+\.$/, '');
  if (!v) return null;

  if (v.length < 2 || v.length > 120) return null;
  if (LABEL_NOISE.test(v)) return null;

  // Must contain a letter. "(  )" and "____" are blanks, not names.
  if (!/[A-Za-z]/.test(v)) return null;

  // A DocuSign envelope header or a zipForm footer swept up as a name.
  if (/docusign envelope id/i.test(v)) return null;
  if (/produced with|lone wolf|zipform|www\./i.test(v)) return null;
  if (/trec no\.|txr-\d/i.test(v)) return null;

  return v;
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function isBlank(v) {
  return v == null || String(v).trim() === '' || String(v).trim() === '{}';
}

/**
 * Two names refer to the same person for conflict purposes when they are the
 * same string ignoring case, punctuation and spacing. Deliberately strict:
 * "Jenny Whyte" and "Jennifer Whyte" are NOT the same, because deciding they
 * are is exactly the silent correction rule 1 forbids.
 */
function sameValue(a, b) {
  const norm = (x) => String(x == null ? '' : x).toLowerCase().replace(/[^a-z0-9@.]/g, '');
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------
// Which side the member represents -- rule 4 depends entirely on this
// ---------------------------------------------------------------------------

/**
 * Mirrors memberSide() in api/_lib/packet-recipients.js on purpose. The two
 * must agree: if persistence thinks the member is listing side and the sender
 * thinks buyer side, we would write an opposing principal's address into a
 * column the sender treats as the member's own client. Kept as a separate
 * function rather than an import so this module stays dependency-free, and
 * kept byte-identical in behaviour -- see the test that asserts that.
 */
function memberSide(tx) {
  const role = String((tx && tx.role) || '').toLowerCase();
  if (role === 'listing' || role === 'seller') return 'listing';
  if (role === 'buyer') return 'buyer';
  const tt = String((tx && tx.transaction_type) || '').toLowerCase();
  if (tt.includes('listing') || tt.includes('seller') || tt.includes('landlord')) return 'listing';
  if (tt.includes('buyer') || tt.includes('purchase') || tt.includes('tenant')) return 'buyer';
  return null;
}

// ---------------------------------------------------------------------------
// Extraction -> candidate contacts
// ---------------------------------------------------------------------------

// The `parties` jsonb keys every existing consumer already reads:
// cron-email-to-dossier.js:122, deal-watch-observe.js:398, cron-esign-events.js
// and esign-draft-handoff.js. Adding keys is safe (all four iterate an explicit
// allowlist); changing these names is not.
const PARTY_KEYS = ['buyer', 'seller', 'buyerAgent', 'listingAgent', 'title', 'lender'];

// A comma before one of these is punctuation inside ONE person's name, not a
// separator between two people.
//
// Found on the real 104 Wild Cherry contract, whose buyer is "Clark L.
// Champie, Jr.". scan-contract.js's own splitPartyNames() splits that into
// ["Clark L. Champie", "Jr"] — and "Jr" would have been written to
// buyer2_name as a second human being. Plausible, wrong, and exactly the class
// of value that looks like something the member typed once it is in a column.
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|v|vi|md|m\.d|phd|ph\.d|esq|esquire|dds|cpa|trustee|trustees?|as\s+trustee.*|life\s+estate)\.?$/i;

function splitPartyNames(combined) {
  const parts = String(combined || '')
    .split(/\s*(?:,|&|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const out = [];
  for (const part of parts) {
    if (out.length && NAME_SUFFIX.test(part)) {
      // Re-attach to the person it belongs to, with the comma it was split on.
      out[out.length - 1] = `${out[out.length - 1]}, ${part}`;
      continue;
    }
    out.push(part);
  }
  return out;
}

/**
 * Is this parsed name already on the record for this party, in any spelling
 * and in either slot?
 *
 * TREC prints a multi-person party as ONE combined string ("Andres Ramirez,
 * Vanessa Ramirez") and Dossie has always stored it that way — scan-contract.js
 * says so explicitly, and several live deals hold the combined form in
 * buyer_name and even in buyer2_name. So a naive "does the parsed first name
 * equal the existing column" test reports a conflict on every one of those
 * deals: verified against the real corpus 2026-09-20, where it flagged
 * Pfeiffers Gate and Wild Cherry as disagreeing with contracts they agree with
 * perfectly. A conflict the member cannot act on is noise, and noise is how a
 * real conflict gets ignored.
 */
function partyNameAlreadyPresent(row, cols, value) {
  const haystack = [];
  for (const col of [cols.name, cols.name2]) {
    const v = col ? row[col] : null;
    if (isBlank(v)) continue;
    haystack.push(String(v));
    haystack.push(...splitPartyNames(v));
  }
  return haystack.some((h) => sameValue(h, value));
}

/**
 * Read every person off an `extracted` object from scan-contract.js.
 *
 * Returns candidates keyed by party, each carrying the extraction field it came
 * from so provenance can name it later. Nothing is decided here about where a
 * value is allowed to land -- that is planContactWrites()'s job, because it
 * needs the transaction row to know which side the member is on.
 *
 * `source` describes the document this extraction came off, e.g.
 * { documentId, fileName, documentLabel, block: 'BROKER CONTACT INFORMATION' }.
 */
function contactsFromExtraction(extracted, source = {}) {
  const ex = extracted && typeof extracted === 'object' ? extracted : {};
  const p = ex.parties && typeof ex.parties === 'object' ? ex.parties : {};

  const doc = {
    document_id: source.documentId || null,
    file_name: source.fileName || null,
    document_label: source.documentLabel || null,
  };

  const mk = (field, value, kind, block) => {
    const clean = kind === 'email' ? validateEmail(value)
      : kind === 'phone' ? validatePhone(value)
        : validateName(value);
    if (clean == null) {
      return { value: null, rejected: value == null || String(value).trim() === '' ? null : String(value) };
    }
    return { value: clean, field, kind, block, doc };
  };

  const buyerNames = splitPartyNames(ex.buyerName);
  const sellerNames = splitPartyNames(ex.sellerName);

  return {
    buyer: {
      name: mk('buyerName', buyerNames[0] || null, 'name', 'signature block'),
      name2: mk('buyerName', buyerNames[1] || null, 'name', 'signature block'),
      email: mk('buyerNoticeEmail', ex.buyerNoticeEmail, 'email', 'Paragraph 21 NOTICES'),
      phone: mk('buyerNoticePhone', ex.buyerNoticePhone, 'phone', 'Paragraph 21 NOTICES'),
    },
    seller: {
      name: mk('sellerName', sellerNames[0] || null, 'name', 'signature block'),
      name2: mk('sellerName', sellerNames[1] || null, 'name', 'signature block'),
      email: mk('sellerNoticeEmail', ex.sellerNoticeEmail, 'email', 'Paragraph 21 NOTICES'),
      phone: mk('sellerNoticePhone', ex.sellerNoticePhone, 'phone', 'Paragraph 21 NOTICES'),
    },
    buyerAgent: {
      name: mk('buyerAgent', ex.buyerAgent, 'name', 'BROKER CONTACT INFORMATION'),
      email: mk('parties.buyerAgentEmail', p.buyerAgentEmail, 'email', 'BROKER CONTACT INFORMATION'),
      phone: mk('parties.buyerAgentPhone', p.buyerAgentPhone, 'phone', 'BROKER CONTACT INFORMATION'),
      brokerage: mk('parties.buyerBrokerage', p.buyerBrokerage, 'name', 'BROKER CONTACT INFORMATION'),
    },
    listingAgent: {
      name: mk('listingAgent', ex.listingAgent, 'name', 'BROKER CONTACT INFORMATION'),
      email: mk('parties.listingAgentEmail', p.listingAgentEmail, 'email', 'BROKER CONTACT INFORMATION'),
      phone: mk('parties.listingAgentPhone', p.listingAgentPhone, 'phone', 'BROKER CONTACT INFORMATION'),
      brokerage: mk('parties.listingBrokerage', p.listingBrokerage, 'name', 'BROKER CONTACT INFORMATION'),
    },
    title: {
      company: mk('titleCompany', ex.titleCompany, 'name', 'Paragraph 6A'),
      name: mk('titleOfficerName', ex.titleOfficerName || ex.titleOfficer, 'name', 'Paragraph 5A / 6A'),
      email: mk('titleOfficerEmail', ex.titleOfficerEmail, 'email', 'Paragraph 5A / 6A'),
      phone: mk('titleOfficerPhone', ex.titleOfficerPhone, 'phone', 'Paragraph 5A / 6A'),
    },
    lender: {
      // parties.lender is a free-text institution name in the extraction
      // schema; lenderName is the dedicated field. Prefer the dedicated one.
      company: mk('lenderName', ex.lenderName || (typeof p.lender === 'string' ? p.lender : null), 'name', 'Third Party Financing Addendum'),
      name: mk('loanOfficerName', ex.loanOfficerName, 'name', 'Third Party Financing Addendum'),
      email: mk('loanOfficerEmail', ex.loanOfficerEmail, 'email', 'Third Party Financing Addendum'),
      phone: mk('loanOfficerPhone', ex.loanOfficerPhone, 'phone', 'Third Party Financing Addendum'),
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate contacts -> a write plan
// ---------------------------------------------------------------------------

// Where each party's details live on the transactions row. These are exactly
// the columns api/_lib/packet-recipients.js resolves recipients from -- writing
// anywhere else would leave the sender still unable to find anybody.
const COLUMN_MAP = {
  buyer: { name: 'buyer_name', name2: 'buyer2_name', email: 'buyer_email', phone: 'buyer_phone' },
  seller: { name: 'seller_name', name2: 'seller2_name', email: 'seller_email', phone: 'seller_phone' },
  buyerAgent: { name: 'other_agent_name', email: 'other_agent_email_addr', brokerage: 'other_broker_name' },
  listingAgent: { name: 'listing_agent_name', email: 'listing_agent_email_addr', phone: 'listing_agent_phone_no', brokerage: 'listing_broker_name' },
  title: { company: 'title_company', name: 'title_officer_name', email: 'title_officer_email', phone: 'title_officer_phone' },
  lender: { company: 'lender_name', name: 'loan_officer_name', email: 'loan_officer_email', phone: 'loan_officer_phone' },
};

/**
 * Rule 4, decided in one place.
 *
 * A principal (buyer or seller) is the member's OWN CLIENT on one side of the
 * deal and the OPPOSING PRINCIPAL on the other. Their name goes on the record
 * either way -- it is on the contract and the member needs to see it. Their
 * email and phone go into a send-target column ONLY when they are the member's
 * own client.
 *
 * When the deal does not say which side the member is on, a principal's
 * contact details are treated as opposing. Getting this wrong in the safe
 * direction costs the member one manual paste; getting it wrong in the other
 * direction is an improper contact with a represented party.
 */
function routeContact({ party, kind, side }) {
  if (party !== 'buyer' && party !== 'seller') return 'column';
  if (kind === 'name' || kind === 'name2') return 'column';
  const ownSide = party === 'buyer' ? 'buyer' : 'listing';
  return side === ownSide ? 'column' : 'blocked';
}

/**
 * Build the write plan for one transaction from one extraction.
 *
 * @param {object}  tx          the existing transactions row (must include the
 *                              COLUMN_MAP columns, `parties`, and `role`)
 * @param {object}  extracted   `extracted` from scan-contract.js
 * @param {object}  source      { documentId, fileName, documentLabel, scanId }
 * @param {object}  profile     optional { email } -- the member's own address,
 *                              used to catch a reversed broker block
 *
 * @returns {{
 *   updates: object,        columns to PATCH (only ones that were empty)
 *   parties: object,        the merged `parties` jsonb, or null if unchanged
 *   provenance: object,     per-field record of where each written value came from
 *   conflicts: Array,       parsed value disagrees with an existing one -- NOT applied
 *   blocked: Array,         opposing-principal details deliberately kept off send columns
 *   rejected: Array,        values that failed validation and were dropped
 *   filled: Array,          human-readable list of what was actually written
 * }}
 */
function planContactWrites({ tx, extracted, source = {}, profile = null }) {
  const row = tx && typeof tx === 'object' ? tx : {};
  const side = memberSide(row);
  const cand = contactsFromExtraction(extracted, source);

  const updates = {};
  const provenance = {};
  const conflicts = [];
  const blocked = [];
  const rejected = [];
  const filled = [];

  // ---- Guard A: the two broker blocks read backwards ----------------------
  // The single most likely failure on this form. TREC 20-19 stacks the two
  // broker blocks vertically and distinguishes them only by the sentence
  // "represents Seller only as Seller's agent" vs "represents Buyer only as
  // Buyer's agent" -- there is no left/right position to fall back on. If both
  // blocks came back identical, one block was read twice; neither value is
  // trustworthy, so neither is written.
  const baEmail = cand.buyerAgent.email.value;
  const laEmail = cand.listingAgent.email.value;
  let agentBlockSuspect = false;
  if (baEmail && laEmail && baEmail === laEmail) {
    agentBlockSuspect = true;
    conflicts.push({
      kind: 'agent_block_ambiguous',
      detail: `The buyer's agent and the listing agent both came back as ${baEmail}. ` +
        'That means one broker block was read twice, so neither agent address was saved.',
      parsed: baEmail,
    });
  }

  // ---- Guard B: the member's own address landed on the other side ---------
  // If the member's own email shows up as the cooperating agent, the blocks
  // were read backwards. Refuse that one value rather than write an address
  // that would make send_packet_to_party mail the member their own packet
  // while the real other agent stays unreachable.
  const myEmail = normEmail(profile && profile.email);
  if (myEmail && baEmail && baEmail === myEmail) {
    agentBlockSuspect = true;
    conflicts.push({
      kind: 'agent_block_reversed',
      detail: `The cooperating agent on this contract read back as your own address (${baEmail}). ` +
        'The two broker blocks were almost certainly read in the wrong order, so no agent address was saved.',
      parsed: baEmail,
    });
  }

  // ---- Walk every candidate -----------------------------------------------
  const partiesOut = {};
  const existingParties = row.parties && typeof row.parties === 'object' && !Array.isArray(row.parties)
    ? row.parties
    : {};
  for (const k of PARTY_KEYS) {
    if (existingParties[k] && typeof existingParties[k] === 'object') {
      partiesOut[k] = { ...existingParties[k] };
    }
  }
  let partiesChanged = false;

  for (const party of PARTY_KEYS) {
    const kinds = cand[party];
    const cols = COLUMN_MAP[party];
    if (!kinds || !cols) continue;

    const suspect = agentBlockSuspect && (party === 'buyerAgent' || party === 'listingAgent');

    // --- Guard C: a disputed FIRST name puts the whole ordering in doubt ----
    //
    // Found running this against the real Nopalito contract. The dossier said
    // seller_name = "Jenny Whyte" (typed by Heath). The contract signature
    // block says "Barry Whyte, Jennifer Whyte". Filling the empty second slot
    // from the parsed list produced seller_name "Jenny Whyte" + seller2_name
    // "Jennifer Whyte" -- the same woman twice, with Barry, an actual seller
    // on the contract, dropped entirely.
    //
    // The cause is that we cannot know WHICH parsed name the member's single
    // typed name corresponds to. "Jenny" is obviously Jennifer to a human and
    // deliberately not obviously anything to sameValue() (rule 1 forbids that
    // kind of guess). So when the first name disagrees, we stop: neither slot
    // is written, and the member is shown the full list off the contract
    // against what they have. Half-filling a party list is worse than not
    // filling it, because it looks complete.
    const isPrincipal = party === 'buyer' || party === 'seller';
    let primaryNameDisputed = false;
    if (isPrincipal && kinds.name && kinds.name.value) {
      const existingPrimary = row[cols.name];
      if (!isBlank(existingPrimary) && !partyNameAlreadyPresent(row, cols, kinds.name.value)) {
        primaryNameDisputed = true;
      }
    }

    for (const kind of Object.keys(kinds)) {
      const c = kinds[kind];

      // A principal name the record already carries — in either slot, alone or
      // inside a combined string — is agreement, not a conflict and not a
      // write. Checked before everything else so it can never become either.
      if (isPrincipal && (kind === 'name' || kind === 'name2') && c && c.value
        && partyNameAlreadyPresent(row, cols, c.value)) {
        continue;
      }

      if (primaryNameDisputed && kind === 'name2') {
        if (c && c.value) {
          rejected.push({
            party,
            kind,
            raw: c.value,
            reason: `not saved — the ${party} name on the contract disagrees with the dossier, so the order of the names is unresolved`,
          });
        }
        continue;
      }

      if (c && c.rejected) {
        rejected.push({ party, kind, raw: c.rejected, reason: `failed ${kind === 'email' ? 'email' : kind === 'phone' ? 'phone' : 'name'} validation` });
      }
      if (!c || c.value == null) continue;

      // An ambiguous broker block poisons only the agent identity fields.
      // The brokerage FIRM names are still usable -- if both blocks were read
      // as one, the firm name is wrong too, so drop those as well.
      if (suspect) {
        rejected.push({ party, kind, raw: c.value, reason: 'broker block ambiguous, not saved' });
        continue;
      }

      const destination = routeContact({ party, kind, side });
      const col = cols[kind];

      // --- Opposing principal: name on the record, contact details not on a
      // --- send target. Rule 4.
      if (destination === 'blocked') {
        partiesOut[party] = partiesOut[party] || {};
        // `contactable: false` is the marker packet-recipients.js reads to
        // extend its hand-typed-address blocklist. Without it, a member could
        // still type the buyer's address by hand and reach them.
        partiesOut[party].contactable = false;

        // NOT under `email`/`phone`, and that is deliberate.
        //
        // The browser writes deals back through mapAppTransactionToDb
        // (Dossie/src/utils/transactions.js), which contains:
        //     buyer_email: toStrOrNull(deal.buyerEmail || deal.parties?.buyer?.email)
        // — it PROMOTES parties.buyer.email into the buyer_email column. So
        // storing an opposing principal's address under the obvious key would
        // have quietly turned it into a send-target column the next time the
        // member saved that deal from the UI, defeating this entire branch by
        // a route nothing here controls.
        //
        // Under `contact_blocked` it is still readable for the blocklist and
        // for inbound mail matching (cron-email-to-dossier), and there is no
        // code path that can promote it into a sendable field.
        const blockedBag = partiesOut[party].contact_blocked || {};
        if (blockedBag[kind] !== c.value) {
          partiesOut[party].contact_blocked = { ...blockedBag, [kind]: c.value };
          partiesChanged = true;
        }
        blocked.push({
          party,
          kind,
          value: c.value,
          reason: side
            ? `${party === 'buyer' ? 'Buyer' : 'Seller'} is the other side's client on this deal — recorded, but never a send target.`
            : 'This dossier does not say which side you represent, so principal contact details were recorded but not made sendable.',
        });
        continue;
      }

      if (!col) continue;

      const existing = row[col];

      // --- Rule 1: a human value always wins.
      if (!isBlank(existing)) {
        if (!sameValue(existing, c.value)) {
          // For a principal's name, report EVERY name the contract lists, not
          // just the first. "The contract says Barry Whyte" is misleading when
          // the contract actually says "Barry Whyte, Jennifer Whyte" and the
          // member has "Jenny Whyte" -- they need the whole list to see that
          // one name is probably theirs and the other is a seller they are
          // missing.
          const everyParsed = (party === 'buyer' || party === 'seller') && kind === 'name' && kinds.name2 && kinds.name2.value
            ? [c.value, kinds.name2.value]
            : [c.value];
          const parsedLabel = everyParsed.join(' and ');
          conflicts.push({
            column: col,
            party,
            kind,
            existing: String(existing),
            parsed: c.value,
            parsed_all: everyParsed,
            source_field: c.field,
            source_block: c.block,
            document: c.doc,
            detail: everyParsed.length > 1
              ? `The contract lists the ${party} as ${parsedLabel}, but the dossier has ${existing}. Kept what was on the dossier and saved neither name — check whether one of them is the same person.`
              : `The contract says ${c.value} but the dossier already has ${existing}. Kept what was on the dossier.`,
          });
        }
        continue;
      }

      // Never write the same column twice from one extraction.
      if (Object.prototype.hasOwnProperty.call(updates, col)) continue;

      updates[col] = c.value;
      provenance[col] = {
        value: c.value,
        source_field: c.field,
        source_block: c.block,
        document_id: c.doc.document_id,
        file_name: c.doc.file_name,
        document_label: c.doc.document_label,
        scan_id: source.scanId || null,
        extracted_at: source.extractedAt || new Date().toISOString(),
        // Explicitly marks this value as machine-read. Anything without this
        // marker on the row was typed by a person and outranks it.
        origin: 'contract_scan',
      };
      filled.push({ column: col, party, kind, value: c.value });

      // Mirror into `parties` so the four existing consumers that read the
      // jsonb (cron-email-to-dossier, deal-watch-observe, cron-esign-events,
      // esign-draft-handoff) see it without each needing a column list.
      partiesOut[party] = partiesOut[party] || {};
      if (partiesOut[party][kind] !== c.value) {
        partiesOut[party][kind] = c.value;
        partiesChanged = true;
      }
    }
  }

  return {
    updates,
    parties: partiesChanged ? partiesOut : null,
    provenance,
    conflicts,
    blocked,
    rejected,
    filled,
    side,
  };
}

/**
 * One line the member can actually read, for chat or a scan result panel.
 * Returns null when nothing happened, so a caller can stay silent.
 */
function summarizePlan(plan) {
  if (!plan) return null;
  const bits = [];
  if (plan.filled.length) {
    const who = new Set(plan.filled.map((f) => f.party));
    const label = {
      buyer: 'buyer', seller: 'seller', buyerAgent: "buyer's agent",
      listingAgent: 'listing agent', title: 'title', lender: 'lender',
    };
    bits.push(`Saved contact details for ${[...who].map((w) => label[w] || w).join(', ')} off the contract.`);
  }
  if (plan.conflicts.length) {
    const n = plan.conflicts.length;
    bits.push(
      `${n} value${n === 1 ? '' : 's'} on the contract disagree${n === 1 ? 's' : ''} with what is already on the dossier — I left the dossier alone: ` +
      plan.conflicts.map((c) => c.detail).join(' '),
    );
  }
  if (plan.blocked.length) {
    const p = new Set(plan.blocked.map((b) => b.party));
    bits.push(`Recorded the ${[...p].join(' and ')} contact details but did not make them sendable — they are the other side's client.`);
  }
  return bits.length ? bits.join(' ') : null;
}

module.exports = {
  validateEmail,
  validatePhone,
  validateName,
  memberSide,
  routeContact,
  contactsFromExtraction,
  planContactWrites,
  summarizePlan,
  COLUMN_MAP,
  PARTY_KEYS,
};
