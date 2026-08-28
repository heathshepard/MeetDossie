// api/_lib/pre-send-field-audit.js
// =============================================================================
// Deterministic pre-send field audit — step 3 of the e-sign productization
// plan (memory: dossie-esign-productization-plan.md). Runs between fill-form
// and esign-create. Free (no model call): reads the write ledger that
// safeSetText/safeCheck (fill-form.js) and drawFieldText/check (fill-trec-
// 20-19.js) already populate via ./fill-ledger, and asks one question — did
// every field this form type calls CRITICAL (fill-form-required-fields.js)
// actually land on the generated PDF, given the source data had a real value
// for it?
//
// WHY THIS EXISTS: safeSetText/safeCheck/drawFieldText all swallow the
// underlying pdf-lib error for the good reason that most fields are
// optional. That means a field-name mismatch (TREC republishes a form and
// renames/repositions a field) or an outright wrong coordinate map silently
// drops a value and the endpoint still returns 200. This module is the gate
// that turns "silently dropped" into "blocked, with a reason a human can
// act on" for the fields that are financially/legally material — sale
// price, closing date, earnest money, option fee/days, etc.
//
// SCOPE, STATED HONESTLY: this only has real coverage for fields the ledger
// can attribute to a stable semantic name. Today that's every text field
// fill-trec-20-19.js draws for the TREC 20-19 resale contract (drawFieldText
// is already called with the exact `fill-form-required-fields.js` names —
// sale_price, closing_date, earnest_money, option_fee, option_period_days).
// Fields that only drive a checkbox election through an internal, PDF-
// revision-specific widget name (financing_type, title_policy_paid_by) do
// NOT get blocked on — there is no stable semantic name to alias them to
// without hardcoding the current TREC 20-19 asset's widget names into this
// module, which would silently go stale exactly the way the bug this module
// exists to catch does. Those fields are reported as `untracked` so callers
// know the difference between "verified" and "not checked", never conflating
// the two. Extend COVERAGE by having more handlers call recordAttempt(name)
// with a stable semantic key — no changes needed here when they do; coverage
// is read live off the ledger, not a hardcoded list in this file.
//
// Owner: Carter, 2026-08-27
// =============================================================================

'use strict';

const { getRequiredFieldsForFormType, fieldNameToPrompt } = require('./fill-form-required-fields');

// A required field's value can legitimately arrive under more than one
// source key, or be written under a different literal name than
// fill-form-required-fields.js calls it. List every alias that could carry
// this field's value or its ledger write record. Fields not listed here
// alias to themselves.
const FIELD_ALIASES = {
  option_days: ['option_days', 'option_period_days'],
};

function aliasesFor(field) {
  return FIELD_ALIASES[field] || [field];
}

function hasRealValue(v) {
  return !(v === null || v === undefined || v === '' || (typeof v === 'boolean' && v === false));
}

/**
 * @param {object} opts
 * @param {string} opts.formType       fill-form.js form_type (e.g. 'resale-contract')
 * @param {object} opts.mergedFields   the fv object actually handed to fillForm()
 * @param {object} opts.ledger         result of require('./fill-ledger').getFillLedger()
 * @returns {{ pass: boolean, blocked: Array, untracked: Array, verifiedOk: string[] }}
 */
function auditFilledDocument({ formType, mergedFields, ledger }) {
  const required = getRequiredFieldsForFormType(formType);
  const fv = mergedFields || {};
  const attemptedFields = (ledger && ledger.attemptedFields) || new Set();

  const failuresByField = new Map();
  for (const f of (ledger && ledger.failures) || []) {
    if (!failuresByField.has(f.field)) failuresByField.set(f.field, []);
    failuresByField.get(f.field).push(f);
  }

  const blocked = [];
  const untracked = [];
  const verifiedOk = [];

  for (const field of required) {
    const aliases = aliasesFor(field);
    const value = aliases.map((a) => fv[a]).find(hasRealValue);
    if (!hasRealValue(value)) continue; // source data never had this — GapWizard's job, not this gate's

    const failedAlias = aliases.find((a) => failuresByField.has(a));
    if (failedAlias) {
      const failure = failuresByField.get(failedAlias)[0];
      blocked.push({
        field,
        prompt: fieldNameToPrompt(field),
        value: String(value).slice(0, 80),
        reason: failure.reason,
        ledgerFieldName: failure.field,
      });
      continue;
    }

    const covered = aliases.some((a) => attemptedFields.has(a));
    if (!covered) {
      untracked.push({ field, prompt: fieldNameToPrompt(field), value: String(value).slice(0, 80) });
      continue;
    }

    verifiedOk.push(field);
  }

  return {
    pass: blocked.length === 0,
    blocked,
    untracked,
    verifiedOk,
  };
}

/**
 * Build the dossie_asks row body for a blocked send, following the same
 * shape cron-esign-events.js's createAsk() already uses for post-completion
 * asks — same table, same suggested_actions pill pattern, no new surface.
 */
function buildFieldAuditAsk({ formName, formType, audit, documentContext }) {
  const fieldList = audit.blocked.map((b) => `${b.prompt} ("${b.value}")`).join(', ');
  const addr = documentContext && documentContext.propertyAddress ? ` for ${documentContext.propertyAddress}` : '';
  return {
    urgency: 'critical',
    title: `${formName} didn't fill correctly${addr ? ' — ' + documentContext.propertyAddress : ''}`,
    body:
      `I tried to fill the ${formName}${addr}, but ${audit.blocked.length === 1 ? 'a field that' : audit.blocked.length + ' fields that'} ` +
      `should have real values didn't make it onto the page: ${fieldList}. ` +
      `I stopped before saving or sending this document — a blank or wrong figure on a signed contract is worse than a delay. ` +
      `This usually means the form template changed (TREC revision) and the field map needs an update. Nothing was sent.`,
    dueAt: null,
    dueLabel: null,
    actions: [
      { id: 'acknowledge', label: 'Got it, I\'ll check the template', kind: 'primary' },
      { id: 'retry_fill', label: 'Try filling again', kind: 'secondary' },
    ],
    meta: { formType, blocked: audit.blocked, untracked: audit.untracked },
  };
}

module.exports = {
  auditFilledDocument,
  buildFieldAuditAsk,
  FIELD_ALIASES,
};
