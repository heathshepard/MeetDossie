'use strict';

// api/_lib/support-ticket-classify.js
//
// WHY THIS EXISTS
//   2026-08-24, ticket 503a1d1b: Amanda Nuckles — a paying founding member —
//   filed a support ticket that said, in full, "How do I cancel my account?".
//   She self-selected ticket_type='bug' in the modal. Nobody replied. The
//   ticket is still status='open' today (2026-09-18) and she cancelled.
//
//   Two lessons are baked into this file:
//
//   1. THE SELF-SELECTED ticket_type IS A WEAK HINT, NOT THE ANSWER. Amanda's
//      row says 'bug'. It is not a bug. Any system that trusts ticket_type
//      would have auto-replied "thanks for the bug report, I'm on it" to a
//      customer who was trying to leave — which is worse than the silence
//      that actually happened. Content decides; ticket_type only breaks ties.
//
//   2. SOME TICKETS MUST NEVER GET AN AUTOMATED REPLY AT ALL. A cancellation,
//      a billing dispute, or an angry customer is a conversation Heath has to
//      have himself. ops-policy.js already names this class
//      ('pricing_demo_complaint_conversation', ALWAYS_HEATH, structurally
//      un-flaggable) — this classifier routes into it rather than inventing a
//      second opinion about what's safe.
//
// PURE BY DESIGN
//   No network, no DB, no env. classify() is a function of its arguments
//   only, so scripts/regression-support-ticket-triage.js can assert it
//   against all 18 real support_tickets rows without touching production or
//   sending anything.
//
// Owner: Carter, 2026-09-18

// ── Who is not a customer ──────────────────────────────────────────────────
// These addresses file tickets constantly (Quinn's daily audit writes 10+ rows
// per failing run) and must NEVER receive a customer-facing email. This is an
// allowlist-of-exclusions, not a heuristic — exact matches and one domain.
const INTERNAL_DOMAINS = new Set(['meetdossie.internal']);
const INTERNAL_EMAILS = new Set([
  'demo@meetdossie.com',
  'demo2@meetdossie.com',
  'quinn@meetdossie.internal',
  // Heath's own addresses — he files tickets to test the modal. Mailing him
  // an auto-ack from himself is pure noise.
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
]);
// ticket_type values written by internal tooling, never by the in-app modal
// (api/support.js only accepts bug|feature|help|other).
const INTERNAL_TICKET_TYPE_RE = /^(quinn|atlas|carter|ridge|sage|pierce|hadley)[-_]/i;

// ── Escalation-only content classes ────────────────────────────────────────
// Checked FIRST and in this order. Any hit here means: no automated reply,
// ever, regardless of what ticket_type says.

// A cancellation request. Deliberately narrow on the noun so "the cancel
// button doesn't work" stays a bug — see CANCEL_UI_CONTEXT_RE below.
const CANCELLATION_RE = [
  /\bcancel(?:l?ing|l?ed|lation)?\b[^.?!]{0,40}\b(?:my|our|the|this)?\s*(?:account|subscription|membership|plan|billing|service)\b/i,
  /\b(?:account|subscription|membership|plan)\b[^.?!]{0,40}\bcancel(?:l?ing|l?ed|lation)?\b/i,
  /\b(?:close|delete|deactivate|shut\s*down|terminate|end)\s+(?:my|our)\s+(?:account|subscription|membership)\b/i,
  /\b(?:stop|end)\s+(?:my|our|the)\s+(?:billing|subscription|payments?|charges?)\b/i,
  /\b(?:how\s+do\s+i|how\s+can\s+i|where\s+do\s+i)\b[^.?!]{0,30}\bcancel\b/i,
  /\b(?:not|no longer)\s+(?:going\s+to\s+)?(?:renew|renewing|continuing)\b/i,
  /\b(?:i|we)\s+(?:want|need|would like)\s+(?:to\s+)?(?:cancel|out|to get out)\b/i,
  /\bunsubscribe\s+me\b/i,
];
// If "cancel" only ever appears next to UI furniture, it's a bug report about
// a button — not somebody leaving. Used to veto a weak CANCELLATION hit.
const CANCEL_UI_CONTEXT_RE = /\bcancel\s*(?:button|link|dialog|modal|option|icon|tab|screen|page|flow)\b/i;

// A billing DISPUTE — money moved wrongly, or the customer is asking about
// money. Never auto-answered; ops-policy's pricing/complaint class.
//
// STRONG: unambiguously about the money itself. Escalates no matter what else
// the message says.
const BILLING_STRONG_RE = [
  /\b(?:charged|charge[ds]?)\s+(?:me\s+)?(?:twice|again|two|2|double)\b/i,
  /\bdouble[\s-]?(?:charged|billed)\b/i,
  /\b(?:refund|chargeback|dispute(?:d|ing)?\s+(?:the\s+)?charge)\b/i,
  /\b(?:wrong|incorrect|unexpected)\s+(?:amount|charge|invoice|bill|price)\b/i,
  /\b(?:why|what)\s+(?:am|was|are|were)\s+i\s+(?:being\s+)?(?:charged|billed)\b/i,
  /\b(?:price|pricing|cost|rate)\s+(?:went|going)\s+up\b/i,
];
// WEAK: merely REFERS to billing objects. "The Stripe checkout throws a 500
// when I update my card on file" mentions a card but is a defect report, not
// a dispute — and routing it to Heath with no acknowledgement would recreate
// the exact silence this pipeline exists to end. So a weak hit only escalates
// when there is NO defect language; otherwise it stays a bug and the
// 'payments' sensitive-area gate (below) stops any agent touching the code.
// Customer gets a receipt, Heath gets the diagnosis, nothing auto-edits
// payment handling. Found by scripts/regression-support-ticket-triage.js.
const BILLING_WEAK_RE = [
  /\b(?:my|the|this)\s+(?:invoice|receipt|bill|billing|card|payment)\b/i,
  /\bcredit\s*card\b/i,
];

// An unhappy customer. A templated "thanks for the report!" here reads as a
// machine brushing somebody off at the exact moment they were deciding
// whether to stay.
const UNHAPPY_RE = [
  /\b(?:frustrat\w+|infuriat\w+|aggravat\w+)\b/i,
  /\b(?:angry|furious|upset|annoyed|fed\s*up|sick\s+of)\b/i,
  /\b(?:disappoint\w+|unacceptable|ridiculous|useless|worthless|garbage|pathetic)\b/i,
  /\bwast(?:e|ing|ed)\s+(?:of\s+)?(?:my\s+)?(?:time|money)\b/i,
  /\b(?:still|again)\s+(?:not\s+working|broken|doesn'?t\s+work|happening)\b/i,
  /\b(?:third|3rd|fourth|4th|fifth|5th)\s+time\b/i,
  /\b(?:this\s+is\s+the\s+)?(?:second|2nd)\s+time\s+(?:this|it|i)\b/i,
  /\b(?:i'?m\s+)?(?:done|through)\s+with\s+(?:this|dossie|it)\b/i,
  /\b(?:switch\w*|mov\w+|go(?:ing)?)\s+(?:back\s+)?to\s+(?:another|a different|my old)\b/i,
  /\bnot\s+(?:worth|what\s+i\s+paid)\b/i,
];

// Legal / privacy / regulatory. Same rule: Heath, personally, every time.
const LEGAL_RE = [
  /\b(?:lawyer|attorney|legal\s+action|lawsuit|sue|suing|litigation)\b/i,
  /\b(?:gdpr|ccpa|right\s+to\s+be\s+forgotten|data\s+subject)\b/i,
  /\b(?:delete|erase|purge|remove)\s+(?:all\s+)?(?:my|our)\s+(?:data|information|records|personal)\b/i,
  /\b(?:trec|tree?c)\s+(?:complaint|violation)\b/i,
  /\b(?:report(?:ing)?\s+(?:you|this)\s+to|file\s+a\s+complaint)\b/i,
];

// ── Ordinary classes ───────────────────────────────────────────────────────

// A question about how the product works, or when something will exist.
// Asking is not requesting: "when will signatures be available" is a roadmap
// QUESTION, not a feature request, and definitely not a bug.
const QUESTION_RE = [
  /\bhow\s+(?:do|can|would)\s+(?:i|we|you)\b/i,
  /\bwhere\s+(?:do|can|is|are)\s+(?:i|we|it|the|my)\b/i,
  /\bis\s+there\s+(?:a\s+way|an?\s+option)\b/i,
  /\bwhat\s+(?:happens|does|is)\b/i,
  /\bwhen\s+will\b/i,
  /\bcan\s+(?:i|we|you)\s+(?:still|already)?\s*\b/i,
  /\bdo(?:es)?\s+(?:dossie|it|this)\s+(?:support|handle|do|have)\b/i,
];

// A request for something that does not exist yet. Features need Heath —
// never auto-dispatched as a fix (feedback_rust-auto-fix-bugs-not-features).
const FEATURE_RE = [
  /\b(?:can|could|would)\s+(?:you|we)\s+(?:please\s+)?add\b/i,
  /\b(?:please\s+)?add\s+(?:a|an|the|support)\b/i,
  /\b(?:feature\s+request|suggestion|idea)\b/i,
  /\b(?:would|it'?d)\s+(?:be\s+)?(?:nice|great|helpful|love)\b/i,
  /\b(?:i\s+)?wish\s+(?:it|dossie|this|there)\b/i,
  /\bability\s+to\b/i,
  /\bwould\s+love\s+(?:to\s+see|a|an|if)\b/i,
];

// Something that is supposed to work and doesn't.
const BUG_RE = [
  /\b(?:error|errors|erroring)\b/i,
  /\b(?:broken|breaks|breaking)\b/i,
  /\b(?:doesn'?t|does\s+not|won'?t|will\s+not|can'?t|cannot)\s+(?:work|load|save|open|let|show|display|upload|submit)\b/i,
  /\bnot\s+(?:working|loading|saving|showing|displaying|appearing|updating)\b/i,
  /\b(?:disappeared|vanished|missing|gone|blank|empty)\b/i,
  /\b(?:crash|crashes|crashed|freeze|frozen|hangs?|stuck)\b/i,
  /\b(?:http\s*)?(?:400|401|403|404|500|502|503)\b/,
  /\b(?:bug|glitch|defect)\b/i,
  /\b(?:wrong|incorrect|duplicate[ds]?)\s+(?:data|value|name|address|info|information|total|number)\b/i,
  /\breceiv(?:ing|ed)\s+an?\s+error\b/i,
];

// ── Sensitive areas: NEVER auto-fix, however obvious the fix looks ─────────
// Heath's standing rule. Each entry gets its own key so the escalation can
// tell him exactly WHICH tripwire fired, not just "it's sensitive".
const SENSITIVE_AREAS = [
  {
    key: 'auth',
    why: 'authentication / session / access control',
    patterns: [
      /\b(?:log\s*in|login|logged\s+in|log\s*out|logout|logged\s+out|sign\s*in|signin|sign\s*up|signup)\b/i,
      /\b(?:password|passcode|credentials?|magic\s+link|reset\s+link|verification\s+(?:code|email))\b/i,
      /\b(?:session|token|jwt|oauth|sso|2fa|mfa|two[\s-]factor)\b/i,
      /\b(?:permission|unauthorized|unauthorised|access\s+denied|forbidden|locked\s+out|can'?t\s+get\s+in)\b/i,
      /\b(?:seat|invite|invitation|team\s+member)\s+(?:access|permission)\b/i,
    ],
  },
  {
    key: 'payments',
    why: 'payments / Stripe / subscription state',
    patterns: [
      /\b(?:stripe|checkout|payment|paid|card\s+on\s+file|credit\s*card|invoice|receipt)\b/i,
      /\b(?:subscription|billing|charge[ds]?|billed|plan\s+(?:change|upgrade|downgrade))\b/i,
      /\b(?:coupon|discount|promo\s*code|trial)\b/i,
    ],
  },
  {
    key: 'contracts',
    why: 'contract generation / e-signature — a wrong field here is a legal document',
    patterns: [
      // Generation/filling of a contract, NOT merely uploading one. An upload
      // parse failure is ordinary product code; writing values INTO a TREC
      // form is not.
      /\b(?:generat\w+|fill\w*|populat\w+|auto-?fill\w*|draft\w*|produc\w+|creat\w+)\b[^.?!]{0,50}\b(?:contract|trec|addendum|amendment|form|packet|disclosure)\b/i,
      /\b(?:contract|trec|addendum|amendment|form|packet|disclosure)\b[^.?!]{0,50}\b(?:generat\w+|fill\w*|populat\w+|auto-?fill\w*)\b/i,
      /\b(?:e-?sign\w*|docuseal|docusign|signature|signatory|initials?|sign(?:ing|ed)\s+(?:the\s+)?(?:contract|document|packet|form))\b/i,
      /\bzipform\b/i,
    ],
  },
  {
    key: 'data_deletion',
    why: 'data deletion / apparent data loss — diagnose before touching, never "fix" blind',
    patterns: [
      /\b(?:delet\w+|eras\w+|wip\w+|purg\w+|remov\w+|lost|losing)\b[^.?!]{0,40}\b(?:data|records?|dossiers?|transactions?|clients?|documents?|files?|uploads?|history|everything)\b/i,
      /\b(?:data|records?|dossiers?|transactions?|clients?|documents?|files?)\b[^.?!]{0,40}\b(?:deleted|erased|wiped|disappeared|vanished|gone|lost)\b/i,
      /\b(?:all|every)\s+(?:my|our)\s+\w+\s+(?:is|are|were)\s+gone\b/i,
    ],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

function normalize(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function anyMatch(patterns, text) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0].slice(0, 80);
  }
  return null;
}

function isInternalSender(email, ticketType) {
  if (INTERNAL_TICKET_TYPE_RE.test(String(ticketType || ''))) return 'internal_ticket_type';
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  if (INTERNAL_EMAILS.has(e)) return 'internal_address';
  const domain = e.split('@')[1] || '';
  if (INTERNAL_DOMAINS.has(domain)) return 'internal_domain';
  return null;
}

/**
 * Which never-auto-fix tripwires does this ticket hit?
 * @returns {Array<{key:string, why:string, matched:string}>}
 */
function detectSensitiveAreas(text) {
  const hits = [];
  for (const area of SENSITIVE_AREAS) {
    const matched = anyMatch(area.patterns, text);
    if (matched) hits.push({ key: area.key, why: area.why, matched });
  }
  return hits;
}

// ── The classifier ─────────────────────────────────────────────────────────

/**
 * @param {object} ticket  a public.support_tickets row (or the subset
 *   { id, agent_email, ticket_type, message }).
 * @returns {{
 *   ticketClass: string,     // internal|cancellation|billing|unhappy|legal|question|feature|bug|unknown
 *   route: string,           // suppress_internal|heath_only|ack_only|ack_and_fix|ack_and_escalate
 *   mayAutoReply: boolean,
 *   mayAutoFix: boolean,
 *   sensitiveAreas: Array,
 *   reasons: string[],       // human-readable, stored on the ledger row
 *   typeHintUsed: boolean,   // true when ticket_type broke a tie
 *   overrodeTypeHint: boolean// true when CONTENT contradicted ticket_type
 * }}
 */
function classify(ticket) {
  const message = normalize(ticket && ticket.message);
  const ticketType = String((ticket && ticket.ticket_type) || '').trim().toLowerCase();
  const email = String((ticket && ticket.agent_email) || '').trim().toLowerCase();
  const reasons = [];

  // ── Gate 0: not a customer. Nothing downstream may email this sender.
  const internalReason = isInternalSender(email, ticketType);
  if (internalReason) {
    reasons.push(`sender is internal (${internalReason}: ${email || ticketType || 'n/a'}) — never receives a customer reply`);
    return {
      ticketClass: 'internal',
      route: 'suppress_internal',
      mayAutoReply: false,
      mayAutoFix: false,
      sensitiveAreas: [],
      reasons,
      typeHintUsed: false,
      overrodeTypeHint: false,
    };
  }

  // No address at all — there is nobody to acknowledge. Heath still hears it.
  if (!email) {
    reasons.push('no agent_email on the ticket — no recipient to acknowledge');
    return {
      ticketClass: 'unknown',
      route: 'heath_only',
      mayAutoReply: false,
      mayAutoFix: false,
      sensitiveAreas: detectSensitiveAreas(message),
      reasons,
      typeHintUsed: false,
      overrodeTypeHint: false,
    };
  }

  const sensitiveAreas = detectSensitiveAreas(message);
  // Computed once up front — several vetoes below need to know whether the
  // message contains real defect language.
  const defectSignal = anyMatch(BUG_RE, message);

  // ── Gate 1: escalation-only classes. CONTENT WINS OVER ticket_type here.
  // This is the gate Amanda's ticket needed and did not have.
  const escalations = [
    ['cancellation', CANCELLATION_RE, 'reads as a cancellation request'],
    ['legal', LEGAL_RE, 'reads as a legal / privacy / regulatory matter'],
    ['billing', BILLING_STRONG_RE, 'reads as a billing dispute'],
    ['unhappy', UNHAPPY_RE, 'reads as an unhappy customer'],
    ['billing', BILLING_WEAK_RE, 'reads as a question about billing'],
  ];
  for (const [cls, patterns, label] of escalations) {
    const matched = anyMatch(patterns, message);
    if (!matched) continue;
    // Veto: "the cancel button doesn't work" is a bug about a button.
    if (cls === 'cancellation' && CANCEL_UI_CONTEXT_RE.test(message) && !/\b(?:my|our)\s+(?:account|subscription|membership)\b/i.test(message)) {
      reasons.push(`cancellation wording present but only in UI context ("${matched}") — treated as a bug, not a departure`);
      continue;
    }
    // Veto: a weak billing reference plus real defect language is a DEFECT on
    // a billing screen, not a money dispute. It stays a bug (so the customer
    // gets a receipt) and the 'payments' sensitive-area gate below stops any
    // agent from touching the code.
    if (cls === 'billing' && patterns === BILLING_WEAK_RE && defectSignal) {
      reasons.push(`mentions billing ("${matched}") but the message reports a defect ("${defectSignal}") — treated as a bug in a protected area, not a money dispute`);
      continue;
    }
    reasons.push(`${label} — matched "${matched}"`);
    const overrode = ticketType === 'bug' || ticketType === 'feature';
    if (overrode) {
      reasons.push(`submitter selected ticket_type='${ticketType}', but content overrides the self-selected type`);
    }
    return {
      ticketClass: cls,
      route: 'heath_only',
      mayAutoReply: false,
      mayAutoFix: false,
      sensitiveAreas,
      reasons,
      typeHintUsed: false,
      overrodeTypeHint: overrode,
    };
  }

  // ── Gate 2: ordinary classes. Content first, ticket_type only as a tiebreak.
  const questionHit = anyMatch(QUESTION_RE, message);
  const featureHit = anyMatch(FEATURE_RE, message);
  const bugHit = defectSignal;

  let ticketClass = null;
  let typeHintUsed = false;

  // A question that also contains defect language ("how do I fix the error
  // where…") is a bug report phrased politely — bug wins. A question with no
  // defect language is a question.
  if (bugHit && !(questionHit && !bugHit)) {
    ticketClass = 'bug';
    reasons.push(`defect language — matched "${bugHit}"`);
  } else if (questionHit) {
    ticketClass = 'question';
    reasons.push(`asks how something works — matched "${questionHit}"`);
  } else if (featureHit) {
    ticketClass = 'feature';
    reasons.push(`requests something that does not exist — matched "${featureHit}"`);
  }

  // Feature wording beats a lone weak bug signal when the submitter also said
  // 'feature' in the modal.
  if (featureHit && ticketType === 'feature' && ticketClass !== 'feature') {
    ticketClass = 'feature';
    typeHintUsed = true;
    reasons.push(`feature wording plus submitter-selected ticket_type='feature'`);
  }

  if (!ticketClass) {
    if (ticketType === 'bug' || ticketType === 'feature') {
      ticketClass = ticketType;
      typeHintUsed = true;
      reasons.push(`no decisive content signal — fell back to submitter-selected ticket_type='${ticketType}'`);
    } else {
      ticketClass = 'unknown';
      reasons.push('no decisive content signal and no usable ticket_type');
    }
  }

  // ── Gate 3: routing.
  if (ticketClass === 'bug') {
    if (sensitiveAreas.length > 0) {
      reasons.push(
        `auto-fix BLOCKED — touches ${sensitiveAreas.map((a) => a.key).join(', ')}; ` +
        `these are escalated to Heath with the diagnosis however obvious the fix looks`
      );
      return {
        ticketClass,
        route: 'ack_and_escalate',
        mayAutoReply: true,
        mayAutoFix: false,
        sensitiveAreas,
        reasons,
        typeHintUsed,
        overrodeTypeHint: false,
      };
    }
    return {
      ticketClass,
      route: 'ack_and_fix',
      mayAutoReply: true,
      mayAutoFix: true,
      sensitiveAreas,
      reasons,
      typeHintUsed,
      overrodeTypeHint: false,
    };
  }

  // Features need Heath. Questions need a human answer. Unknown needs eyes.
  // All three still get a receipt — silence is what cost us Amanda.
  reasons.push(
    ticketClass === 'feature'
      ? 'features are never auto-built — receipt only, decision is Heath\'s'
      : 'needs a human answer — receipt only, surfaced to Heath'
  );
  return {
    ticketClass,
    route: 'ack_only',
    mayAutoReply: true,
    mayAutoFix: false,
    sensitiveAreas,
    reasons,
    typeHintUsed,
    overrodeTypeHint: false,
  };
}

// ── Acknowledgement copy ───────────────────────────────────────────────────
//
// heath-email-voice-profile.md: 1-3 sentences, "Hey X," / "Thanks, Heath".
// His own note is that drafts come out far too formal.
//
// HARD RULE: acknowledge receipt, promise nothing. No timeline, no "we'll
// have this fixed by", no claim it's already resolved. Heath is one person;
// an over-promise he can't meet is worse than a plain thank-you. Every line
// below is a statement of fact about right now, not a commitment.

const ACK_SUBJECTS = {
  bug: 'Got your bug report',
  feature: 'Got your suggestion',
  question: 'Got your question',
  unknown: 'Got your message',
};

const ACK_BODIES = {
  bug: (name) => `Hey ${name},\n\nThanks for flagging that — it's logged and in front of me.\n\nThanks,\nHeath`,
  feature: (name) => `Hey ${name},\n\nThanks for the suggestion — it's logged and in front of me.\n\nThanks,\nHeath`,
  question: (name) => `Hey ${name},\n\nGot your question — it's in front of me and I'll come back to you on it personally.\n\nThanks,\nHeath`,
  unknown: (name) => `Hey ${name},\n\nThanks for writing in — it's logged and in front of me.\n\nThanks,\nHeath`,
};

// "Brittney Smith" -> "Brittney"; "amanda@amandanuckles.com" -> "Amanda";
// nothing usable -> "there" (so the greeting is still "Hey there,").
function firstNameFor(fullName, email) {
  const fromName = String(fullName || '').trim().split(/\s+/)[0];
  if (fromName && /^[A-Za-z][A-Za-z'-]{1,30}$/.test(fromName)) {
    return fromName.charAt(0).toUpperCase() + fromName.slice(1);
  }
  const local = String(email || '').split('@')[0] || '';
  const cleaned = local.replace(/[._-].*$/, '').replace(/\d+/g, '');
  if (/^[A-Za-z]{2,30}$/.test(cleaned)) {
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
  }
  return 'there';
}

/**
 * @returns {{subject:string, bodyText:string}}
 */
function buildAck({ ticketClass, fullName, email }) {
  const cls = ACK_BODIES[ticketClass] ? ticketClass : 'unknown';
  const name = firstNameFor(fullName, email);
  return {
    subject: ACK_SUBJECTS[cls],
    bodyText: ACK_BODIES[cls](name),
  };
}

// Belt-and-suspenders on the copy itself: if anyone ever edits the templates
// above and slips a promise in, this catches it before the send. Called by
// the cron immediately before handing a body to Resend.
const PROMISE_RE = [
  /\bby\s+(?:tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end\s+of)\b/i,
  /\bwithin\s+\d+\s*(?:hour|day|week|business)/i,
  /\b(?:will\s+be|should\s+be|is)\s+(?:fixed|resolved|deployed|shipped|live|working)\b/i,
  /\b(?:already\s+)?(?:fixed|resolved|deployed|shipped)\b/i,
  /\b(?:we|i)\s+(?:guarantee|promise|assure)\b/i,
  /\b(?:24|48|72)\s*(?:hrs?|hours)\b/i,
  /\bnext\s+(?:release|deploy|update)\b/i,
];

function findPromise(bodyText) {
  const t = normalize(bodyText);
  for (const re of PROMISE_RE) {
    const m = t.match(re);
    if (m) return m[0];
  }
  return null;
}

module.exports = {
  classify,
  buildAck,
  findPromise,
  firstNameFor,
  detectSensitiveAreas,
  isInternalSender,
  INTERNAL_EMAILS,
  INTERNAL_DOMAINS,
  SENSITIVE_AREAS,
};
