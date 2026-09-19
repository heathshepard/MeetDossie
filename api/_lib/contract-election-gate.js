// api/_lib/contract-election-gate.js
// =============================================================================
// THE ELECTION GATE.
//
// Every mutually-exclusive "check one box only" election on a TREC contract is
// enumerated in contract-election-rules.json. This module answers one question,
// deterministically and with no model call: for the values that are about to be
// rendered onto this contract, is every genuinely-required election actually
// made — exactly one box, not zero and not two?
//
// WHY IT EXISTS
// 29046 Pfeiffers Gate executed 2026-09-09 with paragraph 7D blank — neither
// As-Is box checked, the paragraph that decides whether the sellers owe
// repairs. It survived drafting, three offer versions, a page-by-page
// verification, four signatures, and delivery to title. It had been flagged in
// an offer analysis and executed anyway. A note in a report is not a gate.
// Memory: feedback_verify-contract-elections-before-execution.md.
//
// THE TRADEOFF, STATED PLAINLY
// A validator that wrongly blocks a legitimate send is its own disaster. Heath
// sends real contracts against option deadlines; a false positive at 4:59pm on
// the last day of an option period costs a client their termination right just
// as surely as a blank box does. So this gate fails loudly, but only on
// elections it can prove are BOTH genuinely required AND genuinely remediable
// by the person it is blocking. Everything else is a warning that names the
// paragraph. The reasoning for each call lives in the rules file next to the
// rule, not here, so the two can never drift.
//
// STRING-BOOLEAN DETECTION
// The Interactive Editor's CheckboxField sends the STRING 'true'; the 20-19
// filler gates on strict === true. A value of 'true' therefore looks set to a
// human reading the data and renders as a BLANK BOX on the page. That is not a
// hypothetical — it is the mechanism behind the paragraph 7B defect. This gate
// models what RENDERS, not what was intended: a string 'true' does not satisfy
// an election, and is reported with its own explicit message so the cause is
// obvious rather than mysterious.
//
// This module is pure: no I/O, no network, no Supabase. Give it field values,
// it returns a verdict. That makes it cheap enough to run on every send path
// and trivial to test.
// =============================================================================

'use strict';

const RULES = require('./contract-election-rules.json');

/** A value a member actually chose, versus absent. */
function isPresent(v) {
  return !(v === null || v === undefined || (typeof v === 'string' && v.trim() === ''));
}

/**
 * Evaluate one satisfier against the field values.
 * Returns { satisfied, coercionRisk } — coercionRisk flags the string-'true'
 * case, where the data looks set but the PDF renders blank.
 */
function evalSatisfier(sat, fv) {
  const v = fv[sat.field];

  switch (sat.kind) {
    case 'boolTrue':
      if (v === true) return { satisfied: true, coercionRisk: false };
      // The string 'true' reads as set but does not render. Never satisfy on it.
      if (typeof v === 'string' && v.trim().toLowerCase() === 'true') {
        return { satisfied: false, coercionRisk: true };
      }
      return { satisfied: false, coercionRisk: false };

    case 'boolFalse':
      if (v === false) return { satisfied: true, coercionRisk: false };
      if (typeof v === 'string' && v.trim().toLowerCase() === 'false') {
        return { satisfied: false, coercionRisk: true };
      }
      return { satisfied: false, coercionRisk: false };

    case 'nonEmpty':
      return { satisfied: isPresent(v), coercionRisk: false };

    case 'equals': {
      if (!isPresent(v)) return { satisfied: false, coercionRisk: false };
      const want = (sat.values || []).map((x) => String(x));
      return { satisfied: want.includes(String(v).trim()), coercionRisk: false };
    }

    default:
      // An unknown satisfier kind must never silently pass an election.
      return { satisfied: false, coercionRisk: false, unknownKind: true };
  }
}

/** Human-readable "¶7D — Acceptance of Property Condition". */
function label(el) {
  return `¶${el.paragraph} — ${el.label}`;
}

/**
 * @param {object} opts
 * @param {string} opts.formCode   '20-19' | '20-18'
 * @param {object} opts.fieldValues  the values about to be rendered (fv space)
 * @returns {{
 *   pass: boolean,
 *   evaluated: boolean,
 *   formCode: string,
 *   blocking: Array<{id,paragraph,label,problem,message,fields}>,
 *   warnings: Array<{id,paragraph,label,problem,message,fields}>,
 *   unreachable: Array<{id,paragraph,label,message}>,
 *   ok: string[],
 *   skipped: Array<{id,reason}>
 * }}
 */
function evaluateElections({ formCode, fieldValues }) {
  const form = RULES.forms[formCode];
  const fv = fieldValues || {};

  if (!form) {
    // No rules for this form. Say so explicitly — an unknown form is NOT a pass.
    return {
      pass: true,
      evaluated: false,
      formCode: formCode || null,
      blocking: [],
      warnings: [],
      unreachable: [],
      ok: [],
      skipped: [],
      note: `No election rules are defined for form ${formCode || '(unknown)'}. `
        + 'Elections on this form were NOT checked.',
    };
  }

  const blocking = [];
  const warnings = [];
  const unreachable = [];
  const ok = [];
  const skipped = [];

  for (const el of form.elections) {
    // Paragraph only applies in some deals (e.g. 4C natural-resource leases).
    if (el.appliesWhen) {
      const gateSat = evalSatisfier(el.appliesWhen, fv);
      if (!gateSat.satisfied) {
        skipped.push({ id: el.id, reason: `${label(el)} does not apply to this contract.` });
        continue;
      }
    }

    const results = el.satisfiers.map((s) => ({ sat: s, res: evalSatisfier(s, fv) }));
    const chosen = results.filter((r) => r.res.satisfied);
    const coerced = results.filter((r) => r.res.coercionRisk);
    const isBlocking = el.enforcement === 'blocking';
    const bucket = isBlocking ? blocking : warnings;

    // Surface unreachable controls regardless of outcome — they must never
    // silently pass, but they are also never the reason a send is blocked.
    const unreachableSats = el.satisfiers.filter((s) => s.reachable === false);
    if (unreachableSats.length) {
      unreachable.push({
        id: el.id,
        paragraph: el.paragraph,
        label: label(el),
        message: `${label(el)}: ${unreachableSats.length} of ${el.satisfiers.length} option(s) `
          + 'cannot be set by Dossie today and must be confirmed on the rendered page — '
          + unreachableSats.map((s) => s.label).join('; '),
      });
    }

    if (chosen.length === 1) {
      ok.push(`${label(el)}: ${chosen[0].sat.label}`);
      // Dependent requirements — e.g. 7D(2) checked but no repairs written in.
      for (const dep of el.dependents || []) {
        const depActive = evalSatisfier({ field: dep.when, kind: 'boolTrue' }, fv).satisfied;
        if (!depActive) continue;
        const boxLabel = (el.satisfiers.find((s) => s.field === dep.when) || {}).label || dep.when;

        // `requireNonEmptyAny` is satisfied by ANY of the listed fields. It
        // exists so a member who HAS written the repairs is never blocked
        // because a separate mapping drops the text on the way to the page.
        const anyFields = dep.requireNonEmptyAny || dep.requireNonEmpty || [];
        const anySatisfied = dep.requireNonEmptyAny
          ? anyFields.some((f) => isPresent(fv[f]))
          : anyFields.every((f) => isPresent(fv[f]));

        if (!anySatisfied) {
          const entry = {
            id: `${el.id}:${dep.when}`,
            paragraph: el.paragraph,
            label: label(el),
            problem: 'dependent_missing',
            message: `${label(el)}: the box for "${boxLabel}" is checked, but no repairs are `
              + 'written in anywhere. The contract would go out obligating the seller to complete '
              + 'a list with nothing on it.',
            fields: anyFields,
            why: dep.why || null,
          };
          (dep.enforcement === 'blocking' ? blocking : warnings).push(entry);
          continue;
        }

        // Repairs exist, but check whether they reach the field that renders.
        // A value the member typed that never lands on the page is exactly the
        // silent-drop class this gate exists to make loud — but it is NOT a
        // reason to block, because the member has already done their part.
        if (dep.renderedField && !isPresent(fv[dep.renderedField])) {
          const carried = (dep.sourceFields || []).filter((f) => isPresent(fv[f]));
          if (carried.length) {
            warnings.push({
              id: `${el.id}:${dep.when}:render-gap`,
              paragraph: el.paragraph,
              label: label(el),
              problem: 'value_not_rendered',
              message: `${label(el)}: the repairs are written in (${carried.join(', ')}) but they will `
                + `NOT appear on the contract — nothing copies them into "${dep.renderedField}", `
                + 'which is the only field the form actually prints. Confirm the repair text on the '
                + 'rendered page before this goes to signature.',
              fields: carried,
              why: dep.renderGapWhy || null,
            });
          }
        }
      }
      continue;
    }

    if (chosen.length > 1) {
      bucket.push({
        id: el.id,
        paragraph: el.paragraph,
        label: label(el),
        problem: 'multiple_selected',
        message: `${label(el)}: ${chosen.length} boxes are selected but the form allows only one `
          + `— ${chosen.map((c) => c.sat.label).join(' AND ')}.`,
        fields: chosen.map((c) => c.sat.field),
        why: el.why || null,
      });
      continue;
    }

    // Zero selected. This is the Pfeiffers failure mode, and the whole reason
    // "at most one" was never enough.
    const coercionNote = coerced.length
      ? ' One or more of these values is the text "true" rather than a real checkbox value, '
        + 'so it looks set in the data but renders as an empty box on the page.'
      : '';
    bucket.push({
      id: el.id,
      paragraph: el.paragraph,
      label: label(el),
      problem: 'none_selected',
      message: `${label(el)}: no box is selected. The form requires exactly one. `
        + `Options: ${el.satisfiers.map((s) => s.label).join(' | ')}.${coercionNote}`,
      fields: el.satisfiers.map((s) => s.field),
      why: el.why || null,
    });
  }

  return {
    pass: blocking.length === 0,
    evaluated: true,
    formCode,
    formName: form.formName,
    blocking,
    warnings,
    unreachable,
    ok,
    skipped,
  };
}

/**
 * One-line summary safe to put in a log or a Telegram message.
 */
function summarize(result) {
  if (!result.evaluated) return result.note || 'Elections not checked.';
  return `elections ${result.pass ? 'PASS' : 'BLOCKED'} — `
    + `${result.blocking.length} blocking, ${result.warnings.length} warning, `
    + `${result.unreachable.length} unreachable, ${result.ok.length} ok`;
}

/**
 * Member-facing error text for a blocked send. Names the paragraph and what is
 * missing — never a vague "validation failed".
 */
function blockingMessage(result) {
  if (result.pass) return null;
  const lines = result.blocking.map((b) => `• ${b.message}`);
  return 'This contract was not sent because a required election is blank or ambiguous. '
    + 'A blank "check one box only" paragraph is construed against the person who drafted it, '
    + 'so it has to be fixed before signatures.\n\n'
    + lines.join('\n');
}

/** Map a fill-form form_type / documents.document_type to a rules form code. */
const FORM_TYPE_TO_FORM_CODE = {
  'resale-contract': '20-19',
  resale_contract: '20-19',
  'resale-contract-20-18': '20-18',
};

function formCodeForFormType(formType) {
  if (!formType) return null;
  return FORM_TYPE_TO_FORM_CODE[formType] || null;
}

module.exports = {
  evaluateElections,
  summarize,
  blockingMessage,
  formCodeForFormType,
  FORM_TYPE_TO_FORM_CODE,
  // exported for tests
  evalSatisfier,
};
