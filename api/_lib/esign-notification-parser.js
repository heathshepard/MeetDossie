// api/_lib/esign-notification-parser.js
// =============================================================================
// Recognize and parse e-signature notification emails.
//
// Providers covered: Authentisign (Lone Wolf / zipForm), DocuSign, DocuSeal,
// Adobe Sign. Authentisign is the one that matters most — it is what Heath
// actually signs through, and it has NO webhook, so this email parse is the
// only signal we ever get about a packet sent from zipForm.
//
// DESIGN NOTE — why detection is deterministic but extraction is not:
// Sender domain is a hard, checkable fact, so provider detection is a strict
// allowlist. The BODY layout of these notifications is vendor-controlled and
// changes without notice, and I could not read live samples of every provider's
// format while building this. So rather than fabricate brittle regexes for
// formats I have not personally seen, the parser does regex extraction for the
// patterns that ARE confirmed, then optionally defers to an LLM pass for
// anything it could not pull out. Confirmed-by-observation patterns are marked
// CONFIRMED; the rest are best-effort and explicitly allowed to return null.
//
// CONFIRMED (Heath's live 104 Wild Cherry signing, 2026-08-13, Authentisign):
//   From:    secure@authentisign.com
//   Subject: "Signing updated ..."   body carries
//              "Action: Document Accepted"  and  "Participant: Thomas Linton"
//   Subject: "Signing complete: Amendment #1 - 104 Wild Cherry Ln"
//
// Everything returned here is a CLAIM by the provider. Nothing in this file
// proves a document was actually signed — that is signature-verifier.js's job.
//
// Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION)
// =============================================================================

'use strict';

// Sender allowlist. Domain match, so per-tenant subdomains still resolve.
const PROVIDER_DOMAINS = [
  { provider: 'authentisign', re: /(^|[@.])(authentisign\.com|lonewolf\.com|lwolf\.com)$/i },
  { provider: 'docusign', re: /(^|[@.])(docusign\.net|docusign\.com)$/i },
  { provider: 'docuseal', re: /(^|[@.])(docuseal\.com|docuseal\.co|docuseal\.eu)$/i },
  { provider: 'adobesign', re: /(^|[@.])(echosign\.com|adobesign\.com|adobe\.com)$/i },
];

// Action normalization. Order matters — 'completed' must win over 'signed'
// when a subject says "Signing complete", and 'declined' must never be read as
// a benign event.
const ACTION_PATTERNS = [
  { action: 'declined', re: /\b(declined|rejected|refused to sign)\b/i },
  { action: 'cancelled', re: /\b(cancell?ed|voided|revoked|withdrawn)\b/i },
  { action: 'completed', re: /\b(signing complete|signing is complete|completed|all parties have signed|fully executed|is complete)\b/i },
  { action: 'signed', re: /\b(signed|signature added|has signed|document signed)\b/i },
  { action: 'accepted', re: /\b(document accepted|accepted)\b/i },
  { action: 'viewed', re: /\b(viewed|opened|has viewed)\b/i },
  { action: 'sent', re: /\b(sent for signature|invitation sent|has been sent|awaiting signature)\b/i },
];

function domainOf(email) {
  const s = String(email || '').toLowerCase().trim();
  const at = s.lastIndexOf('@');
  return at === -1 ? '' : s.slice(at + 1);
}

/**
 * Which e-sign provider (if any) sent this?
 * @returns {string|null} provider key, or null if this is not an e-sign email
 */
function detectProvider(fromEmail) {
  const domain = domainOf(fromEmail);
  if (!domain) return null;
  for (const { provider, re } of PROVIDER_DOMAINS) {
    if (re.test(domain)) return provider;
  }
  return null;
}

/**
 * Normalize provider wording into our action enum.
 * Subject is weighted over body — "Signing complete: X" in the subject is the
 * authoritative statement, while the body often recaps earlier participant
 * actions and would otherwise pull the verdict backwards.
 */
function detectAction(subject, body) {
  const subj = String(subject || '');
  for (const { action, re } of ACTION_PATTERNS) {
    if (re.test(subj)) return action;
  }
  // Body's explicit "Action:" line (CONFIRMED Authentisign format).
  const actionLine = String(body || '').match(/^\s*Action\s*:\s*(.+)$/im);
  if (actionLine) {
    const val = actionLine[1].trim();
    for (const { action, re } of ACTION_PATTERNS) {
      if (re.test(val)) return action;
    }
  }
  const b = String(body || '').slice(0, 4000);
  for (const { action, re } of ACTION_PATTERNS) {
    if (re.test(b)) return action;
  }
  return 'other';
}

/**
 * Participant name. CONFIRMED Authentisign format is a "Participant: <name>"
 * line; the rest are best-effort.
 */
function extractParticipant(body) {
  const b = String(body || '');
  const patterns = [
    /^\s*Participant\s*:\s*(.+)$/im,              // CONFIRMED (Authentisign)
    /^\s*Signer\s*:\s*(.+)$/im,
    /^\s*Signed\s+by\s*:\s*(.+)$/im,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,2})\s+has\s+(?:signed|viewed|accepted|completed)\b/,
  ];
  for (const re of patterns) {
    const m = b.match(re);
    if (m && m[1]) {
      const name = m[1].trim().replace(/\s*<[^>]*>\s*$/, '').replace(/[.,;]$/, '').trim();
      if (name && name.length <= 120) return name;
    }
  }
  return null;
}

function extractParticipantEmail(body) {
  const m = String(body || '').match(/^\s*(?:Participant|Signer|Email)\s*:\s*[^<\n]*<([^>]+@[^>]+)>/im);
  if (m) return m[1].trim().toLowerCase();
  const m2 = String(body || '').match(/^\s*(?:Participant|Signer)\s+Email\s*:\s*([^\s<>]+@[^\s<>]+)/im);
  return m2 ? m2[1].trim().toLowerCase() : null;
}

/**
 * Document / signing name.
 * CONFIRMED: "Signing complete: Amendment #1 - 104 Wild Cherry Ln"
 */
function extractDocumentName(subject, body) {
  const subj = String(subject || '').trim();
  const subjPatterns = [
    /^Signing\s+complete\s*:\s*(.+)$/i,           // CONFIRMED (Authentisign)
    /^Signing\s+updated\s*[:-]\s*(.+)$/i,
    /^(?:Completed|Signed)\s*:\s*(.+)$/i,
    /^Please\s+(?:sign|DocuSign)\s*:\s*(.+)$/i,
    /^(.+?)\s+(?:is|has been)\s+(?:complete|completed|signed)$/i,
  ];
  for (const re of subjPatterns) {
    const m = subj.match(re);
    if (m && m[1]) {
      const name = m[1].trim().replace(/^["']|["']$/g, '');
      if (name) return name.slice(0, 300);
    }
  }
  const bodyPatterns = [
    /^\s*(?:Signing|Document|Envelope|Transaction)\s+Name\s*:\s*(.+)$/im,
    /^\s*Signing\s*:\s*(.+)$/im,
  ];
  for (const re of bodyPatterns) {
    const m = String(body || '').match(re);
    if (m && m[1]) return m[1].trim().slice(0, 300);
  }
  return subj ? subj.slice(0, 300) : null;
}

/**
 * Candidate document links, best first.
 *
 * These links EXPIRE (7 days on Authentisign) — that is precisely why the
 * pipeline must pull the bytes promptly and store its own copy. We return all
 * plausible candidates because provider emails carry tracking/unsubscribe URLs
 * alongside the real one, and the caller may need to try more than one.
 */
function extractDocumentLinks(body, provider) {
  const b = String(body || '');
  const urls = new Set();
  const urlRe = /https?:\/\/[^\s"'<>\)\]]+/g;
  let m;
  while ((m = urlRe.exec(b)) !== null) {
    urls.add(m[0].replace(/[.,;:]+$/, ''));
  }

  const NOISE = /(unsubscribe|privacy|terms|support|help|twitter|facebook|linkedin|youtube|\.png|\.jpg|\.gif|\.css|mailto:)/i;
  const STRONG = /(download|document|signing|envelope|completed|view|sign|attachment|\.pdf)/i;

  const scored = [...urls]
    .filter((u) => !NOISE.test(u))
    .map((u) => {
      let score = 0;
      if (STRONG.test(u)) score += 2;
      if (/\.pdf(\?|$)/i.test(u)) score += 3;
      if (provider && u.toLowerCase().includes(String(provider).slice(0, 6))) score += 1;
      return { url: u, score };
    })
    .sort((a, b2) => b2.score - a.score);

  return scored.map((s) => s.url).slice(0, 8);
}

/**
 * Parse an e-signature notification email.
 *
 * @param {object} msg
 * @param {string} msg.fromEmail
 * @param {string} msg.subject
 * @param {string} msg.body       text/plain preferred
 * @param {string} [msg.dateIso]
 * @returns {object|null} null when this is not an e-sign notification at all
 */
function parseEsignNotification({ fromEmail, subject, body, dateIso }) {
  const provider = detectProvider(fromEmail);
  if (!provider) return null;

  const action = detectAction(subject, body);

  return {
    provider,
    action,
    documentName: extractDocumentName(subject, body),
    participantName: extractParticipant(body),
    participantEmail: extractParticipantEmail(body),
    documentLinks: extractDocumentLinks(body, provider),
    eventAt: dateIso || new Date().toISOString(),
    subject: subject || null,
    // True only for the event that means "everyone is done" — the trigger for
    // retrieval + verification + raising an ask.
    isCompletion: action === 'completed',
    // Needs the agent's attention for a different reason.
    isNegative: action === 'declined' || action === 'cancelled',
  };
}

/**
 * Match a parsed notification to one of the agent's deals.
 *
 * Matching on the PROPERTY ADDRESS inside the document name is the reliable
 * signal here, because the sender is the provider (secure@authentisign.com),
 * never a counterparty — so cron-email-to-dossier.js's exact-sender match can
 * never work for these. That is the core reason this pipeline is separate.
 *
 * Deliberately conservative: an ambiguous match returns null and the event is
 * filed unmatched for the agent to see, rather than attached to the wrong deal.
 *
 * @param {object} parsed        output of parseEsignNotification
 * @param {Array} deals          [{ id, address, ... }]
 * @returns {{deal: object|null, confidence: string, reason: string}}
 */
function matchToDeal(parsed, deals) {
  const list = Array.isArray(deals) ? deals : [];
  if (!list.length) return { deal: null, confidence: 'none', reason: 'no active deals' };

  const haystack = `${parsed.documentName || ''} ${parsed.subject || ''}`.toLowerCase();
  if (!haystack.trim()) return { deal: null, confidence: 'none', reason: 'no document name to match on' };

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const hay = norm(haystack);

  const hits = [];
  for (const deal of list) {
    if (!deal || !deal.address) continue;
    // Street line only — "104 Wild Cherry Ln, Boerne, TX 78006" appears in the
    // signing name as "104 Wild Cherry Ln". Split on the comma BEFORE
    // normalizing, because norm() strips the comma that marks the boundary.
    const street = norm(String(deal.address).split(',')[0]);
    if (!street) continue;
    const streetNoSuffix = street
      .replace(/\b(ln|lane|dr|drive|rd|road|st|street|ct|court|blvd|ave|avenue|way|cir|circle|trl|trail|pkwy|pl|place)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (street && hay.includes(street)) {
      hits.push({ deal, confidence: 'high', reason: `document name contains "${street}"` });
      continue;
    }
    if (streetNoSuffix && streetNoSuffix.length >= 6 && hay.includes(streetNoSuffix)) {
      hits.push({ deal, confidence: 'medium', reason: `document name contains "${streetNoSuffix}"` });
      continue;
    }
    // House number + first street word, e.g. "104 wild".
    const parts = streetNoSuffix.split(' ');
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      const key = `${parts[0]} ${parts[1]}`;
      if (key.length >= 5 && hay.includes(key)) {
        hits.push({ deal, confidence: 'low', reason: `document name contains "${key}"` });
      }
    }
  }

  if (hits.length === 0) return { deal: null, confidence: 'none', reason: 'no deal address found in document name' };

  const best = ['high', 'medium', 'low'].map((c) => hits.filter((h) => h.confidence === c));
  for (const tier of best) {
    if (tier.length === 1) return tier[0];
    if (tier.length > 1) {
      return {
        deal: null,
        confidence: 'ambiguous',
        reason: `document name matched ${tier.length} deals — refusing to guess`,
      };
    }
  }
  return { deal: null, confidence: 'none', reason: 'no confident match' };
}

module.exports = {
  PROVIDER_DOMAINS,
  detectProvider,
  detectAction,
  extractParticipant,
  extractParticipantEmail,
  extractDocumentName,
  extractDocumentLinks,
  parseEsignNotification,
  matchToDeal,
};
