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
 *  - Mutex groups: at most one checkbox true.
 *  - crossRef arithmetic (e.g. 3C = 3A + 3B) verified.
 *  - Conditional fields only fill when their predicate is true.
 */

const CONFIDENCE_FLOOR = 0.85;

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

function validate(rules, assignments, intake) {
  const byId = {};
  rules.fields.forEach((f) => (byId[f.fieldId] = f));
  const report = [];
  const fillable = {};
  const flags = [];
  const mutexGroups = {}; // key -> [{fieldId, value}]

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

    // collect mutex
    if (f.crossRef && f.crossRef.startsWith("MUTEX") && f.valueType === "checkbox") {
      const key = f.crossRef;
      (mutexGroups[key] = mutexGroups[key] || []).push({ fieldId: f.fieldId, value: a.value });
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

  // mutex enforcement: at most one true
  for (const [key, members] of Object.entries(mutexGroups)) {
    const trues = members.filter((m) => m.value === true || m.value === "true");
    if (trues.length > 1) {
      trues.forEach((m) => {
        const idx = report.findIndex((r) => r.fieldId === m.fieldId);
        report[idx] = { fieldId: m.fieldId, status: "FAIL", reason: `mutex violation in ${key}` };
        flags.push(m.fieldId);
        delete fillable[m.fieldId];
      });
    }
  }

  const hardFails = report.filter((r) => r.status === "FAIL" || r.status === "UNMATCHED");
  return { report, pass: hardFails.length === 0, fillable, flags: [...new Set(flags)] };
}

module.exports = { validate, CONFIDENCE_FLOOR };
