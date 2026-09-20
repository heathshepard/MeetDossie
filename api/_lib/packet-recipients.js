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
 * Every address belonging to the party the member does NOT represent.
 * Used as a blocklist, so it errs toward listing more addresses rather than
 * fewer — a false positive here costs an explanatory message, a false
 * negative costs an improper contact with a represented party.
 */
function opposingPrincipalContacts(tx, side) {
  if (side === 'listing') {
    return [
      { name: tx.buyer_name, email: tx.buyer_email },
      { name: tx.buyer2_name, email: tx.buyer2_email },
      // There is no buyer_notice_email column — the ¶21 notice email lives on
      // the TREC form, not the deal record. buyer_email/buyer2_email are the
      // only addresses a buyer principal can actually have here.
    ].filter((c) => c.email);
  }
  if (side === 'buyer') {
    return [
      { name: tx.seller_name, email: tx.seller_email },
      { name: tx.seller2_name, email: tx.seller2_email },
      // Same as above: no seller_notice_email column exists.
    ].filter((c) => c.email);
  }
  return [];
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
    case 'listing_agent':
      raw = [{ name: tx.listing_agent_name, email: tx.listing_agent_email_addr }];
      break;
    case 'buyer_agent':
    case 'other_agent':
      raw = [{ name: tx.other_agent_name, email: tx.other_agent_email_addr }];
      break;
    case 'title':
      raw = [
        { name: tx.title_officer_name || tx.escrow_officer_name, email: tx.title_officer_email },
      ];
      break;
    case 'lender':
      raw = [{ name: tx.loan_officer_name || tx.lender_name, email: tx.loan_officer_email }];
      break;
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
 */
function packetDigest({ userId, transactionId, recipients, subject, documentIds }) {
  const payload = JSON.stringify({
    u: userId,
    t: transactionId,
    r: (recipients || []).map((x) => normEmail(x.email)).sort(),
    s: String(subject || ''),
    d: (documentIds || []).map(String).sort(),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
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
