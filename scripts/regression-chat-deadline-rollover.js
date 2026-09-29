#!/usr/bin/env node
'use strict';

/**
 * Regression test for backlog item B1 (docs/BACKLOG-ENGINEERING.md):
 * "rollover isn't wired into the client-email path."
 *
 * Pre-fix state this test proves against:
 *   - api/_lib/business-calendar.js was required by 8 files. api/chat.js —
 *     the path that talks to the member and generates client-facing text —
 *     was NOT one of them.
 *   - compactDealsForAction() handed the model contractEffectiveDate and
 *     optionDays and nothing else, so every TREC deadline it spoke or wrote
 *     into an email was arithmetic the model did in its head.
 *   - handleActionMode() anchored relative dates on
 *     new Date().toISOString().slice(0,10) — the UTC date, which is already
 *     tomorrow in Texas from ~19:00 CT onward.
 *
 * The live failure (Heath's 2026-09-10 Pfeiffers Gate run, effective
 * 2026-09-09): a Saturday 2026-09-12 funds-delivery deadline that was never
 * rolled to Monday 2026-09-14, and a 9-day option period reported as ending
 * 2026-09-16 instead of 2026-09-18, in an email addressed to a client. In
 * Texas a blown option deadline can cost a buyer their earnest money.
 *
 * Covers:
 *   1. ¶5A(2) rollover on the funds-delivery dates the chat path emits:
 *      Saturday, Sunday, a mid-week Legal Holiday, a Monday Legal Holiday,
 *      a holiday-into-weekend chain — and a date already on a business day,
 *      which must NOT move.
 *   2. Rollover SCOPE: option expiration / closing / survey / appraisal /
 *      HOA / possession are fixed calendar dates and never roll, even on a
 *      Saturday. Getting this backwards is as wrong as not rolling at all.
 *   3. The real Pfeiffers Gate case end to end, through the same
 *      compactDealsForAction() the handler calls.
 *   4. Date normalization: ISO timestamps and M/D/YYYY reach the model as
 *      YYYY-MM-DD.
 *   5. "Today" is the Texas calendar date, not UTC.
 *   6. Wiring: api/chat.js actually requires the module, and its prompt
 *      carries the rule that forbids the model computing a deadline itself.
 *
 * Run manually:
 *   node scripts/regression-chat-deadline-rollover.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const LIB_PATH = path.resolve(__dirname, '..', 'api', '_lib', 'chat-deal-deadlines.js');
const BC_PATH = path.resolve(__dirname, '..', 'api', '_lib', 'business-calendar.js');
const CHAT_PATH = path.resolve(__dirname, '..', 'api', 'chat.js');

async function main() {
  console.log('chat deadline rollover regression — backlog B1 (2026-09-17)');
  console.log('=========================================================================================');

  assert.ok(fs.existsSync(LIB_PATH), `chat-deal-deadlines module missing at ${LIB_PATH} (pre-fix code)`);
  const lib = require(LIB_PATH);
  const bc = require(BC_PATH);
  const chatSrc = fs.readFileSync(CHAT_PATH, 'utf8');

  const { deriveDealDeadlines, compactDealsForAction, todayInTexasYMD, ymd } = lib;
  const derive = (deal) => deriveDealDeadlines(deal);
  const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const isDow = (d, n) => assert.strictEqual(bc.dayOfWeekYMD(d), n, `fixture ${d} must be a ${DOW[n]}`);

  const CASES = [
    // --- 1. ¶5A(2) rollover on the funds-delivery dates ---------------------
    ['Funds deadline landing on a SATURDAY rolls to Monday (2026-09-09 -> Sat 09-12 -> Mon 09-14)',
      () => {
        isDow('2026-09-12', 6);
        isDow('2026-09-14', 1);
        const r = derive({ contractEffectiveDate: '2026-09-09', optionDays: 9 });
        assert.strictEqual(r.fundsDeliveryDueDateRaw, '2026-09-12', 'raw +3 must be the Saturday');
        assert.strictEqual(r.optionFeeDueDate, '2026-09-14');
        assert.strictEqual(r.earnestMoneyDueDate, '2026-09-14');
        assert.strictEqual(r.fundsDeliveryRolled, true);
      }],
    ['Funds deadline landing on a SUNDAY rolls to Monday (2026-09-10 -> Sun 09-13 -> Mon 09-14)',
      () => {
        isDow('2026-09-13', 0);
        const r = derive({ contractEffectiveDate: '2026-09-10' });
        assert.strictEqual(r.fundsDeliveryDueDateRaw, '2026-09-13');
        assert.strictEqual(r.optionFeeDueDate, '2026-09-14');
        assert.strictEqual(r.earnestMoneyDueDate, '2026-09-14');
        assert.strictEqual(r.fundsDeliveryRolled, true);
      }],
    ['Funds deadline landing on a MID-WEEK federal holiday rolls (Veterans Day Wed 2026-11-11 -> Thu 11-12)',
      () => {
        isDow('2026-11-11', 3);
        assert.ok(bc.isTexasLegalHoliday('2026-11-11'), 'Veterans Day 2026-11-11 must be a Legal Holiday');
        const r = derive({ contractEffectiveDate: '2026-11-08' });
        assert.strictEqual(r.fundsDeliveryDueDateRaw, '2026-11-11');
        assert.strictEqual(r.optionFeeDueDate, '2026-11-12');
        assert.strictEqual(r.fundsDeliveryRolled, true);
      }],
    ['Funds deadline landing on a MONDAY federal holiday rolls to Tuesday (MLK Mon 2026-01-19 -> Tue 01-20)',
      () => {
        isDow('2026-01-19', 1);
        assert.ok(bc.isTexasLegalHoliday('2026-01-19'), 'MLK Day 2026-01-19 must be a Legal Holiday');
        const r = derive({ contractEffectiveDate: '2026-01-16' });
        assert.strictEqual(r.optionFeeDueDate, '2026-01-20');
        assert.strictEqual(r.earnestMoneyDueDate, '2026-01-20');
      }],
    ['Rollover chains holiday -> weekend (Christmas Fri 2026-12-25 -> Sat -> Sun -> Mon 12-28)',
      () => {
        isDow('2026-12-25', 5);
        assert.ok(bc.isTexasLegalHoliday('2026-12-25'));
        const r = derive({ contractEffectiveDate: '2026-12-22' });
        assert.strictEqual(r.fundsDeliveryDueDateRaw, '2026-12-25');
        assert.strictEqual(r.optionFeeDueDate, '2026-12-28');
      }],
    ['A funds deadline ALREADY on a business day must NOT move (Fri 2026-08-21 -> Mon 08-24)',
      () => {
        isDow('2026-08-21', 5);
        isDow('2026-08-24', 1);
        const r = derive({ contractEffectiveDate: '2026-08-21' });
        assert.strictEqual(r.fundsDeliveryDueDateRaw, '2026-08-24');
        assert.strictEqual(r.optionFeeDueDate, '2026-08-24');
        assert.strictEqual(r.earnestMoneyDueDate, '2026-08-24');
        assert.strictEqual(r.fundsDeliveryRolled, false, 'a business-day deadline must report rolled=false');
      }],
    ['A mid-week funds deadline must NOT move (Mon 2026-09-14 -> Thu 09-17)',
      () => {
        const r = derive({ contractEffectiveDate: '2026-09-14' });
        assert.strictEqual(r.optionFeeDueDate, '2026-09-17');
        assert.strictEqual(r.fundsDeliveryRolled, false);
      }],

    // --- 2. Rollover SCOPE --------------------------------------------------
    ['Option EXPIRATION is a fixed calendar date — it does NOT roll off a Saturday',
      () => {
        // 2026-09-09 + 10 option days = Sat 2026-09-19. ¶5A(2) does not reach it.
        isDow('2026-09-19', 6);
        const r = derive({ contractEffectiveDate: '2026-09-09', optionDays: 10 });
        assert.strictEqual(r.optionExpirationDate, '2026-09-19',
          'option expiration must stay on the Saturday — only funds delivery rolls');
        assert.strictEqual(bc.ROLLOVER_APPLIES.option_expiration_date, false);
      }],
    ['business-calendar still scopes rollover to funds delivery only (guards the scope rule itself)',
      () => {
        assert.strictEqual(bc.ROLLOVER_APPLIES.option_fee_due_date, true);
        assert.strictEqual(bc.ROLLOVER_APPLIES.earnest_money_due_date, true);
        assert.strictEqual(bc.ROLLOVER_APPLIES.additional_earnest_money_due_date, true);
        for (const fixed of ['option_expiration_date', 'closing_date', 'appraisal_deadline',
          'survey_deadline', 'hoa_document_deadline', 'loan_approval_deadline', 'possession_date']) {
          assert.strictEqual(bc.ROLLOVER_APPLIES[fixed], false, `${fixed} must never roll`);
        }
      }],
    ['Fixed deadline columns pass through untouched even when they land on a weekend',
      () => {
        const [deal] = compactDealsForAction([{
          id: 'd1',
          contractEffectiveDate: '2026-09-09',
          closingDate: '2026-09-19',        // Saturday
          surveyDeadline: '2026-09-19',     // Saturday
          appraisalDeadline: '2026-09-20',  // Sunday
          hoaDocumentDeadline: '2026-11-11',// Veterans Day
          loanApprovalDeadline: '2026-09-19',
          possessionDate: '2026-09-20',
        }]);
        assert.strictEqual(deal.closingDate, '2026-09-19');
        assert.strictEqual(deal.surveyDeadline, '2026-09-19');
        assert.strictEqual(deal.appraisalDeadline, '2026-09-20');
        assert.strictEqual(deal.hoaDocumentDeadline, '2026-11-11');
        assert.strictEqual(deal.loanApprovalDeadline, '2026-09-19');
        assert.strictEqual(deal.possessionDate, '2026-09-20');
      }],

    // --- 3. The real Pfeiffers Gate case ------------------------------------
    ['PFEIFFERS GATE (2026-09-10 live run): 9-day option from effective 2026-09-09 ends 2026-09-18, not 2026-09-16',
      () => {
        const [deal] = compactDealsForAction([{
          id: 'pfeiffers',
          propertyAddress: 'Pfeiffers Gate',
          contractEffectiveDate: '2026-09-09',
          optionDays: 9,
        }]);
        assert.strictEqual(deal.optionExpirationDate, '2026-09-18',
          'the live run emitted 2026-09-16 — two days early — to a client');
        assert.notStrictEqual(deal.optionExpirationDate, '2026-09-16');
      }],
    ['PFEIFFERS GATE: the Saturday 2026-09-12 funds deadline reaches the model as Monday 2026-09-14',
      () => {
        const [deal] = compactDealsForAction([{
          id: 'pfeiffers',
          contractEffectiveDate: '2026-09-09',
          optionDays: 9,
        }]);
        assert.strictEqual(deal.optionFeeDueDate, '2026-09-14');
        assert.strictEqual(deal.earnestMoneyDueDate, '2026-09-14');
        assert.notStrictEqual(deal.optionFeeDueDate, '2026-09-12');
        assert.strictEqual(deal.fundsDeliveryRolled, true, 'model must be able to explain WHY it is not +3');
        assert.strictEqual(deal.fundsDeliveryDueDateRaw, '2026-09-12');
      }],
    ['PFEIFFERS GATE: chat agrees with what scan-contract.js writes to the dossier (no two sources of truth)',
      () => {
        // scan-contract.js DEADLINE CHAIN: optionExpiration = effective + optionDays
        // (no rollover); funds = rollForwardYMD(effective + 3).
        const effective = '2026-09-09';
        const scanOptionExpiry = bc.addCalendarDaysYMD(effective, 9);
        const scanFunds = bc.rollForwardYMD(bc.addCalendarDaysYMD(effective, bc.TREC_5A_DELIVERY_DAYS));
        const r = derive({ contractEffectiveDate: effective, optionDays: 9 });
        assert.strictEqual(r.optionExpirationDate, scanOptionExpiry);
        assert.strictEqual(r.optionFeeDueDate, scanFunds);
        assert.strictEqual(r.earnestMoneyDueDate, scanFunds);
      }],

    // --- 4. Normalization + missing data ------------------------------------
    ['An ISO timestamp reaches the model as YYYY-MM-DD, not a raw timestamp',
      () => {
        const [deal] = compactDealsForAction([{
          id: 'd1',
          contractEffectiveDate: '2026-09-09T00:00:00.000Z',
          closingDate: '2026-10-24T05:00:00.000Z',
          optionDays: 9,
        }]);
        assert.strictEqual(deal.contractEffectiveDate, '2026-09-09');
        assert.strictEqual(deal.closingDate, '2026-10-24');
        assert.strictEqual(deal.optionFeeDueDate, '2026-09-14', 'rollover still applies through an ISO input');
      }],
    ['M/D/YYYY normalizes; an unparseable value becomes null rather than a guess',
      () => {
        assert.strictEqual(ymd('9/9/2026'), '2026-09-09');
        assert.strictEqual(ymd('at closing'), null);
        assert.strictEqual(ymd(''), null);
        assert.strictEqual(ymd(null), null);
        assert.strictEqual(ymd('2026-02-31'), null, 'an impossible date must not be accepted');
      }],
    ['No effective date -> every derived deadline is null, never invented',
      () => {
        const r = derive({ optionDays: 9 });
        assert.strictEqual(r.contractEffectiveDate, null);
        assert.strictEqual(r.optionFeeDueDate, null);
        assert.strictEqual(r.earnestMoneyDueDate, null);
        assert.strictEqual(r.optionExpirationDate, null);
        assert.strictEqual(r.fundsDeliveryRolled, false);
      }],
    ['No option days -> option expiration is null, not a 7-day default',
      () => {
        const r = derive({ contractEffectiveDate: '2026-09-09' });
        assert.strictEqual(r.optionExpirationDate, null,
          'a listing with no option period must not display one');
        assert.strictEqual(r.optionFeeDueDate, '2026-09-14', 'funds delivery is still computable');
      }],
    ['A stored option_expiration_date wins over the derived one (same precedence as scan-contract.js)',
      () => {
        const r = derive({
          contractEffectiveDate: '2026-09-09',
          optionDays: 9,
          optionExpirationDate: '2026-09-25', // negotiated, not effective+optionDays
        });
        assert.strictEqual(r.optionExpirationDate, '2026-09-25');
      }],

    // --- 5. "Today" is the Texas calendar date ------------------------------
    ['TODAY is the Texas date, not UTC — 2026-09-17 20:30 CT is still 09-17, though UTC says 09-18',
      () => {
        const at = new Date('2026-09-18T01:30:00.000Z'); // 20:30 CDT on 09-17
        assert.strictEqual(at.toISOString().slice(0, 10), '2026-09-18', 'fixture must straddle UTC midnight');
        assert.strictEqual(todayInTexasYMD(at), '2026-09-17');
      }],
    ['TODAY tracks Texas across the CST/CDT boundary',
      () => {
        assert.strictEqual(todayInTexasYMD(new Date('2026-01-05T05:30:00.000Z')), '2026-01-04'); // CST
        assert.strictEqual(todayInTexasYMD(new Date('2026-01-05T06:30:00.000Z')), '2026-01-05');
        assert.strictEqual(todayInTexasYMD(new Date('2026-07-05T04:30:00.000Z')), '2026-07-04'); // CDT
        assert.strictEqual(todayInTexasYMD(new Date('2026-07-05T05:30:00.000Z')), '2026-07-05');
      }],

    ['The team-risk block injected into the same prompt also anchors on the Texas date',
      () => {
        // TEAM_DEADLINE_FLAGS / TEAM_OVERDUE_ACTION_ITEMS are JSON-stringified
        // straight into the chat prompt; a UTC "today" flagged everything due
        // tomorrow as already overdue for ~5 hours every evening.
        const rollupSrc = fs.readFileSync(
          path.resolve(__dirname, '..', 'api', '_lib', 'team-risk-rollup.js'), 'utf8');
        assert.ok(/todayInTexasYMD\(\)/.test(rollupSrc),
          'team-risk-rollup.js must anchor past-due comparisons on the Texas date');
        assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(rollupSrc),
          'team-risk-rollup.js must no longer use the UTC date as today');
        assert.doesNotThrow(
          () => require(path.resolve(__dirname, '..', 'api', '_lib', 'team-risk-rollup.js')),
          'team-risk-rollup.js must still load');
      }],

    // --- 6. Wiring ----------------------------------------------------------
    ['api/chat.js requires the deadline module (the B1 gap itself)',
      () => {
        assert.ok(/require\(['"]\.\/_lib\/chat-deal-deadlines['"]\)/.test(chatSrc),
          'api/chat.js must require _lib/chat-deal-deadlines');
        assert.ok(/todayInTexasYMD\(\)/.test(chatSrc),
          'api/chat.js must anchor TODAY on the Texas date');
        assert.ok(!/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(chatSrc),
          'api/chat.js must no longer anchor TODAY on the UTC date');
      }],
    ['api/chat.js forbids the model computing a deadline itself',
      () => {
        assert.ok(/DEADLINE AUTHORITY/.test(chatSrc), 'action prompt must carry the DEADLINE AUTHORITY block');
        assert.ok(/NEVER compute a contract deadline yourself/.test(chatSrc));
        assert.ok(/DEADLINE RULE/.test(chatSrc), 'conversational prompt must carry its own deadline guard');
      }],
    ['The compacted deal actually carries every computed deadline into the prompt',
      () => {
        const [deal] = compactDealsForAction([{
          id: 'd1', contractEffectiveDate: '2026-09-09', optionDays: 9,
        }]);
        for (const k of ['contractEffectiveDate', 'optionExpirationDate', 'optionFeeDueDate',
          'earnestMoneyDueDate', 'fundsDeliveryDueDateRaw', 'fundsDeliveryRolled']) {
          assert.ok(k in deal, `compacted deal is missing ${k}`);
        }
      }],
    ['Deals without an id are still dropped, and the 50-deal cap still holds',
      () => {
        assert.deepStrictEqual(compactDealsForAction([{ propertyAddress: 'no id' }]), []);
        assert.deepStrictEqual(compactDealsForAction(null), []);
        const many = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}` }));
        assert.strictEqual(compactDealsForAction(many).length, 50);
      }],

    // --- 7. Out of scope, asserted so nobody "helpfully" guesses -------------
    ['trec-deadline-engine survey/HOA builders stay commented out (parked on a TC interview)',
      () => {
        // Sibling repo. Walk up until a Dossie/ checkout turns up, so this
        // still resolves from a git worktree under MeetDossie/.claude/.
        const REL = path.join('Dossie', 'src', 'utils', 'trec-deadline-engine.js');
        let enginePath = null;
        for (let dir = __dirname; ; dir = path.dirname(dir)) {
          const candidate = path.join(dir, REL);
          if (fs.existsSync(candidate)) { enginePath = candidate; break; }
          if (path.dirname(dir) === dir) break;
        }
        if (!enginePath) {
          console.log('    (skipped — Dossie repo not checked out beside MeetDossie)');
          return;
        }
        const src = fs.readFileSync(enginePath, 'utf8');
        assert.ok(/\/\/ TODO-SARAH: buildSurveyDeadline/.test(src),
          'buildSurveyDeadline must stay commented out until Heath supplies survey-path conventions');
        assert.ok(/\/\/ TODO-SARAH: buildHOADocDeadline/.test(src),
          'buildHOADocDeadline must stay commented out until Heath supplies 36-10 handling');
      }],
  ];

  let failed = 0;
  for (const [label, fn] of CASES) {
    try {
      await fn();
      console.log('  PASS:', label);
    } catch (e) {
      failed++;
      console.error('  FAIL:', label, '—', e && e.message);
    }
  }
  console.log('=========================================================================================');
  if (failed) {
    console.log(failed + ' test(s) FAILED');
    process.exit(1);
  }
  console.log('All tests passed');
}

main().catch((e) => {
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
});
