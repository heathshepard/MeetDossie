'use strict';

// api/_lib/inconsistency-flow.js
// =============================================================================
// SHE RAISES IT. HE DECIDES. THEN SHE WORKS OUT THE REMEDY.
// =============================================================================
//
// Heath's spec, verbatim (2026-09-20):
//
//   "She just needs to bring up any inconsistencies because we won't know which
//    is right. The user needs to choose which is right and then Dossie needs to
//    decide the next course of action. Amendment etc."
//
// Three steps, and the order is the whole design:
//
//   1. SURFACE  — Dossie names the disagreement and both values, with sources.
//   2. CHOOSE   — the MEMBER says which is correct. Dossie does not.
//   3. REMEDY   — Dossie works out what has to happen now, which depends
//                 entirely on WHERE the wrong value currently lives.
//
// -----------------------------------------------------------------------------
// WHAT THIS MODULE MUST NEVER DO
// -----------------------------------------------------------------------------
// It must never pick a winner. Not by confidence score, not by a
// document-precedence rule ("the executed contract always wins"), not by
// recency. That design was proposed and rejected. The reason is not politeness,
// it is that the information needed to decide is not in the database:
//
//   - "Jenny Whyte" (dossier) vs "Jennifer Whyte" (contract) — one person with
//     a nickname, or two different people?
//   - If it IS one person, which spelling is her LEGAL name? Only a human who
//     has seen her driver's licence knows.
//   - If the dossier is right, the executed contract is wrong, and that is a
//     $0-to-catastrophic problem depending on the field.
//
// A document-precedence rule gets the live 23 Nopalito case right by accident
// and the inverse case — a contract typed with the wrong party name, which is
// exactly the 2026-08-12 Wild Cherry repair amendment — silently wrong.
//
// -----------------------------------------------------------------------------
// WHY "WHERE DOES THE WRONG VALUE LIVE" IS THE INTERESTING HALF
// -----------------------------------------------------------------------------
// The naive remedy for "the contract says Jennifer, the dossier says Jenny, and
// Jenny is right" is "update the dossier." That is backwards. If Jenny is right
// then the EXECUTED CONTRACT carries a name that is not this seller's legal
// name, and the remedy is an amendment signed by all parties.
//
// Heath's standing rule (memory:feedback_verify-contract-elections-before-execution):
//
//   "fix it by amendment signed by all parties — never by checking the box on
//    the signed instrument, which alters an executed document and creates two
//    versions."
//
// So the same member answer produces completely different work depending on
// whether the wrong value sits in a dossier column, an unsigned draft, an
// executed instrument, or a copy already filed with a title company.
//
// -----------------------------------------------------------------------------
// SURFACING IS NOT NAGGING
// -----------------------------------------------------------------------------
// api/_lib/regression-alert-policy.js is the cautionary tale in this codebase:
// an unconditional daily alert on an unchanging failure set is trained out
// inside a week, which reproduces the exact blindness with extra steps. The fix
// there was delta-based — speak when the news is new — and it cut 12 alerts to
// 2.
//
// Same discipline here. A conflict is raised ONCE when the member opens the
// deal, and then stays quiet. It speaks again only when something genuinely
// changed: the field is now about to be written into a document (where the
// consequence is immediate), or the conflict got worse. See shouldSurface().
//
// PURE ON PURPOSE. No fetch, no Supabase, no Date.now() that is not passed in.
// The I/O half is api/_lib/inconsistency-flow-store.js. Reasoning about an
// alert path in your head is how regression-alert-policy stayed broken for two
// months; this one has api/_lib/inconsistency-flow.test.js instead.
//
// Owner: 2026-09-20.

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Where a wrong value can live. This enum IS the remedy routing table's key.
// ---------------------------------------------------------------------------
const SITE = {
  DOSSIER: 'dossier_record',              // a transactions column, ours to fix
  DOC_UNEXECUTED: 'document_unexecuted',  // drafted, not yet signed
  DOC_EXECUTED: 'document_executed',      // signed — may NEVER be altered
  THIRD_PARTY: 'third_party_filed',       // title co / brokerage compliance has a copy
};

const REMEDY = {
  UPDATE_FIELD: 'update_dossier_field',
  CORRECT_RESEND: 'correct_and_resend',
  AMENDMENT: 'amendment_required',
  NOTIFY_THIRD_PARTY: 'notify_third_party',
  RECORD_EQUIVALENCE: 'record_equivalence',
  NONE: 'no_action',
};

const CHOICE = {
  DOSSIER: 'dossier',    // the value on my dossier is correct
  DOCUMENT: 'document',  // the value on the document is correct
  SAME: 'same',          // they are the same person/thing — neither is wrong
  OTHER: 'other',        // both are wrong, here is the right one
  NOT_NOW: 'not_now',    // defer; not a resolution
};

const SEVERITY_ORDER = ['low', 'normal', 'high', 'critical'];

// ---------------------------------------------------------------------------
// FIELD CONSEQUENCE CLASSES — the "how did you rank it" answer
// ---------------------------------------------------------------------------
// Ranking is a property of the FIELD first (what breaks if it is wrong), then
// escalated by WHERE the wrong value lives (an executed instrument is worse
// than a draft), then by WHEN we noticed (about to be used is worse than idle).
//
// OPERATIVE: the field is a term of the deal or identifies a party to it. Get
// it wrong on a signed instrument and you have a defective instrument —
// enforceability, title, and the commission all hang off these.
const OPERATIVE_COLUMNS = new Set([
  'buyer_name', 'buyer2_name', 'seller_name', 'seller2_name',
  'property_address', 'city_state_zip', 'legal_description',
  'sale_price', 'earnest_money', 'earnest_money_amount',
  'option_fee', 'option_fee_amount', 'option_days',
  'closing_date', 'contract_effective_date', 'possession_date',
]);

// NOTICE: not a term of the deal, but legal notice and money movement are
// delivered here. A wrong title officer email does not void a contract; it does
// lose a notice deadline and it is how wire fraud lands.
const NOTICE_COLUMNS = new Set([
  'other_agent_email_addr', 'other_agent_phone_no',
  'title_officer_email', 'title_officer_phone', 'title_company',
  'lender_name', 'loan_officer_email', 'loan_officer_phone',
  'buyer_email', 'buyer_phone', 'seller_email', 'seller_phone',
]);

function isPartyNameColumn(col) {
  return /^(buyer|seller)2?_name$/.test(String(col || ''));
}

function fieldClass(column) {
  const col = String(column || '');
  if (OPERATIVE_COLUMNS.has(col)) return 'operative';
  if (NOTICE_COLUMNS.has(col)) return 'notice';
  return 'informational';
}

// ---------------------------------------------------------------------------
// HOW THE TWO VALUES DIFFER — this is what separates signal from a middle initial
// ---------------------------------------------------------------------------
// Heath: "a wrong party name on an executed contract matters; a middle initial
// probably does not." So classify the SHAPE of the difference, and let that
// pull the severity down — but only for differences that genuinely cannot
// change who or what is meant.

const SUFFIX_RE = /\b(?:jr|sr|ii|iii|iv|v|md|phd|esq|esquire|dds|cpa|trustee)\b\.?/gi;

// A standalone single letter, WITH its trailing period. The period must be
// consumed: an earlier version used /\b[a-z]\.?\b/ and the trailing `\b` could
// not match after ".", so "Clark L. Champie" stripped to "Clark . Champie" and
// the leftover period made it compare unequal to "Clark Champie" — which then
// fell through to 'extra_party' and ranked a middle initial as a missing human
// being. Caught by the test, not by reading it.
const MIDDLE_INITIAL_RE = /(?:^|\s)[a-z]\.?(?=\s|$)/gi;

function tokens(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function stripAll(s, re) {
  return String(s == null ? '' : s).replace(re, ' ').replace(/\s+/g, ' ').trim();
}

function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9@.]/g, '');
}

/**
 * Classify the difference between two values.
 *
 * Returns one of:
 *   'identical'          — normalises equal (should already have been suppressed)
 *   'suffix_only'        — differ only by Jr/Sr/III/trustee
 *   'middle_initial_only'— differ only by a single-letter middle name
 *   'nickname_candidate' — share a substantial leading stem and diverge after
 *                          ("Jenny" / "Jennifer", "Bob" / "Robert" will NOT hit
 *                          this and that is correct — it is not detectable)
 *   'extra_party'        — one side names people the other does not
 *   'different'          — no relationship we can see; could be the wrong person
 *
 * Deliberately conservative: anything it cannot explain is 'different', which
 * ranks HIGHER. A misclassification must fail toward raising, never toward
 * silence. memory:feedback_silent-failure-is-the-enemy.
 */
function classifyDifference(a, b) {
  if (norm(a) === norm(b)) return 'identical';

  if (norm(stripAll(a, SUFFIX_RE)) === norm(stripAll(b, SUFFIX_RE))) return 'suffix_only';

  if (norm(stripAll(a, MIDDLE_INITIAL_RE)) === norm(stripAll(b, MIDDLE_INITIAL_RE))) {
    return 'middle_initial_only';
  }

  const ta = tokens(a);
  const tb = tokens(b);

  // One side lists a whole extra human being. That is not a spelling question,
  // it is a missing party, and it is always worth raising.
  //
  // The extra token must actually look like a NAME. Without that guard a
  // middle initial or a "Jr" reads as an extra person — which is how
  // "Clark L. Champie" vs "Clark Champie" once ranked as a missing party.
  if (ta.length !== tb.length) {
    const shared = ta.filter((t) => tb.includes(t)).length;
    const longer = ta.length > tb.length ? ta : tb;
    const shorter = ta.length > tb.length ? tb : ta;
    const extras = longer.filter((t) => !shorter.includes(t));
    const namelike = extras.some((t) => t.replace(/\./g, '').length >= 2 && !SUFFIX_RE.test(t));
    SUFFIX_RE.lastIndex = 0; // global regex — .test() leaves state behind
    if (shared > 0 && shared >= shorter.length && namelike) return 'extra_party';
  }

  // Same token count, exactly one token differs, and that token shares a
  // 4+ character stem with its counterpart. "jennifer whyte" vs "jenny whyte":
  // surname matches, given names share "jenn". A human has to tell us whether
  // that is one woman or two.
  if (ta.length === tb.length && ta.length > 0) {
    const diffIdx = [];
    for (let i = 0; i < ta.length; i += 1) if (ta[i] !== tb[i]) diffIdx.push(i);
    if (diffIdx.length === 1) {
      const x = ta[diffIdx[0]];
      const y = tb[diffIdx[0]];
      let stem = 0;
      while (stem < x.length && stem < y.length && x[stem] === y[stem]) stem += 1;
      if (stem >= 4) return 'nickname_candidate';
      if (stem >= 2 && Math.min(x.length, y.length) <= 5) return 'nickname_candidate';
    }
  }

  return 'different';
}

// A difference shape that cannot change WHO or WHAT is meant. These are the
// only ones allowed to pull severity down.
const COSMETIC_SHAPES = new Set(['suffix_only', 'middle_initial_only']);

function bump(sev, by) {
  const i = SEVERITY_ORDER.indexOf(sev);
  const j = Math.max(0, Math.min(SEVERITY_ORDER.length - 1, (i < 0 ? 1 : i) + by));
  return SEVERITY_ORDER[j];
}

function atLeast(sev, floor) {
  return SEVERITY_ORDER.indexOf(sev) >= SEVERITY_ORDER.indexOf(floor) ? sev : floor;
}

// ---------------------------------------------------------------------------
// Stable id, so a resolution can name the conflict it resolved
// ---------------------------------------------------------------------------
// Derived from content rather than assigned, because conflicts live inside a
// jsonb array that gets appended to and sliced (-50) — an index would drift and
// a resolution would silently re-point at a different conflict.
function conflictId(c) {
  const basis = [
    c && c.column, c && c.party, c && c.kind,
    c && c.existing, c && c.parsed,
    c && c.document && c.document.document_id,
  ].map((x) => String(x == null ? '' : x)).join('|');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// STEP 1 — SURFACE
// ---------------------------------------------------------------------------

function humanField(column, party, kind) {
  const col = String(column || '');
  const pretty = {
    buyer_name: 'Buyer', buyer2_name: 'Buyer (second)',
    seller_name: 'Seller', seller2_name: 'Seller (second)',
    sale_price: 'Sale price', closing_date: 'Closing date',
    earnest_money: 'Earnest money', option_fee: 'Option fee',
    option_days: 'Option period', property_address: 'Property address',
    title_company: 'Title company', title_officer_email: 'Title officer email',
    other_agent_name: "Other agent", other_agent_email_addr: "Other agent's email",
    other_broker_name: "Other agent's brokerage",
  }[col];
  if (pretty) return pretty;
  if (party && kind) return `${party} ${kind}`;
  return col || 'this field';
}

/**
 * Turn one raw `contact_provenance._conflicts` entry plus the evidence about
 * where its values live into something a member can act on.
 *
 * `evidence` is assembled by the store half and describes only FACTS:
 *   { documents: [{ document_id, file_name, label, executed, executed_at,
 *                   signer_names, verdict }],
 *     thirdPartySends: [{ recipient_role, sent_to_name, sent_at }],
 *     dossierValue: <current column value> }
 *
 * Execution state comes from esign_events (verification_verdict='signed'),
 * never from documents.signature_status — that column reads 'none' on all 357
 * live rows including the executed 23 Nopalito contract, so trusting it would
 * route every executed instrument down the "just edit it" path.
 * memory:feedback_poll-system-of-record-not-notifications.
 */
function describeConflict(conflict, evidence = {}, opts = {}) {
  const c = conflict || {};
  const id = conflictId(c);
  const docs = Array.isArray(evidence.documents) ? evidence.documents : [];
  const sends = Array.isArray(evidence.thirdPartySends) ? evidence.thirdPartySends : [];

  // A conflict with no column is a structural warning (a broker block read
  // twice), not a two-values-disagree question. It has no "which is right".
  if (!c.column) {
    return {
      conflict_id: id,
      kind: 'structural',
      column: null,
      field_label: 'Contract read-back problem',
      severity: 'high',
      severity_reason: 'Dossie could not tell two blocks of the contract apart, so she saved neither value.',
      difference: null,
      message: c.detail || 'Something on this contract read back ambiguously.',
      dossier: null,
      document: null,
      choices: [],
      answerable: false,
    };
  }

  const difference = classifyDifference(c.existing, c.parsed);
  const cls = fieldClass(c.column);

  const executedDocs = docs.filter((d) => d && d.executed);
  const draftDocs = docs.filter((d) => d && !d.executed);

  // --- severity ----------------------------------------------------------
  // Base on what the field does.
  let severity = cls === 'operative' ? 'high' : cls === 'notice' ? 'normal' : 'low';
  const reasons = [];
  reasons.push(cls === 'operative'
    ? 'it is a term of the deal or names a party to it'
    : cls === 'notice'
      ? 'legal notice and funds are delivered using it'
      : 'it is a record-keeping field');

  // A cosmetic-shaped difference genuinely cannot change who is meant.
  if (COSMETIC_SHAPES.has(difference)) {
    severity = bump(severity, -2);
    reasons.push(difference === 'suffix_only'
      ? 'the two values differ only by a name suffix'
      : 'the two values differ only by a middle initial');
  }

  // But a party name on an EXECUTED instrument is Heath's own example of the
  // thing that matters, and it outranks any cosmetic discount.
  if (executedDocs.length) {
    severity = bump(severity, 1);
    reasons.push(`the value Dossie read sits on an executed document (${executedDocs[0].label || executedDocs[0].file_name})`);
    if (isPartyNameColumn(c.column)) {
      severity = atLeast(severity, 'critical');
      reasons.push('a party name on a signed instrument can only be fixed by amendment');
    }
  }

  // A copy already outside the member's control cannot be quietly corrected.
  if (sends.length) {
    severity = bump(severity, 1);
    reasons.push(`a copy has already gone to ${sends.map((s) => s.sent_to_name || s.recipient_role).filter(Boolean).join(', ') || 'a third party'}`);
  }

  // The field is about to be written into a document right now.
  if (opts.aboutToUse) {
    severity = bump(severity, 1);
    reasons.push('this field is about to be written into a document');
  }

  // Missing party is never cosmetic.
  if (difference === 'extra_party') {
    severity = atLeast(severity, 'high');
    reasons.push('one side names a person the other does not, so a party may be missing');
  }

  // --- presentation ------------------------------------------------------
  const srcDoc = docs.find((d) => d && d.document_id === (c.document && c.document.document_id)) || null;
  const docLabel = srcDoc
    ? `${srcDoc.label || srcDoc.file_name}${srcDoc.executed && srcDoc.executed_at ? `, signed ${shortDate(srcDoc.executed_at)}` : srcDoc.executed ? ', signed' : ' (not signed yet)'}`
    : ((c.document && (c.document.document_label || c.document.file_name)) || 'a document on this file');

  const field = humanField(c.column, c.party, c.kind);

  // Both values, both sources, no verdict. That is the whole job of step 1.
  const message =
    `${field}: ${docLabel} says ${c.parsed}, your dossier says ${c.existing}. `
    + (difference === 'nickname_candidate'
      ? 'Those could be the same person — I can\'t tell. Which is right?'
      : difference === 'extra_party'
        ? 'One of those lists someone the other doesn\'t. Which is right?'
        : 'Which is right?');

  const choices = [
    { choice: CHOICE.DOSSIER, label: `My dossier is right — ${c.existing}`, value: c.existing },
    { choice: CHOICE.DOCUMENT, label: `The document is right — ${c.parsed}`, value: c.parsed },
  ];
  // "They're the same person" was the actual answer on BOTH live conflicts
  // (23 Nopalito and 29046 Pfeiffers Gate, 2026-09-20). It is neither of the
  // two obvious options and leaving it out forces a wrong answer.
  if (c.kind === 'name' || isPartyNameColumn(c.column)) {
    choices.push({
      choice: CHOICE.SAME,
      label: 'Same person — different spelling',
      value: null,
      needs_legal_name: true,
    });
  }
  choices.push({ choice: CHOICE.OTHER, label: 'Neither — let me type the right one', value: null, needs_value: true });
  choices.push({ choice: CHOICE.NOT_NOW, label: 'Not now', value: null });

  return {
    conflict_id: id,
    kind: 'value_disagreement',
    column: c.column,
    party: c.party || null,
    field_label: field,
    severity,
    severity_reason: reasons.join('; '),
    difference,
    message,
    dossier: { value: c.existing, source: 'your dossier' },
    document: {
      value: c.parsed,
      all_values: Array.isArray(c.parsed_all) && c.parsed_all.length > 1 ? c.parsed_all : null,
      document_id: (c.document && c.document.document_id) || null,
      source: docLabel,
      block: c.source_block || null,
      field: c.source_field || null,
      executed: Boolean(srcDoc && srcDoc.executed),
    },
    sites: describeSites({ conflict: c, evidence }),
    choices,
    answerable: true,
  };
}

function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * Every place either value currently lives. Facts only — no remedy yet.
 * This is what step 3 routes on.
 */
function describeSites({ conflict, evidence }) {
  const c = conflict || {};
  const docs = Array.isArray(evidence.documents) ? evidence.documents : [];
  const sends = Array.isArray(evidence.thirdPartySends) ? evidence.thirdPartySends : [];
  const out = [];

  if (!isBlankish(evidence.dossierValue)) {
    out.push({ site: SITE.DOSSIER, holds: String(evidence.dossierValue), column: c.column });
  }
  for (const d of docs) {
    out.push({
      site: d.executed ? SITE.DOC_EXECUTED : SITE.DOC_UNEXECUTED,
      holds: c.parsed,
      document_id: d.document_id,
      label: d.label || d.file_name,
      executed_at: d.executed_at || null,
      signer_names: d.signer_names || null,
    });
  }
  for (const s of sends) {
    out.push({
      site: SITE.THIRD_PARTY,
      holds: c.parsed,
      recipient: s.sent_to_name || s.recipient_role || 'third party',
      recipient_role: s.recipient_role || null,
      sent_at: s.sent_at || null,
    });
  }
  return out;
}

function isBlankish(v) {
  return v == null || String(v).trim() === '' || String(v).trim() === '{}';
}

// ---------------------------------------------------------------------------
// STEP 2 -> STEP 3 — THE REMEDY ROUTING TABLE
// ---------------------------------------------------------------------------
/**
 * Given the member's answer, decide what has to happen — and to what.
 *
 * ROUTING TABLE (site of the WRONG value -> remedy):
 *
 *   dossier_record        -> update_dossier_field    (ours; just fix it)
 *   document_unexecuted   -> correct_and_resend      (regenerate, re-sign)
 *   document_executed     -> amendment_required      (all parties sign; the
 *                                                     instrument is NEVER edited)
 *   third_party_filed     -> notify_third_party      (their copy is still wrong)
 *
 * The remedies COMPOSE — one answer routinely produces several — and they are
 * returned in dependency order: the amendment gates everything downstream,
 * because until it is executed the dossier should not claim the new value is
 * the contract's value.
 *
 * The critical branch is CHOICE.SAME. "They're the same person" means NO
 * instrument is wrong, so it must not produce an amendment. Answering
 * "my dossier is right" on the same pair of values MUST. Same data, opposite
 * work — which is precisely why a human has to answer and Dossie may not guess.
 *
 * @param {object} args
 * @param {object} args.described   output of describeConflict()
 * @param {string} args.choice      one of CHOICE
 * @param {string} [args.value]     required for CHOICE.OTHER; for CHOICE.SAME,
 *                                  optionally the legal spelling to normalise to
 * @param {string} [args.note]      the member's own words, kept verbatim
 * @param {string} [args.now]       ISO timestamp (injected, never read)
 */
function routeRemedy({ described, choice, value = null, note = null, now = null }) {
  const d = described || {};
  const at = now || new Date().toISOString();

  if (choice === CHOICE.NOT_NOW) {
    return {
      ok: true, resolved: false, conflict_id: d.conflict_id,
      choice, correct_value: null, remedies: [],
      summary: 'Left open. I\'ll bring it up again when it matters.',
      resolution_record: null,
    };
  }

  const dossierValue = d.dossier && d.dossier.value;
  const documentValue = d.document && d.document.value;

  let correct = null;
  if (choice === CHOICE.DOSSIER) correct = dossierValue;
  else if (choice === CHOICE.DOCUMENT) correct = documentValue;
  else if (choice === CHOICE.OTHER) correct = value;
  else if (choice === CHOICE.SAME) correct = value || null; // optional legal spelling
  else {
    return { ok: false, error: `Unknown choice "${choice}".` };
  }

  if (choice !== CHOICE.SAME && isBlankish(correct)) {
    return { ok: false, error: 'I need the correct value before I can work out what to do about it.' };
  }

  const sites = Array.isArray(d.sites) ? d.sites : [];
  const remedies = [];

  // -----------------------------------------------------------------------
  // CHOICE.SAME — the equivalence answer. Nothing is WRONG, so nothing gets
  // amended. This is the branch a document-precedence rule cannot express.
  // -----------------------------------------------------------------------
  if (choice === CHOICE.SAME) {
    remedies.push({
      remedy: REMEDY.RECORD_EQUIVALENCE,
      site: SITE.DOSSIER,
      why: 'You confirmed these are the same party, so no document is wrong and nothing needs amending.',
      detail: `Recorded that "${dossierValue}" and "${documentValue}" are the same party on this file. `
        + 'I won\'t raise this pair again.',
      action: null,
    });
    // If they told us which spelling is the legal one AND the dossier holds the
    // other, align the dossier to it — a records change only, never a document
    // change, because by definition the document is not wrong here.
    if (!isBlankish(value) && norm(value) !== norm(dossierValue)) {
      remedies.push({
        remedy: REMEDY.UPDATE_FIELD,
        site: SITE.DOSSIER,
        why: 'The dossier held the informal spelling; you named the legal one.',
        detail: `Set ${d.field_label} to "${value}" on the dossier. No document changes — the document was already correct.`,
        action: { type: 'update_field', column: d.column, value },
      });
    }
    return finish({ d, choice, correct: value || documentValue, note, at, remedies, equivalence: [dossierValue, documentValue] });
  }

  // -----------------------------------------------------------------------
  // A real correction. Walk every site and ask: does it hold the wrong value?
  // -----------------------------------------------------------------------
  const executed = sites.filter((s) => s.site === SITE.DOC_EXECUTED && norm(s.holds) !== norm(correct));
  const drafts = sites.filter((s) => s.site === SITE.DOC_UNEXECUTED && norm(s.holds) !== norm(correct));
  const dossierWrong = sites.some((s) => s.site === SITE.DOSSIER && norm(s.holds) !== norm(correct));
  const thirdParty = sites.filter((s) => s.site === SITE.THIRD_PARTY && norm(s.holds) !== norm(correct));

  // 1. EXECUTED — the gating remedy. You may never alter an executed
  //    instrument; the correction is a new instrument all parties sign.
  for (const s of executed) {
    remedies.push({
      remedy: REMEDY.AMENDMENT,
      site: SITE.DOC_EXECUTED,
      document_id: s.document_id || null,
      why: `${s.label || 'That document'} is executed${s.executed_at ? ` (signed ${shortDate(s.executed_at)})` : ''}, `
        + `and it carries "${s.holds}". An executed instrument can never be edited — correcting it in place would `
        + 'create two versions of a signed document.',
      detail: `${d.field_label} on the executed document reads "${s.holds}", but you've confirmed it should be `
        + `"${correct}". That takes an amendment signed by all parties`
        + `${s.signer_names ? ` (${s.signer_names})` : ''}. I've drafted one — it is a DRAFT and I have not sent it.`,
      action: {
        type: 'draft_amendment',
        amendment_type: isPartyNameColumn(d.column) ? 'party_name' : amendmentTypeForColumn(d.column),
        column: d.column,
        original_value: s.holds,
        new_value: correct,
        notes: note || null,
      },
      blocking: true,
    });
  }

  // 2. UNEXECUTED — cheap. Fix the draft and re-send it before anyone signs
  //    the wrong thing.
  for (const s of drafts) {
    remedies.push({
      remedy: REMEDY.CORRECT_RESEND,
      site: SITE.DOC_UNEXECUTED,
      document_id: s.document_id || null,
      why: `${s.label || 'That document'} has not been signed yet, so it can still simply be corrected.`,
      detail: `Regenerate ${s.label || 'the document'} with ${d.field_label} as "${correct}", then re-send it for `
        + 'signature. Nothing is sent until you say so.',
      action: {
        type: 'correct_document',
        document_id: s.document_id || null,
        column: d.column,
        value: correct,
      },
    });
  }

  // 3. DOSSIER — always last of the "ours to fix" set, because if an amendment
  //    is pending the dossier should not yet claim the amended value is the
  //    contract's value.
  if (dossierWrong) {
    remedies.push({
      remedy: REMEDY.UPDATE_FIELD,
      site: SITE.DOSSIER,
      why: 'The dossier record holds the value you rejected.',
      detail: executed.length
        ? `Set ${d.field_label} to "${correct}" on the dossier once the amendment is executed — until then the `
          + 'contract still legally says something else.'
        : `Set ${d.field_label} to "${correct}" on the dossier.`,
      action: { type: 'update_field', column: d.column, value: correct },
      deferred_until: executed.length ? 'amendment_executed' : null,
    });
  }

  // 4. THIRD PARTY — their copy does not fix itself.
  for (const s of thirdParty) {
    remedies.push({
      remedy: REMEDY.NOTIFY_THIRD_PARTY,
      site: SITE.THIRD_PARTY,
      why: `A copy carrying "${s.holds}" already went to ${s.recipient}${s.sent_at ? ` on ${shortDate(s.sent_at)}` : ''}, `
        + 'so correcting your own records leaves theirs wrong.',
      detail: `Draft a correction notice to ${s.recipient} with the corrected ${d.field_label}`
        + `${executed.length ? ', to go out with the executed amendment' : ''}. Draft only — not sent.`,
      action: {
        type: 'draft_third_party_notice',
        recipient_role: s.recipient_role || null,
        recipient: s.recipient,
        column: d.column,
        value: correct,
      },
    });
  }

  if (!remedies.length) {
    remedies.push({
      remedy: REMEDY.NONE,
      site: null,
      why: 'Everything on this file already carries the value you picked.',
      detail: 'Nothing to change. Recorded your answer so I stop asking.',
      action: null,
    });
  }

  return finish({ d, choice, correct, note, at, remedies, equivalence: null });
}

function amendmentTypeForColumn(column) {
  return {
    closing_date: 'closing_date',
    sale_price: 'price_change',
    option_days: 'option_extension',
  }[String(column || '')] || 'other';
}

function finish({ d, choice, correct, note, at, remedies, equivalence }) {
  const headline = remedies.find((r) => r.remedy === REMEDY.AMENDMENT)
    ? 'This one needs an amendment.'
    : remedies.find((r) => r.remedy === REMEDY.CORRECT_RESEND)
      ? 'The document can still be corrected before signature.'
      : remedies.find((r) => r.remedy === REMEDY.RECORD_EQUIVALENCE)
        ? 'Nothing to amend — noted.'
        : 'Records-only fix.';

  return {
    ok: true,
    resolved: true,
    conflict_id: d.conflict_id,
    column: d.column,
    choice,
    correct_value: correct,
    headline,
    summary: `${headline} ${remedies.map((r) => r.detail).join(' ')}`.trim(),
    remedies,
    // What gets written to contact_provenance._resolutions. Replaces the
    // hand-written `_resolved_by_heath` array on the live Pfeiffers and
    // Nopalito rows, which has two different shapes in one array (`field` on
    // one entry, `column` on the next) because it was typed by hand.
    resolution_record: {
      conflict_id: d.conflict_id,
      column: d.column,
      choice,
      correct_value: correct,
      rejected_value: choice === CHOICE.DOSSIER ? (d.document && d.document.value)
        : choice === CHOICE.DOCUMENT ? (d.dossier && d.dossier.value)
          : null,
      equivalent_values: equivalence,
      note: note || null,
      remedies: remedies.map((r) => r.remedy),
      resolved_at: at,
      resolved_by: 'member',
    },
  };
}

// ---------------------------------------------------------------------------
// SURFACING POLICY — raise once, at the moment it matters
// ---------------------------------------------------------------------------
/**
 * Should this conflict be put in front of the member on THIS trigger?
 *
 * Pure, and modelled on api/_lib/regression-alert-policy.js: speak when the
 * news is new. A conflict raised on Monday and still unanswered on Tuesday is
 * NOT news on Tuesday — re-raising it every time the deal is opened is the
 * alert-fatigue failure that made a two-month-red regression suite invisible.
 *
 * Triggers:
 *   'deal_open'     — the member opened the deal. Raise the first time only,
 *                     unless it got worse or a snooze expired.
 *   'document_gate' — the field is about to be written into a document. Always
 *                     raise at or above 'normal', every time, because the
 *                     consequence is immediate and about to become permanent.
 *                     This is the same shape as contract-election-gate.js:
 *                     stop, a human decides.
 *   'scan'          — a fresh scan just produced it. Raise if it is new.
 *
 * @param {object} args
 * @param {object} args.described
 * @param {object|null} args.ledgerEntry  { first_raised_at, raise_count,
 *                                          last_severity, snoozed_until }
 * @param {string} args.trigger
 * @param {string} args.now  ISO
 */
function shouldSurface({ described, ledgerEntry = null, trigger = 'deal_open', now }) {
  const d = described || {};
  const nowMs = Date.parse(now || new Date().toISOString());
  const sev = d.severity || 'low';
  const rank = SEVERITY_ORDER.indexOf(sev);

  // The floor. A cosmetic difference on a record-keeping field, sitting only in
  // a dossier column nobody is about to use, is not worth a member's attention.
  // It stays in the record so it can be shown if they go looking.
  const onExecuted = (d.sites || []).some((s) => s.site === SITE.DOC_EXECUTED);
  if (sev === 'low' && !onExecuted && trigger !== 'document_gate') {
    return { surface: false, reason: 'below_attention_floor' };
  }

  if (trigger === 'document_gate') {
    if (rank < SEVERITY_ORDER.indexOf('normal')) {
      return { surface: false, reason: 'cosmetic_at_gate' };
    }
    // Deliberately ignores the ledger. The field is about to be committed to
    // paper; "we already mentioned it" is not a reason to let it through.
    return { surface: true, reason: 'about_to_be_used_in_a_document', blocking: rank >= SEVERITY_ORDER.indexOf('high') };
  }

  if (!ledgerEntry || !ledgerEntry.first_raised_at) {
    return { surface: true, reason: 'not_raised_before' };
  }

  // It got worse since we last mentioned it — that IS news.
  const prevRank = SEVERITY_ORDER.indexOf(ledgerEntry.last_severity || 'low');
  if (rank > prevRank) {
    return { surface: true, reason: 'severity_escalated' };
  }

  if (ledgerEntry.snoozed_until && Date.parse(ledgerEntry.snoozed_until) <= nowMs) {
    return { surface: true, reason: 'snooze_expired' };
  }

  return { surface: false, reason: 'already_raised_and_unchanged' };
}

/**
 * Whole-deal pass. Returns the conflicts to raise now, worst first, plus the
 * ones deliberately held back and why — so "why didn't you tell me" always has
 * an answer.
 */
function reviewDeal({ conflicts = [], evidenceFor, ledger = {}, resolutions = [], trigger = 'deal_open', now, aboutToUseColumns = null }) {
  const resolvedIds = new Set(
    (Array.isArray(resolutions) ? resolutions : [])
      .map((r) => r && r.conflict_id).filter(Boolean),
  );
  // Legacy hand-written resolutions (`_resolved_by_heath`) carry no
  // conflict_id, only a column. Honour them by column so Heath's 2026-09-20
  // answers are not asked again.
  const resolvedColumns = new Set(
    (Array.isArray(resolutions) ? resolutions : [])
      .filter((r) => r && !r.conflict_id)
      .map((r) => r && (r.column || r.field)).filter(Boolean),
  );

  const raise = [];
  const held = [];

  for (const c of (Array.isArray(conflicts) ? conflicts : [])) {
    if (!c) continue;
    const aboutToUse = Array.isArray(aboutToUseColumns)
      ? aboutToUseColumns.includes(c.column)
      : false;
    const described = describeConflict(
      c,
      typeof evidenceFor === 'function' ? (evidenceFor(c) || {}) : {},
      { aboutToUse },
    );

    if (resolvedIds.has(described.conflict_id) || (described.column && resolvedColumns.has(described.column))) {
      held.push({ conflict_id: described.conflict_id, column: described.column, reason: 'already_resolved' });
      continue;
    }
    if (trigger === 'document_gate' && Array.isArray(aboutToUseColumns) && !aboutToUse) {
      held.push({ conflict_id: described.conflict_id, column: described.column, reason: 'not_a_field_this_document_uses' });
      continue;
    }

    const verdict = shouldSurface({
      described,
      ledgerEntry: ledger[described.conflict_id] || null,
      trigger,
      now,
    });
    if (verdict.surface) {
      raise.push({ ...described, surface_reason: verdict.reason, blocking: Boolean(verdict.blocking) });
    } else {
      held.push({ conflict_id: described.conflict_id, column: described.column, reason: verdict.reason, severity: described.severity });
    }
  }

  raise.sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));
  return { raise, held, trigger };
}

/** One speakable line for chat. Null when there is nothing to say. */
function speak(review) {
  const list = (review && review.raise) || [];
  if (!list.length) return null;
  if (list.length === 1) return list[0].message;
  const worst = list[0];
  return `${worst.message} There ${list.length === 2 ? 'is 1 other' : `are ${list.length - 1} other`} `
    + `${list.length === 2 ? 'mismatch' : 'mismatches'} on this file too.`;
}

module.exports = {
  SITE,
  REMEDY,
  CHOICE,
  SEVERITY_ORDER,
  classifyDifference,
  fieldClass,
  isPartyNameColumn,
  conflictId,
  describeConflict,
  describeSites,
  routeRemedy,
  shouldSurface,
  reviewDeal,
  speak,
  amendmentTypeForColumn,
};
