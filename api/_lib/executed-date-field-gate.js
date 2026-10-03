'use strict';
// api/_lib/executed-date-field-gate.js
//
// THE EXECUTED-DATE GATE.
//
// WHY IT EXISTS
// Every TREC contract/amendment that creates or modifies a binding agreement
// prints the same paragraph:
//   "EXECUTED the ___ day of ______________, 20___ (Effective Date).
//    (BROKER: FILL IN THE DATE OF FINAL ACCEPTANCE.)"
// That date is the date of FINAL ACCEPTANCE — when the last party signs and
// the instrument becomes binding. Every deadline in the deal (option period,
// financing contingency, closing) runs from it. A blank or wrong value there
// is not cosmetic.
//
// Twice in three days (2026-09-30 / 2026-10-02) a real client document shipped
// for e-signature through an ad-hoc one-off builder with NO fillable field
// for this paragraph at all — the line went out, and would have gone out,
// blank. This module is the hard backstop every send path has to cross from
// now on: it REFUSES the send outright (never a warning — see memory
// feedback_silent-failure-is-the-enemy.md) when either half of the rule is
// unmet:
//   1. A form that carries the EXECUTED paragraph must carry a fillable
//      field for it.
//   2. That field must be assigned to the signer who actually signs LAST —
//      not whoever happens to be first in the submitter list. That second
//      half is what would have caught both misses: a field present but
//      wired to the wrong signer looks fine at a glance.
//
// Never pre-stamp a value here. Never backdate to the first signature. This
// module only ever validates placement/assignment — it has no path that
// writes a date into anything.
//
// DETECTION, NOT A HARDCODED FORM-NUMBER LIST
// hasExecutedBlock() is a plain regex match against the document's own
// extracted text. Callers are responsible for extracting that text (see
// scripts/generate-executed-block-index.js for the committed-asset path, and
// each script's own pdftotext call for a document built fresh at send time).
// Nothing in this module hardcodes "20-19" or "39-11" — a form nobody has
// mapped yet is still caught the moment its real text is checked.
//
// DISTINGUISHING THE EXECUTED FIELD FROM THE PER-SIGNER "DATE SIGNED" FIELD
// Every mapped form already places a generic per-signer date field next to
// each signature (the signer's OWN signing timestamp, auto-filled by
// DocuSeal — see api/esign-create.js's resaleFormEntry / buildMappedFieldMap,
// 2026-09-21). That is a different, legitimate, pre-existing convention and
// must never be mistaken for satisfying this gate — it is per-SIGNER, this
// is per-DOCUMENT, and the one meaningful value (the LAST signer's own date)
// only coincidentally matches. The two are told apart by NAME: a field that
// names the EXECUTED/final-acceptance paragraph (EXECUTED_FIELD_NAME_RE)
// counts here; a bare "Buyer 1 Date" field does not.
//
// PARALLEL / RANDOM SIGNING ORDER
// If a submission's signers can sign in any order (DocuSeal order:'random'),
// there is no signer who is deterministically "last" — the gate cannot know
// who will actually sign the document into existence. Decided and documented
// here rather than guessed: in that case the EXECUTED field must be assigned
// to a broker/agent signer (the member's own side) if one is present in the
// envelope, because filling in the final-acceptance date is explicitly the
// broker's job per the form's own parenthetical. If no broker/agent signer
// is present either, there is no one the gate can safely hand the field to —
// it refuses and says exactly why, naming both missing pieces, rather than
// silently defaulting to the first signer (which is the exact failure mode
// this gate exists to close).
// ---------------------------------------------------------------------------

// Printed blanks extract as whitespace gaps on every form checked against
// this (TREC 20-19, 9-17, 39-11) — never require a trailing word boundary
// right after "20", since a literal underscore character immediately after
// (some renderers use "20__") is itself a word character and would silently
// fail a \b check there.
const EXECUTED_BLOCK_RE = /EXECUTED\s+the\b[\s\S]{0,80}?day\s+of\b[\s\S]{0,160}?,?\s*20/i;

/** True if the given extracted document text carries the EXECUTED paragraph. */
function hasExecutedBlock(text) {
  return typeof text === 'string' && EXECUTED_BLOCK_RE.test(text);
}

function isAgentOrBrokerRole(roleRaw) {
  const r = String(roleRaw || '').toLowerCase();
  return r.includes('agent') || r.includes('broker');
}

// A field counts as "the EXECUTED date" only if its own name/title names the
// block — never inferred from `type === 'date'` alone (see header).
const EXECUTED_FIELD_NAME_RE = /execut|final[\s_-]*acceptance|effective[\s_-]*date/i;

function isExecutedDateField(field) {
  return !!(field && typeof field.name === 'string' && EXECUTED_FIELD_NAME_RE.test(field.name));
}

/**
 * Pure decision function — no I/O, no network, no Supabase. Safe to run on
 * every send path.
 *
 * @param {object} opts
 * @param {string} opts.formLabel        name for error messages (file name / form name)
 * @param {boolean} opts.hasExecutedBlock whether THIS document's own text carries the paragraph
 * @param {Array}  opts.fields           the DocuSeal fields about to be sent for this document:
 *                                        [{ name, type, role, ... }]
 * @param {Array}  opts.signers          signers IN SENDING ORDER: [{ name, email, role }]
 * @param {string} [opts.signingOrder]   'sequential' (default) | 'random' | 'parallel'
 * @returns {{ ok: boolean, applicable: boolean, error?: string }}
 */
function checkExecutedDateFieldAssignment({ formLabel, hasExecutedBlock: applicable, fields, signers, signingOrder }) {
  const label = formLabel || 'This document';
  if (!applicable) return { ok: true, applicable: false };

  const execFields = (fields || []).filter(isExecutedDateField);

  if (execFields.length === 0) {
    return {
      ok: false,
      applicable: true,
      error: `${label} carries an EXECUTED (Effective Date) block, but no fillable date field `
        + `was placed for it. The date of final acceptance has to be captured live, at the moment `
        + `the last party signs — add day/month/year fields for it before sending. Refusing to send.`,
    };
  }

  const order = String(signingOrder || 'sequential').toLowerCase();
  const isParallel = order === 'random' || order === 'parallel';

  let requiredRole;
  if (isParallel) {
    const broker = (signers || []).find((s) => isAgentOrBrokerRole(s.role));
    if (!broker) {
      return {
        ok: false,
        applicable: true,
        error: `${label}: signing order is parallel/random, so no signer is guaranteed to sign `
          + `LAST — there is no one who can correctly date "final acceptance." Either send it with `
          + `sequential signing order so the actual last party signer can take the EXECUTED date `
          + `fields, or add the broker/agent as a signer (the date defaults to the member's own `
          + `side when the order can't determine a last party). Refusing to send.`,
      };
    }
    requiredRole = broker.role;
  } else {
    if (!signers || signers.length === 0) {
      return {
        ok: false,
        applicable: true,
        error: `${label}: cannot determine the last signer — no signers were provided. Refusing to send.`,
      };
    }
    requiredRole = signers[signers.length - 1].role || 'Signer';
  }

  const wrongRole = execFields.find((f) => f.role !== requiredRole);
  if (wrongRole) {
    const gotRoles = [...new Set(execFields.map((f) => f.role))].join(', ');
    return {
      ok: false,
      applicable: true,
      error: `${label}: the EXECUTED date field(s) are assigned to "${gotRoles}", but the date `
        + `of final acceptance must be filled by whoever signs LAST ("${requiredRole}") — not an `
        + `earlier signer in the list. A date entered by anyone else could predate the moment the `
        + `agreement actually becomes binding. Refusing to send.`,
    };
  }

  return { ok: true, applicable: true };
}

module.exports = {
  EXECUTED_BLOCK_RE,
  EXECUTED_FIELD_NAME_RE,
  hasExecutedBlock,
  isExecutedDateField,
  isAgentOrBrokerRole,
  checkExecutedDateFieldAssignment,
};
