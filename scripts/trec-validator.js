/**
 * trec-validator.js
 * Layer 3 — validates Layer 2 field assignments against trec-20-18-field-rules.json
 *
 * Input:  assignments = { [fieldId]: { value, confidence, matchReason } }
 *         intake      = the strict-typed intake object (for conditional evaluation)
 * Output: { report: [...], pass: bool, fillable: {fieldId: value}, flags: [...] }
 *
 * HARD RULES enforced here:
 *  - No catch-all bucket. Every field is PASS | FAIL(reason) | SKIP(conditional) | UNMATCHED.
 *  - Confidence floor: < CONFIDENCE_FLOOR auto-flags even if format-valid.
 *  - Mutex groups: at most one checkbox true, and EXACTLY one where the form
 *    requires an election to be made.
 *  - crossRef arithmetic (e.g. 3C = 3A + 3B) verified.
 *  - Conditional fields only fill when their predicate is true.
 *
 * 2026-09-17 — MUTEX REPAIR. Two defects made mutex enforcement a no-op:
 *
 *   1. GROUPING. `crossRef` names the OTHER members of the group, not the
 *      group itself: accept_as_is carries "MUTEX(accept_as_is_with_repairs)"
 *      while accept_as_is_with_repairs carries "MUTEX(accept_as_is)". Keying
 *      the group map on that raw string put every one of the 18 mutex fields
 *      in its own single-member group — all 18 of them — so no two checkboxes
 *      were ever compared against each other and the rule could not fire at
 *      all. Fixed by canonicalising: the group is {this field} UNION {members
 *      named in the crossRef}, sorted and joined, so both halves of a pair
 *      resolve to the same key.
 *
 *   2. COLLECTION. Members were only added to a group after passing every
 *      earlier check, and an unset checkbox `continue`s out of the loop long
 *      before that. The blank case — the actual failure mode — was therefore
 *      invisible to the enforcement step even in principle. Fixed by building
 *      group membership from the RULES up front, independent of whether any
 *      given member got a value.
 *
 * Enforcement is now "exactly one" for elections the form genuinely requires,
 * and "at most one" everywhere else. Which groups are required is declared in
 * contract-election-rules.json, alongside the reasoning — see that file's
 * header for why blocking is deliberately narrow.
 */

const CONFIDENCE_FLOOR = 0.85;

// Groups the form REQUIRES an answer to, keyed by canonical member set.
// Sourced from the shared election rules so trec-validator and the send-path
// gate can never disagree about which paragraph is mandatory.
const ELECTION_RULES = require('./contract-election-rules.json');

function canonicalKey(fieldIds) {
  return [...new Set(fieldIds)].sort().join('|');
}

/** Parse "MUTEX(a,b,c)" -> ['a','b','c']. */
function parseMutexMembers(crossRef) {
  const m = /^MUTEX\(([^)]*)\)$/.exec(String(crossRef).trim());
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Canonical member-set keys for the elections the form requires an answer to.
 * `enforcement: "blocking"` in the rules file means zero-selected is a hard
 * failure; anything else means a conflict still fails but a blank does not.
 */
function requiredElectionKeys(formCode) {
  const form = ELECTION_RULES.forms[formCode];
  if (!form) return new Map();
  const out = new Map();
  for (const el of form.elections) {
    if (el.enforcement !== 'blocking') continue;
    out.set(canonicalKey(el.satisfiers.map((s) => s.field)), el);
  }
  return out;
}

// ---- format validators ----
const FORMATS = {
  currency: (v) => /^\$?\d{1,3}(,?\d{3})*(\.\d{2})?$/.test(String(v).trim()),
  date: (v) => !isNaN(Date.parse(v)),
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim()),
  percent: (v) => /^\d{1,2}(\.\d+)?%?$/.test(String(v).trim()),
};

function toNumber(v) {
  if (v == null) return NaN;
  return parseFloat(String(v).replace(/[$,]/g, ""));
}

// ---- safe conditional evaluator ----
// Supports: "fieldId == 'x'", "fieldId != null", "a == true", "a or b", "MUTEX(...)", "DERIVE_FROM(...)"
function evalConditional(expr, intake, assignments) {
  if (!expr) return true;
  if (expr.startsWith("MUTEX") || expr.startsWith("DERIVE_FROM") || expr.startsWith("MUST_EQUAL"))
    return true; // handled separately
  const get = (k) => {
    if (k in intake) return intake[k];
    if (assignments[k]) return assignments[k].value;
    return null;
  };
  // split on ' or '
  const orParts = expr.split(" or ");
  return orParts.some((part) => {
    const m = part.trim().match(/^([\w.]+)\s*(==|!=)\s*(.+)$/);
    if (!m) return false;
    let [, key, op, raw] = m;
    raw = raw.trim().replace(/^'|'$/g, "");
    let actual = get(key.split(".")[0]);
    let expected = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
    if (op === "==") return actual === expected || String(actual) === String(expected);
    if (op === "!=") return actual !== expected && String(actual) !== String(expected);
    return false;
  });
}

function validate(rules, assignments, intake, opts) {
  const formCode = (opts && opts.formCode) || rules.formCode || '20-18';
  const byId = {};
  rules.fields.forEach((f) => (byId[f.fieldId] = f));
  const report = [];
  const fillable = {};
  const flags = [];

  // ---- mutex groups, built from the RULES, not from what happened to pass ----
  // Membership must exist before any value is looked at, or the blank case
  // (the one that let Pfeiffers Gate execute with 7D empty) is unrepresentable.
  const mutexGroups = {}; // canonical key -> { members: [fieldId], election }
  const requiredElections = requiredElectionKeys(formCode);
  for (const f of rules.fields) {
    if (!f.crossRef || !String(f.crossRef).startsWith('MUTEX')) continue;
    if (f.valueType !== 'checkbox') continue;
    const members = canonicalKey([f.fieldId, ...parseMutexMembers(f.crossRef)]);
    if (!mutexGroups[members]) {
      mutexGroups[members] = { members: members.split('|'), election: requiredElections.get(members) || null };
    }
  }

  // derive values that are computed from other fields (headers, year suffix)
  const propAddr = assignments["property_street_address"]?.value;
  const closing = assignments["closing_date"]?.value;
  for (const f of rules.fields) {
    if (f.fillPriority !== "derived") continue;
    if (f.fieldId.startsWith("header_property_") && propAddr) {
      assignments[f.fieldId] = { value: propAddr, confidence: 1, matchReason: "derived" };
    }
    if (f.fieldId === "closing_year_suffix" && closing) {
      const yr = new Date(closing).getFullYear();
      if (!isNaN(yr)) assignments[f.fieldId] = { value: String(yr).slice(-2), confidence: 1, matchReason: "derived" };
    }
  }

  for (const f of rules.fields) {
    if (f.fillPriority === "ignore") {
      report.push({ fieldId: f.fieldId, status: "SKIP", reason: "page-marker / non-fillable" });
      continue;
    }

    const a = assignments[f.fieldId];

    // explicit intentional blank on a non-core field is acceptable
    if (a && a.value === "" && f.fillPriority !== "core") {
      report.push({ fieldId: f.fieldId, status: "SKIP", reason: "intentional blank" });
      continue;
    }
    const conditionActive = evalConditional(f.conditional, intake, assignments);

    // conditional field whose predicate is false -> must stay blank
    if (f.conditional && !f.conditional.startsWith("MUTEX") && !conditionActive) {
      if (a && a.value != null && a.value !== "" && a.value !== false) {
        report.push({
          fieldId: f.fieldId, status: "FAIL",
          reason: `conditional not met (${f.conditional}) but value supplied: ${a.value}`,
        });
        flags.push(f.fieldId);
      } else {
        report.push({ fieldId: f.fieldId, status: "SKIP", reason: "conditional inactive (correctly blank)" });
      }
      continue;
    }

    // no assignment
    if (!a || a.value == null || a.value === "") {
      if (f.fillPriority === "core") {
        report.push({ fieldId: f.fieldId, status: "UNMATCHED", reason: "core field has no value" });
        flags.push(f.fieldId);
      } else {
        report.push({ fieldId: f.fieldId, status: "SKIP", reason: "no value (optional)" });
      }
      continue;
    }

    // confidence floor
    if (a.confidence != null && a.confidence < CONFIDENCE_FLOOR) {
      report.push({
        fieldId: f.fieldId, status: "FAIL",
        reason: `confidence ${a.confidence} below floor ${CONFIDENCE_FLOOR}`,
        value: a.value,
      });
      flags.push(f.fieldId);
      continue;
    }

    // format check
    if (f.format && FORMATS[f.format] && !FORMATS[f.format](a.value)) {
      report.push({
        fieldId: f.fieldId, status: "FAIL",
        reason: `format mismatch: expected ${f.format}, got "${a.value}"`,
      });
      flags.push(f.fieldId);
      continue;
    }
    if (f.format && f.format.startsWith("^")) {
      // raw regex
      if (!new RegExp(f.format).test(String(a.value).trim())) {
        report.push({
          fieldId: f.fieldId, status: "FAIL",
          reason: `regex mismatch ${f.format}: "${a.value}"`,
        });
        flags.push(f.fieldId);
        continue;
      }
    }

    report.push({ fieldId: f.fieldId, status: "PASS", value: a.value });
    fillable[f.fieldId] = a.value;
  }

  // crossRef arithmetic: sales_price_total = cash + financing
  const total = assignments["sales_price_total"];
  const cash = assignments["sales_price_cash_portion"];
  const fin = assignments["sales_price_financing_portion"];
  if (total && (cash || fin)) {
    const sum = (toNumber(cash?.value) || 0) + (toNumber(fin?.value) || 0);
    if (Math.abs(sum - toNumber(total.value)) > 0.01) {
      const idx = report.findIndex((r) => r.fieldId === "sales_price_total");
      report[idx] = {
        fieldId: "sales_price_total", status: "FAIL",
        reason: `3C (${total.value}) != 3A+3B (${sum})`,
      };
      flags.push("sales_price_total");
      delete fillable["sales_price_total"];
    }
  }

  // ---- mutex enforcement ----
  // Two selected is a contradiction on any election and always fails.
  // ZERO selected fails only where the form genuinely requires the election to
  // be made — that list is narrow on purpose (contract-election-rules.json),
  // because blocking a send on a paragraph the form permits to be inapplicable
  // would be its own defect.
  const elections = [];
  for (const [key, group] of Object.entries(mutexGroups)) {
    // Read values straight from the assignments so an unset member still counts
    // as a member. Only a real boolean true selects a box — the string 'true'
    // looks set in the data but renders as an empty box, so it must not satisfy
    // an election here either.
    const selected = group.members.filter((fieldId) => assignments[fieldId]?.value === true);
    const stringTrue = group.members.filter(
      (fieldId) => typeof assignments[fieldId]?.value === 'string'
        && assignments[fieldId].value.trim().toLowerCase() === 'true'
    );
    const el = group.election;
    const paragraph = el ? `¶${el.paragraph} (${el.label})` : key;

    const failMember = (fieldId, reason) => {
      const idx = report.findIndex((r) => r.fieldId === fieldId);
      const entry = { fieldId, status: 'FAIL', reason };
      if (idx >= 0) report[idx] = entry; else report.push(entry);
      flags.push(fieldId);
      delete fillable[fieldId];
    };

    if (selected.length > 1) {
      elections.push({ key, paragraph, status: 'FAIL', problem: 'multiple_selected', selected });
      selected.forEach((fieldId) => failMember(
        fieldId,
        `mutex violation: ${selected.length} boxes selected in ${paragraph}, the form allows one`
      ));
      continue;
    }

    if (selected.length === 1) {
      elections.push({ key, paragraph, status: 'OK', selected });
      continue;
    }

    // Zero selected.
    const coercion = stringTrue.length
      ? ` (${stringTrue.join(', ')} holds the text "true", which does not render as a checked box)`
      : '';
    if (el) {
      elections.push({ key, paragraph, status: 'FAIL', problem: 'none_selected', selected: [] });
      // Attribute the failure to the group, not to one arbitrary member.
      report.push({
        fieldId: `election:${el.id}`,
        status: 'FAIL',
        reason: `${paragraph}: no box selected — the form requires exactly one${coercion}`,
      });
      flags.push(`election:${el.id}`);
    } else {
      elections.push({ key, paragraph, status: 'BLANK', problem: 'none_selected', selected: [] });
      report.push({
        fieldId: `election:${key}`,
        status: 'SKIP',
        reason: `${paragraph}: no box selected — not enforced as required on this form${coercion}`,
      });
    }
  }

  const hardFails = report.filter((r) => r.status === "FAIL" || r.status === "UNMATCHED");
  return {
    report,
    pass: hardFails.length === 0,
    fillable,
    flags: [...new Set(flags)],
    elections,
  };
}

module.exports = {
  validate,
  CONFIDENCE_FLOOR,
  // exported for tests
  canonicalKey,
  parseMutexMembers,
  requiredElectionKeys,
};
