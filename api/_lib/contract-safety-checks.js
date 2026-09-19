// api/_lib/contract-safety-checks.js
//
// Contract-safety tier of the daily regression suite.
//
// WHY THIS EXISTS
// ---------------
// The TREC contract-correctness work (validator, 20-18 field rules, the
// golden/broken fixtures, the ¶5A(2) deadline rollover) is guarded today by
// two things, and neither one runs daily:
//
//   1. .github/workflows/trec-validator-tests.yml — PATH-GATED. It only fires
//      when someone edits one of the files on its `paths:` list. A change
//      anywhere else that breaks contract correctness never trips it.
//   2. `node scripts/run-tests.js` — run by hand, by whoever remembers.
//
// So the gate protects the contract path right up until nobody is watching.
// Per feedback_silent-failure-is-the-enemy.md, every pipeline needs an alarm
// built in the same change. api/cron-regression-suite.js is the alarm that
// now actually reaches Heath (the Telegram gate + delta-based policy shipped
// 2026-09-17), so the contract checks live here and ride that alarm.
//
// WHAT THIS TESTS THAT CI DOES NOT
// --------------------------------
// CI validates the REPO. This module runs inside the deployed Vercel bundle,
// so it validates what is ACTUALLY SERVING: the api/_lib copies of the
// validator, the rules JSON and the deadline engine. A hand-edited rules file
// or a bad copy that never went through a PR is caught here and nowhere else.
//
// CONSTRAINTS (same as the rest of the cron)
// ------------------------------------------
//   - Pure, synchronous, in-process. No network, no DB, no child process,
//     no Anthropic. The whole tier runs in single-digit milliseconds.
//   - Reads nothing off disk at runtime — every fixture is a static
//     require() so Vercel's file tracer bundles it.
//   - Emits rows in the exact shape cron-regression-suite.js already uses:
//     { id, category, tier, verdict, response_ms, error, detail }.
//
// ADDING A CHECK
// --------------
// Only add one that passes TODAY. The suite's alerting is delta-based: a
// newly-added already-failing check reads as a regression and trains Heath to
// ignore the alarm, which is the exact failure this file exists to prevent.

'use strict';

const { validate } = require('./trec-validator.js');
const rules = require('./trec-20-18-field-rules.json');

// Static requires — the file tracer follows these into the bundle. These are
// byte-identical deploy copies of Heath's source of truth under scripts/;
// scripts/artifact-integrity-check.js fails CI if they ever drift.
const GOLDEN = {
  conventional: require('./golden-cases/golden-case-conventional.json'),
  cash: require('./golden-cases/golden-case-cash.json'),
  fha: require('./golden-cases/golden-case-fha.json'),
  va: require('./golden-cases/golden-case-va.json'),
  seller: require('./golden-cases/golden-case-seller.json'),
  assumption: require('./golden-cases/golden-case-assumption.json'),
};

const { compactDealsForAction, deriveDealDeadlines } = require('./chat-deal-deadlines.js');

// Shape of the deployed rules file, as of TREC 20-18. A regenerated or
// truncated rules file makes every golden case pass VACUOUSLY (no rules =
// nothing to violate), so this tripwire has to exist alongside them.
const RULES_EXPECTED = {
  form: 'TREC 20-18',
  totalWidgets: 263,
  mapped: 263,
  unmapped: 0,
  fields: 263,
  mutexFields: 18,
};

function row(id, ok, error, detail, ms) {
  return {
    id,
    category: 'contract',
    tier: 'contract',
    verdict: ok ? 'PASS' : 'FAIL',
    response_ms: ms || 0,
    error: ok ? null : String(error || 'failed').slice(0, 400),
    detail: detail || {},
  };
}

function guarded(id, fn) {
  const t = Date.now();
  try {
    const { ok, error, detail } = fn();
    return row(id, ok, error, detail, Date.now() - t);
  } catch (e) {
    return row(id, false, `threw: ${e.message}`, { stack: (e.stack || '').slice(0, 200) }, Date.now() - t);
  }
}

// ---------------------------------------------------------------------------
// 1-6. Golden cases. Each hand-verified offer must validate clean through the
//      DEPLOYED validator + DEPLOYED rules. Mirrors scripts/run-tests.js.
// ---------------------------------------------------------------------------
function goldenChecks() {
  return Object.entries(GOLDEN).map(([name, g]) =>
    guarded(`contract.trec2018.golden.${name}`, () => {
      const r = validate(rules, g.assignments, g.intake);
      const bad = r.report
        .filter((x) => x.status === 'FAIL' || x.status === 'UNMATCHED')
        .map((x) => `${x.status} ${x.fieldId}: ${x.reason}`);
      return {
        ok: r.pass === true,
        error: `golden case ${name} no longer validates clean — ${bad.slice(0, 4).join(' | ')}`,
        detail: { filled: Object.keys(r.fillable).length, failures: bad.slice(0, 6) },
      };
    })
  );
}

// ---------------------------------------------------------------------------
// 7. The broken case. A validator that has stopped ENFORCING is far more
//    dangerous than one that is too strict: it signs off on a wrong contract.
//    Every injected defect below must still be caught, by fieldId.
//
//    NOTE — the two mutex checkboxes that scripts/run-tests.js also injects
//    (accept_as_is / accept_as_is_with_repairs) are deliberately NOT asserted
//    here. On main today the validator's mutex grouping keys off each field's
//    raw crossRef string, which differs per member, so every mutex group has
//    exactly one member and enforcement is a no-op. That is a real open defect
//    (fix lives on feat/contract-election-gate); asserting it here would add a
//    seventh standing failure to the daily alarm instead of fixing it.
// ---------------------------------------------------------------------------
const INJECTED = [
  ['sales_price_total', '3C arithmetic (3A + 3B) no longer cross-checked'],
  ['earnest_money_amount', 'currency format no longer validated'],
  ['option_period_days', 'numeric regex no longer validated'],
  ['notice_buyer_email', 'confidence floor no longer enforced'],
  ['add_seller_financing', 'conditional-field predicate no longer enforced'],
];

function brokenCaseCheck() {
  return guarded('contract.trec2018.broken_case_rejected', () => {
    const broken = JSON.parse(JSON.stringify(GOLDEN.conventional));
    broken.assignments.sales_price_total.value = '999,999.00';
    broken.assignments.option_period_days.value = 'seven';
    broken.assignments.earnest_money_amount.value = 'lots';
    broken.assignments.accept_as_is_with_repairs = { value: true, confidence: 0.9 };
    broken.assignments.add_seller_financing = { value: true, confidence: 0.9 };
    broken.assignments.notice_buyer_email.confidence = 0.4;

    const b = validate(rules, broken.assignments, broken.intake);
    const caught = new Set(
      b.report.filter((x) => x.status === 'FAIL' || x.status === 'UNMATCHED').map((x) => x.fieldId)
    );
    const missed = INJECTED.filter(([f]) => !caught.has(f));

    return {
      ok: b.pass === false && missed.length === 0,
      error:
        b.pass !== false
          ? 'validator PASSED a contract with 5 injected defects — it is no longer enforcing anything'
          : `validator stopped catching: ${missed.map(([f, why]) => `${f} (${why})`).join('; ')}`,
      detail: { pass: b.pass, missed: missed.map(([f]) => f), caught: [...caught].slice(0, 10) },
    };
  });
}

// ---------------------------------------------------------------------------
// 8. Rules-file integrity. Guards against a gutted / regenerated rules file
//    making checks 1-7 pass vacuously.
// ---------------------------------------------------------------------------
function rulesIntegrityCheck() {
  return guarded('contract.trec2018.rules_integrity', () => {
    const fields = Array.isArray(rules.fields) ? rules.fields : [];
    const mutexFields = fields.filter(
      (f) => f.crossRef && String(f.crossRef).startsWith('MUTEX')
    ).length;
    const actual = {
      form: rules.form,
      totalWidgets: rules.totalWidgets,
      mapped: rules.mapped,
      unmapped: rules.unmapped,
      fields: fields.length,
      mutexFields,
    };
    const drifted = Object.keys(RULES_EXPECTED).filter((k) => actual[k] !== RULES_EXPECTED[k]);
    return {
      ok: drifted.length === 0,
      error: `deployed 20-18 rules file drifted: ${drifted
        .map((k) => `${k}=${actual[k]} (expected ${RULES_EXPECTED[k]})`)
        .join(', ')}`,
      detail: actual,
    };
  });
}

// ---------------------------------------------------------------------------
// 9-10. ¶5A(2) deadline rollover, against the DEPLOYED engine.
//
//   The full 26-assertion suite is scripts/regression-chat-deadline-rollover.js
//   — it cannot run here because it reads api/chat.js off disk and shells out
//   of process. These two are the live-incident cases distilled: Heath's
//   2026-09-10 Pfeiffers Gate run told a client an option period ended two
//   days early and put a funds deadline on a Saturday. In Texas a blown option
//   deadline costs a buyer their earnest money.
// ---------------------------------------------------------------------------
function deadlineChecks() {
  const checks = [];

  checks.push(
    guarded('contract.deadlines.pfeiffers_gate', () => {
      const [deal] = compactDealsForAction([
        { id: 'regression-pfeiffers', contractEffectiveDate: '2026-09-09', optionDays: 9 },
      ]);
      const problems = [];
      if (deal.optionExpirationDate !== '2026-09-18')
        problems.push(`option expiry ${deal.optionExpirationDate} != 2026-09-18`);
      if (deal.optionFeeDueDate !== '2026-09-14')
        problems.push(`option fee due ${deal.optionFeeDueDate} != 2026-09-14 (Saturday not rolled)`);
      if (deal.earnestMoneyDueDate !== '2026-09-14')
        problems.push(`earnest money due ${deal.earnestMoneyDueDate} != 2026-09-14`);
      if (deal.fundsDeliveryRolled !== true)
        problems.push('fundsDeliveryRolled flag lost — the model cannot explain why it is not +3');
      return {
        ok: problems.length === 0,
        error: `¶5A(2) rollover regressed to the 2026-09-10 live failure: ${problems.join('; ')}`,
        detail: {
          optionExpirationDate: deal.optionExpirationDate,
          optionFeeDueDate: deal.optionFeeDueDate,
          earnestMoneyDueDate: deal.earnestMoneyDueDate,
          fundsDeliveryRolled: deal.fundsDeliveryRolled,
        },
      };
    })
  );

  checks.push(
    guarded('contract.deadlines.rollover_scope', () => {
      // Rollover applies to funds delivery ONLY. Option expiration, closing
      // and the rest are fixed calendar dates — rolling them is as wrong as
      // not rolling funds delivery. 2026-09-12 is a Saturday.
      const [r] = compactDealsForAction([
        {
          id: 'regression-scope',
          contractEffectiveDate: '2026-09-09',
          optionDays: 3, // lands on Saturday 2026-09-12 and must STAY there
          closingDate: '2026-10-24',
        },
      ]);
      const problems = [];
      if (r.optionExpirationDate !== '2026-09-12')
        problems.push(`option expiration rolled off its calendar date: ${r.optionExpirationDate}`);
      if (r.closingDate !== '2026-10-24')
        problems.push(`closing date mutated: ${r.closingDate}`);
      if (r.optionFeeDueDate !== '2026-09-14')
        problems.push(`funds delivery stopped rolling: ${r.optionFeeDueDate}`);
      // And the no-data case: never invent a deadline.
      const empty = deriveDealDeadlines({ optionDays: 9 });
      if (empty.optionExpirationDate !== null || empty.optionFeeDueDate !== null)
        problems.push('deadlines invented with no contract effective date');
      return {
        ok: problems.length === 0,
        error: `rollover scope wrong: ${problems.join('; ')}`,
        detail: {
          optionExpirationDate: r.optionExpirationDate,
          closingDate: r.closingDate,
        },
      };
    })
  );

  return checks;
}

// ---------------------------------------------------------------------------
// PARKED — contract election gate (35 tests, scripts/test-contract-election-gate.js)
//
// The pre-send election gate lives on the UNMERGED branch
// feat/contract-election-gate (worktree agent-a866ff7e07ba58a2a). It adds
// api/_lib/contract-election-gate.js + contract-election-rules.json and, as
// part of the same change, repairs the mutex no-op noted above.
//
// Wiring it now would make this module require() a file that does not exist on
// main, which breaks EVERY cron run, not just this tier. So it stays parked.
//
// TO ACTIVATE, after feat/contract-election-gate merges to main:
//   1. Run `node scripts/test-contract-election-gate.js` on the merged tree
//      and confirm 35/35 pass. Do not wire a red check.
//   2. Uncomment the require and the checks() entry below.
//   3. Re-check the mutex note in brokenCaseCheck() — once the gate merges,
//      accept_as_is / accept_as_is_with_repairs SHOULD both be caught, and
//      this file should start asserting them.
//
// const { evaluateElections } = require('./contract-election-gate.js');
//
// function electionGateChecks() {
//   return [
//     guarded('contract.elections.required_elections_enforced', () => {
//       // Every "check one box only" group on a 20-18 must be filled before
//       // send. The Pfeiffers execution went out with ¶7D blank.
//       const r = evaluateElections(GOLDEN.conventional.assignments);
//       return { ok: r.ok === true, error: `unresolved elections: ${(r.missing || []).join(', ')}`, detail: r };
//     }),
//     guarded('contract.elections.blank_election_blocks_send', () => {
//       const a = JSON.parse(JSON.stringify(GOLDEN.conventional.assignments));
//       delete a.accept_as_is;
//       delete a.accept_as_is_with_repairs;
//       const r = evaluateElections(a);
//       return { ok: r.ok === false, error: 'a blank ¶7D election no longer blocks the send', detail: r };
//     }),
//   ];
// }
// ---------------------------------------------------------------------------

/**
 * Run the whole contract-safety tier. Synchronous, never throws — a thrown
 * check becomes a FAIL row so one bad check can never take down the cron.
 *
 * @returns {Array<object>} regression-suite result rows
 */
function runContractSafetyChecks() {
  return [
    ...goldenChecks(),
    brokenCaseCheck(),
    rulesIntegrityCheck(),
    ...deadlineChecks(),
    // ...electionGateChecks(),   // PARKED — see block above
  ];
}

module.exports = { runContractSafetyChecks, RULES_EXPECTED, INJECTED };
