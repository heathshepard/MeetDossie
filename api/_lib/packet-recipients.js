// api/_lib/packet-recipients.js
//
// Who a document packet may be sent to, and proof that a human approved it.
//
// Two separate jobs, kept together because they are the two halves of the
// same guarantee: the right person, approved by the member.
//
// ---------------------------------------------------------------------------
// 1. NEVER THE OTHER SIDE'S CLIENT
// ---------------------------------------------------------------------------
// Heath's standing rule, learned the hard way (memory:
// feedback_never-contact-represented-parties — disclosures were nearly sent
// straight to the Champies): the opposing agent's clients are NEVER a
// recipient. Everything for the other side routes through their agent. This
// is not a preference, it is how represented parties work, and getting it
// wrong is the kind of contact that draws a TREC complaint.
//
// So recipients are resolved from ROLES on the deal record, and the role a
// member may target depends on which side they represent:
//
//   member is listing side  -> own client = seller(s); opposing principal = buyer(s)
//   member is buyer side    -> own client = buyer(s);  opposing principal = seller(s)
//
// The opposing principal is unreachable by any route: not by role (there is
// no role name for them), and not by typing their address by hand — an
// explicit email is checked against every opposing-principal address on the
// record and refused on a match.
//
// ---------------------------------------------------------------------------
// 2. THE MEMBER CONFIRMS BEFORE ANYTHING SENDS
// ---------------------------------------------------------------------------
// A spoken sentence must never put mail in a client's inbox on its own. The
// send endpoint is therefore two-phase:
//
//   phase 1  preview -> resolves everything, sends NOTHING, returns a
//                       confirmation token that commits to the exact
//                       recipient + subject + document set
//   phase 2  send    -> requires that token back
//
// The token is an HMAC over a digest of the very thing that was shown. If any
// part of the packet changes between preview and send — a different
// recipient, a document added, a reworded subject — the digest changes, the
// token no longer verifies, and the member has to look at it again. That
// makes "what I approved" and "what went out" the same object by
// construction, rather than by us remembering to keep them in step.
//
// The token is signed server-side with a secret the browser never sees, so a
// client cannot mint one and skip the human.

const crypto = require('crypto');

// Roles a member may address. The opposing principal is deliberately absent —
// there is no spelling of this map that reaches them.
const ROLE_DEFS = {
  seller: { label: 'Seller', principal: true, side: 'listing' },
  buyer: { label: 'Buyer', principal: true, side: 'buyer' },
  listing_agent: { label: 'Listing agent', principal: false },
  buyer_agent: { label: "Buyer's agent", principal: false },
  other_agent: { label: 'Cooperating agent', principal: false },
  title: { label: 'Title / escrow officer', principal: false },
  lender: { label: 'Lender / loan officer', principal: false },
  compliance: { label: 'Brokerage compliance', principal: false },
  self: { label: 'Yourself', principal: false },
};

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,}$/;

function isEmail(e) {
  return EMAIL_RE.test(String(e || '').trim());
}

/**
 * Which side the member represents on this deal.
 * `role` is the authoritative column ('listing' | 'buyer'); transaction_type
 * is a fallback for older rows where role was never set.
 */
function memberSide(tx) {
  const role = String(tx.role || '').toLowerCase();
  if (role === 'listing' || role === 'seller') return 'listing';
  if (role === 'buyer') return 'buyer';
  const tt = String(tx.transaction_type || '').toLowerCase();
  if (tt.includes('listing') || tt.includes('seller') || tt.includes('landlord')) return 'listing';
  if (tt.includes('buyer') || tt.includes('purchase') || tt.includes('tenant')) return 'buyer';
  return null;
}

/**
 * The `parties` jsonb, safely. Written by the contract scan (both the browser
 * document-upload path and api/_lib/contact-persistence.js) in the shape
 * { buyer|seller|buyerAgent|listingAgent|title|lender: {name,email,phone,...} }.
 */
function partyBlock(tx, key) {
  const p = tx && tx.parties && typeof tx.parties === 'object' && !Array.isArray(tx.parties) ? tx.parties : {};
  const block = p[key];
  return block && typeof block === 'object' && !Array.isArray(block) ? block : {};
}

/**
 * Every address belonging to the party the member does NOT represent.
 * Used as a blocklist, so it errs toward listing more addresses rather than
 * fewer — a false positive here costs an explanatory message, a false
 * negative costs an improper contact with a represented party.
 *
 * 2026-09-20 — also reads `parties`. The contract scan records an opposing
 * principal's ¶21 notice address there (marked `contactable: false`) and
 * deliberately keeps it OUT of buyer_email/seller_email so it can never be
 * resolved as a recipient by role. That is the right call for the role path,
 * but it left this hand-typed-address check blind to the very address the
 * scan had just read: a member who typed the buyer's address in by hand would
 * have sailed straight past it. Reading both sources closes that.
 */
function opposingPrincipalContacts(tx, side) {
  const out = [];
  const add = (name, email) => { if (email) out.push({ name, email }); };

  const addBlock = (key, fallbackName) => {
    const b = partyBlock(tx, key);
    add(b.name || fallbackName, b.email);
    add(b.name2 || fallbackName, b.email2);
    // The contract scan files an opposing principal's ¶21 notice address here
    // rather than under `email`, precisely so nothing can promote it into a
    // sendable column. It is still an address belonging to the other side's
    // client, so it still belongs on the blocklist.
    const blockedBag = b.contact_blocked && typeof b.contact_blocked === 'object' ? b.contact_blocked : {};
    add(b.name || fallbackName, blockedBag.email);
  };

  if (side === 'listing') {
    add(tx.buyer_name, tx.buyer_email);
    add(tx.buyer2_name, tx.buyer2_email);
    addBlock('buyer', tx.buyer_name);
    return out;
  }
  if (side === 'buyer') {
    add(tx.seller_name, tx.seller_email);
    add(tx.seller2_name, tx.seller2_email);
    addBlock('seller', tx.seller_name);
    return out;
  }
  return out;
}

/**
 * Resolve a role to concrete recipients off the transaction row.
 * Returns { ok, recipients: [{name,email,role,roleLabel}], error }.
 *
 * `profile` supplies compliance/self, which live on the member not the deal.
 */
function resolveRoleRecipients({ tx, profile, role }) {
  const def = ROLE_DEFS[role];
  if (!def) {
    return { ok: false, error: `I don't know a party called "${role}" on this deal.` };
  }

  const side = memberSide(tx);
  const label = def.label;

  // A principal role is only addressable when it is the member's OWN client.
  if (def.principal) {
    if (!side) {
      return {
        ok: false,
        error:
          'This dossier does not say which side you represent, so I will not email a client off it. ' +
          'Set the side on the dossier and ask me again.',
      };
    }
    if (def.side !== side) {
      const theirs = side === 'listing' ? 'buyer' : 'seller';
      const agentRole = side === 'listing' ? "buyer's agent" : 'listing agent';
      return {
        ok: false,
        blocked: 'opposing_principal',
        error:
          `The ${theirs} is the other side's client on this deal — I can't email them directly. ` +
          `Send it to the ${agentRole} instead and they'll pass it on.`,
      };
    }
  }

  // 2026-09-20 — every non-principal role falls back to the `parties` jsonb.
  //
  // This was a split brain, and it is the reason Dossie could read a buyer's
  // agent off a contract and still say she had no address for them. The
  // browser's document-upload scan (dossie-app.jsx handleUploadDocument)
  // writes agent contacts ONLY into `parties.buyerAgent` / `parties.listingAgent`
  // — mapAppTransactionToDb never writes other_agent_email_addr or
  // listing_agent_email_addr at all. This resolver read only those columns. So
  // on every deal scanned through the UI the address was on file and
  // unreachable at the same time.
  //
  // The flat column stays FIRST: it is what a member types in the deal record,
  // and rule one everywhere in this feature is that a human value outranks a
  // parsed one. The jsonb is the fallback, not the override.
  const pick = (...cands) => cands.find((c) => c && c.email && isEmail(c.email)) || cands[0] || {};

  let raw = [];
  switch (role) {
    case 'seller':
      raw = [
        { name: tx.seller_name, email: tx.seller_email },
        { name: tx.seller2_name, email: tx.seller2_email },
      ];
      break;
    case 'buyer':
      raw = [
        { name: tx.buyer_name, email: tx.buyer_email },
        { name: tx.buyer2_name, email: tx.buyer2_email },
      ];
      break;
    case 'listing_agent': {
      const p = partyBlock(tx, 'listingAgent');
      raw = [pick(
        { name: tx.listing_agent_name, email: tx.listing_agent_email_addr },
        { name: tx.listing_agent_name || p.name, email: p.email },
      )];
      break;
    }
    case 'buyer_agent':
    case 'other_agent': {
      const p = partyBlock(tx, 'buyerAgent');
      raw = [pick(
        { name: tx.other_agent_name, email: tx.other_agent_email_addr },
        { name: tx.other_agent_name || p.name, email: p.email },
      )];
      break;
    }
    case 'title': {
      const p = partyBlock(tx, 'title');
      raw = [pick(
        { name: tx.title_officer_name || tx.escrow_officer_name, email: tx.title_officer_email },
        { name: tx.title_officer_name || tx.escrow_officer_name || p.name, email: p.email },
      )];
      break;
    }
    case 'lender': {
      const p = partyBlock(tx, 'lender');
      raw = [pick(
        { name: tx.loan_officer_name || tx.lender_name, email: tx.loan_officer_email },
        { name: tx.loan_officer_name || tx.lender_name || p.name, email: p.email },
      )];
      break;
    }
    case 'compliance':
      raw = [{ name: profile.brokerage ? `${profile.brokerage} compliance` : 'Compliance', email: profile.compliance_email }];
      break;
    case 'self':
      raw = [{ name: profile.full_name || 'You', email: profile.email }];
      break;
    default:
      raw = [];
  }

  const recipients = raw
    .filter((r) => r.email && isEmail(r.email))
    .map((r) => ({
      name: (r.name && String(r.name).trim()) || null,
      email: String(r.email).trim(),
      role,
      roleLabel: label,
    }));

  if (!recipients.length) {
    return {
      ok: false,
      error:
        `I don't have an email address for the ${label.toLowerCase()} on this dossier. ` +
        'Add it to the deal record and I\'ll send it.',
    };
  }

  return { ok: true, recipients };
}

/**
 * Last line of defence for a hand-typed address: refuse it if it belongs to
 * the other side's client, whatever role was claimed for it.
 */
function assertNotOpposingPrincipal({ tx, email }) {
  const side = memberSide(tx);
  const blocked = opposingPrincipalContacts(tx, side);
  const target = normEmail(email);
  const hit = blocked.find((c) => normEmail(c.email) === target);
  if (!hit) return { ok: true };
  const agentRole = side === 'listing' ? "buyer's agent" : 'listing agent';
  const who = hit.name ? String(hit.name).trim() : String(email);
  return {
    ok: false,
    blocked: 'opposing_principal',
    error:
      `${who} is the other side's client on this deal — I can't email them directly. ` +
      `Route it through the ${agentRole}.`,
  };
}

// ---------------------------------------------------------------------------
// Confirmation tokens
// ---------------------------------------------------------------------------

// Signed with a server-only secret. SUPABASE_SERVICE_ROLE_KEY is already
// present on every deployment that can send, and never reaches the browser.
// A dedicated PACKET_CONFIRM_SECRET overrides it when one is configured.
function signingSecret() {
  const secret = process.env.PACKET_CONFIRM_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error('No signing secret available for packet confirmation.');
  return secret;
}

// 20 minutes: long enough to read a document list and think about it, short
// enough that a token left in a stale tab is useless.
const TOKEN_TTL_MS = 20 * 60 * 1000;

/**
 * A stable digest of everything the member is being shown. Recipients are
 * sorted so ordering noise doesn't invalidate a token; document ids are
 * sorted for the same reason.
 *
 * `counts` (optional, 2026-09-21) — per-document per-signer field counts for
 * an e-signature packet (api/esign-packet-send.js). Digesting them closes a
 * specific replay: without this, a preview taken from a clean, correctly
 * paired document could be replayed with `document_ids` left unchanged but
 * the underlying document swapped for a different revision between preview
 * and send — same ids, same recipients, different (possibly unpaired)
 * fields. `send-compliance-packet.js` never passes this field, so its
 * digest is unaffected (an empty array digests identically to omitted).
 */
function packetDigest({ userId, transactionId, recipients, subject, documentIds, counts }) {
  const payload = JSON.stringify({
    u: userId,
    t: transactionId,
    r: (recipients || []).map((x) => normEmail(x.email)).sort(),
    s: String(subject || ''),
    d: (documentIds || []).map(String).sort(),
    c: canonicalizeCounts(counts),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Deterministic ordering so the same counts always digest the same way
// regardless of object key iteration order or array construction order.
function canonicalizeCounts(counts) {
  if (!Array.isArray(counts) || counts.length === 0) return [];
  return counts
    .map((c) => ({
      d: String(c.document_id || ''),
      r: String(c.role || ''),
      sig: Number(c.signatures) || 0,
      dt: Number(c.dates) || 0,
      ini: Number(c.initials) || 0,
    }))
    .sort((a, b) => (a.d + a.r).localeCompare(b.d + b.r));
}

function issueConfirmationToken(parts) {
  const digest = packetDigest(parts);
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const body = `${digest}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', signingSecret()).update(body).digest('hex');
  return `${body}.${sig}`;
}

/**
 * Verify a token against the packet about to be sent.
 *
 * Failure modes are reported distinctly because they mean different things to
 * the member: expired => look again, mismatch => the packet CHANGED since you
 * approved it, which is the case worth being loud about.
 */
function verifyConfirmationToken(token, parts) {
  const raw = String(token || '');
  const bits = raw.split('.');
  if (bits.length !== 3) return { ok: false, reason: 'malformed' };
  const [digest, expiresRaw, sig] = bits;

  const body = `${digest}.${expiresRaw}`;
  let expected;
  try {
    expected = crypto.createHmac('sha256', signingSecret()).update(body).digest('hex');
  } catch (e) {
    return { ok: false, reason: 'unconfigured' };
  }

  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    return { ok: false, reason: 'expired' };
  }

  if (packetDigest(parts) !== digest) {
    return { ok: false, reason: 'packet_changed' };
  }

  return { ok: true };
}

module.exports = {
  ROLE_DEFS,
  memberSide,
  opposingPrincipalContacts,
  resolveRoleRecipients,
  assertNotOpposingPrincipal,
  issueConfirmationToken,
  verifyConfirmationToken,
  packetDigest,
  isEmail,
  normEmail,
  TOKEN_TTL_MS,
};
