#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-10-08 CARTER fix: deadline_reminders rows
 * going stale when the date they were computed from changes (the 507 Ridge
 * Bluff incident — an executed TREC 39-11 extension moved closing_date
 * 2026-09-24 -> 2026-10-09; the already-sent T-7/T-1 reminders stayed
 * marked "sent" against the old date and never re-fired for the new one).
 *
 * This does NOT re-implement the cron's logic and assert against the
 * reimplementation — it requires the REAL module.exports handler from
 * api/cron-deadline-reminders.js and drives it against an in-memory fake of
 * the Supabase REST surface + Resend, so every assertion below is about the
 * actual shipped code path, not a model of it.
 *
 * Simulates "today" moving forward across several cron runs by swapping in
 * a fake Date for the duration of each run (todayChicagoYMD() has no clock
 * injection point, so this is the only way to drive multi-day behavior
 * without a live multi-day wait). Restored after every run.
 *
 * Run manually:
 *   node scripts/regression-deadline-reminder-staleness.js
 */

const assert = require('assert');
const path = require('path');

process.env.SUPABASE_URL = 'http://fake.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.RESEND_API_KEY = 'fake-resend-key';
process.env.CRON_SECRET = 'fake-cron-secret';

const CRON_PATH = path.resolve(__dirname, '..', 'api', 'cron-deadline-reminders.js');

// ---------------------------------------------------------------------------
// Fake clock — swap global.Date for the duration of one cron run so
// todayChicagoYMD() (new Date() + Intl.DateTimeFormat, no injection point)
// sees whatever YMD we want "today" to be, in America/Chicago terms.
// ---------------------------------------------------------------------------
const RealDate = global.Date;

function utcNoonFor(ymd) {
  // Noon UTC is safely inside the same Chicago calendar day year-round
  // (never crosses midnight under CST -6 or CDT -5).
  const [y, m, d] = ymd.split('-').map(Number);
  return RealDate.UTC(y, m - 1, d, 12, 0, 0);
}

function withFakeToday(ymd, fn) {
  const fixedMs = utcNoonFor(ymd);
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(fixedMs);
      return new RealDate(...args);
    }
    static now() { return fixedMs; }
  }
  global.Date = FakeDate;
  return Promise.resolve()
    .then(fn)
    .finally(() => { global.Date = RealDate; });
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new RealDate(RealDate.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Fake Supabase REST + Resend backend
// ---------------------------------------------------------------------------
const db = {
  subscriptions: [{ user_id: 'U1', plan: 'solo', status: 'active' }],
  profiles: [{ id: 'U1', email: 'agent@example.com', full_name: 'Test Agent', preferred_name: null, is_demo: false }],
  transactions: new Map(), // id -> tx object (mutated directly to simulate amendments)
  deadline_reminders: [], // { id, transaction_id, user_id, deadline_type, deadline_date, days_out, email_to }
  wire_fraud_deliveries: [], // pre-seed per transaction_id to suppress that block's noise
};
let nextReminderId = 1;
const sentEmails = [];

function baseTx(overrides) {
  return Object.assign({
    user_id: 'U1',
    property_address: '507 Ridge Bluff',
    status: 'under_contract',
    role: 'buyer',
    transaction_type: 'buyer_purchase',
    option_expiration_date: null,
    closing_date: null,
    appraisal_deadline: null,
    survey_deadline: null,
    hoa_document_deadline: null,
    loan_approval_deadline: null,
    possession_date: null,
    option_fee_due_date: null,
    earnest_money_due_date: null,
    contract_effective_date: null,
    option_fee_confirmed_at: null,
    earnest_money_confirmed_at: null,
    inspection_scheduled_at: null,
    inspection_completed_at: null,
    appraisal_received_at: null,
    loan_approval_received_at: null,
    hoa_docs_received_at: null,
    inspector_name: null,
    inspector_phone: null,
    lease_renewal_deadline: null,
    lease_move_in_date: null,
    lease_hoa_approval_required: null,
    lease_hoa_approval_received: null,
    lease_start_date: null,
    expected_completion_date: null,
    co_received_date: null,
    builder_warranty_expiration: null,
    land_survey_ordered_date: null,
    land_survey_received_date: null,
    land_survey_clear: null,
  }, overrides);
}

function qs(url) {
  return new URL(url, 'http://fake.local').searchParams;
}

function parseEq(params, key) {
  const v = params.get(key);
  if (!v) return null;
  return v.startsWith('eq.') ? v.slice(3) : null;
}

global.fetch = async function fakeFetch(url, init = {}) {
  const u = new URL(url, 'http://fake.local');
  const method = (init.method || 'GET').toUpperCase();
  const params = u.searchParams;

  // Resend
  if (u.hostname === 'api.resend.com') {
    const body = JSON.parse(init.body);
    sentEmails.push(body);
    return jsonResponse(200, { id: `email_${sentEmails.length}` });
  }

  // Telemetry — accept and ignore.
  if (u.pathname === '/rest/v1/cron_runs') {
    return jsonResponse(200, null);
  }

  if (u.pathname === '/rest/v1/subscriptions') {
    const status = parseEq(params, 'status');
    const rows = db.subscriptions.filter((s) => !status || s.status === status);
    return jsonResponse(200, rows);
  }

  if (u.pathname === '/rest/v1/profiles') {
    const idIn = params.get('id');
    let ids = null;
    if (idIn && idIn.startsWith('in.(')) {
      ids = idIn.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
    }
    const rows = db.profiles.filter((p) => !ids || ids.includes(p.id));
    return jsonResponse(200, rows);
  }

  if (u.pathname === '/rest/v1/transactions') {
    const userId = parseEq(params, 'user_id');
    const rows = [...db.transactions.values()].filter((t) => !userId || t.user_id === userId)
      .filter((t) => t.status !== 'closed');
    return jsonResponse(200, rows);
  }

  if (u.pathname === '/rest/v1/deadline_reminders') {
    if (method === 'GET') {
      const txId = parseEq(params, 'transaction_id');
      const rows = db.deadline_reminders
        .filter((r) => !txId || r.transaction_id === txId)
        .map((r) => ({ id: r.id, deadline_type: r.deadline_type, days_out: r.days_out, deadline_date: r.deadline_date }));
      return jsonResponse(200, rows);
    }
    if (method === 'POST') {
      const row = JSON.parse(init.body);
      const dup = db.deadline_reminders.find(
        (r) => r.transaction_id === row.transaction_id && r.deadline_type === row.deadline_type && r.days_out === row.days_out,
      );
      if (dup) return jsonResponse(409, { code: '23505', message: 'duplicate key' });
      const saved = Object.assign({ id: String(nextReminderId++) }, row);
      db.deadline_reminders.push(saved);
      return jsonResponse(201, null);
    }
    if (method === 'DELETE') {
      const id = parseEq(params, 'id');
      const before = db.deadline_reminders.length;
      db.deadline_reminders = db.deadline_reminders.filter((r) => r.id !== id);
      return jsonResponse(before !== db.deadline_reminders.length ? 204 : 404, null);
    }
  }

  if (u.pathname === '/rest/v1/documents') {
    return jsonResponse(200, []);
  }

  if (u.pathname === '/rest/v1/wire_fraud_deliveries') {
    const txId = parseEq(params, 'transaction_id');
    const rows = db.wire_fraud_deliveries.filter((r) => r.transaction_id === txId);
    return jsonResponse(200, rows);
  }

  throw new Error(`fakeFetch: unhandled ${method} ${u.pathname}${u.search}`);
};

function jsonResponse(status, data) {
  const text = data === null ? '' : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// ---------------------------------------------------------------------------
// Run the REAL handler for one fake "today".
// ---------------------------------------------------------------------------
const cronHandler = require(CRON_PATH);

async function runCronOn(ymd) {
  let body = null;
  const req = { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } };
  const res = {
    statusCode: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await withFakeToday(ymd, () => cronHandler(req, res));
  return { statusCode: res.statusCode, body };
}

function remindersFor(txId, deadlineType) {
  return db.deadline_reminders
    .filter((r) => r.transaction_id === txId && r.deadline_type === deadlineType)
    .map((r) => ({ days_out: r.days_out, deadline_date: r.deadline_date }))
    .sort((a, b) => b.days_out - a.days_out);
}

function printRows(label, txId, deadlineType) {
  console.log(`    ${label}:`, JSON.stringify(remindersFor(txId, deadlineType)));
}

async function main() {
  console.log('deadline-reminder staleness regression — 507 Ridge Bluff fix (2026-10-08)');
  console.log('=========================================================================================');

  assert.ok(cronHandler.__test && typeof cronHandler.__test.isAlreadySentForCurrentDate === 'function',
    'cron-deadline-reminders.js does not expose __test.isAlreadySentForCurrentDate (pre-fix code)');

  const D0 = '2026-10-08'; // "today" for the first simulated run — arbitrary anchor

  // === SCENARIO 1: Ridge Bluff — closing date pushed LATER after T-7/T-1 already fired ===
  const OLD_CLOSE = addDays(D0, 7);
  // role: 'listing' so final_walkthrough (buyer-only, same column) stays out
  // of this scenario's counts — that combination gets its own Scenario 4/5.
  db.transactions.set('T1', baseTx({ id: 'T1', user_id: 'U1', property_address: '507 Ridge Bluff', role: 'listing', closing_date: OLD_CLOSE }));
  db.wire_fraud_deliveries.push({ id: 'wfd1', transaction_id: 'T1' }); // suppress unrelated block's noise

  console.log(`\n  Day A (today=${D0}): closing_date=${OLD_CLOSE} -> T-7 should fire`);
  let r = await runCronOn(D0);
  assert.strictEqual(r.body.ok, true, `Day A run not ok: ${JSON.stringify(r.body.errors)}`);
  printRows('rows after Day A', 'T1', 'closing_date');
  assert.deepStrictEqual(remindersFor('T1', 'closing_date'), [{ days_out: 7, deadline_date: OLD_CLOSE }]);

  const dayB = addDays(D0, 6); // OLD_CLOSE - 1
  console.log(`\n  Day B (today=${dayB}): closing_date still ${OLD_CLOSE} -> T-1 should fire`);
  r = await runCronOn(dayB);
  assert.strictEqual(r.body.ok, true, `Day B run not ok: ${JSON.stringify(r.body.errors)}`);
  printRows('rows after Day B', 'T1', 'closing_date');
  assert.deepStrictEqual(remindersFor('T1', 'closing_date'), [
    { days_out: 7, deadline_date: OLD_CLOSE },
    { days_out: 1, deadline_date: OLD_CLOSE },
  ]);
  const emailsBeforeAmendment = sentEmails.length;

  // THE AMENDMENT — TREC 39-11 pushes closing out 15 days.
  const NEW_CLOSE = addDays(OLD_CLOSE, 15);
  db.transactions.get('T1').closing_date = NEW_CLOSE;
  console.log(`\n  AMENDMENT: closing_date ${OLD_CLOSE} -> ${NEW_CLOSE}`);

  console.log(`\n  Day C (today=${dayB}, same day, right after the amendment): nothing should fire yet`);
  r = await runCronOn(dayB);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(sentEmails.length, emailsBeforeAmendment, 'no reminder should fire the instant the amendment lands — new date is not yet in any milestone window');
  printRows('rows after Day C (unchanged, old rows still dormant)', 'T1', 'closing_date');
  assert.deepStrictEqual(remindersFor('T1', 'closing_date'), [
    { days_out: 7, deadline_date: OLD_CLOSE },
    { days_out: 1, deadline_date: OLD_CLOSE },
  ], 'stale rows for days_out not yet reached by the new date must stay untouched until their own check runs');

  const dayD = addDays(NEW_CLOSE, -7);
  console.log(`\n  Day D (today=${dayD} = NEW_CLOSE-7): stale T-7 row (against OLD_CLOSE) must be invalidated and regenerated against NEW_CLOSE`);
  r = await runCronOn(dayD);
  assert.strictEqual(r.body.ok, true, `Day D run not ok: ${JSON.stringify(r.body.errors)}`);
  assert.strictEqual(r.body.reminders_invalidated_stale, 1, 'exactly one stale row (the old T-7) should have been invalidated');
  printRows('rows after Day D', 'T1', 'closing_date');
  assert.deepStrictEqual(remindersFor('T1', 'closing_date'), [
    { days_out: 7, deadline_date: NEW_CLOSE },
    { days_out: 1, deadline_date: OLD_CLOSE }, // T-1 slot not reached yet this run — still dormant
  ]);

  const dayE = addDays(NEW_CLOSE, -1);
  console.log(`\n  Day E (today=${dayE} = NEW_CLOSE-1): stale T-1 row (against OLD_CLOSE) must be invalidated and regenerated against NEW_CLOSE`);
  r = await runCronOn(dayE);
  assert.strictEqual(r.body.ok, true, `Day E run not ok: ${JSON.stringify(r.body.errors)}`);
  assert.strictEqual(r.body.reminders_invalidated_stale, 1);
  printRows('rows after Day E', 'T1', 'closing_date');
  assert.deepStrictEqual(remindersFor('T1', 'closing_date'), [
    { days_out: 7, deadline_date: NEW_CLOSE },
    { days_out: 1, deadline_date: NEW_CLOSE },
  ], 'both reminders now correctly reflect the amended closing date');
  const emailCountAfterDayE = sentEmails.length;

  console.log(`\n  Day E2 (today=${dayE} again, same day re-run): idempotency must survive the fix — no second send`);
  r = await runCronOn(dayE);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.reminders_invalidated_stale, 0, 'nothing should be invalidated the second time — the row already matches the current date');
  assert.strictEqual(sentEmails.length, emailCountAfterDayE, 'must not double-send on a same-day re-run');
  printRows('rows after Day E2 (unchanged)', 'T1', 'closing_date');
  assert.deepStrictEqual(remindersFor('T1', 'closing_date'), [
    { days_out: 7, deadline_date: NEW_CLOSE },
    { days_out: 1, deadline_date: NEW_CLOSE },
  ]);
  console.log('  PASS: Scenario 1 (later move, stale invalidation + idempotency survives)');

  // === SCENARIO 2: closing date moved EARLIER — must not spam retroactively ===
  const farClose = addDays(D0, 30);
  db.transactions.set('T2', baseTx({ id: 'T2', user_id: 'U1', property_address: '12 Early Move Ln', closing_date: farClose }));
  db.wire_fraud_deliveries.push({ id: 'wfd2', transaction_id: 'T2' });
  const pastClose = addDays(D0, -5); // moved to a date already behind "today"
  db.transactions.get('T2').closing_date = pastClose;
  console.log(`\n  Scenario 2 (today=${D0}): closing_date moved from ${farClose} to ${pastClose} (now in the past) — no reminder, no spam`);
  const emailsBefore2 = sentEmails.length;
  r = await runCronOn(D0);
  assert.strictEqual(r.body.ok, true, `Scenario 2 run not ok: ${JSON.stringify(r.body.errors)}`);
  assert.strictEqual(sentEmails.length, emailsBefore2, 'a deadline that is already in the past for every milestone must not fire anything');
  printRows('rows for T2 (closing_date)', 'T2', 'closing_date');
  assert.deepStrictEqual(remindersFor('T2', 'closing_date'), [], 'nothing was ever sent for this transaction, and the past move must not create a row either');
  console.log('  PASS: Scenario 2 (earlier move does not retroactively spam)');

  // === SCENARIO 3: silent-failure alarm — deadline inside window, zero reminders ever ===
  db.transactions.set('T3', baseTx({ id: 'T3', user_id: 'U1', property_address: '9 Missed Day Ct', closing_date: addDays(D0, 3) }));
  db.wire_fraud_deliveries.push({ id: 'wfd3', transaction_id: 'T3' });
  console.log(`\n  Scenario 3 (today=${D0}): closing_date=${addDays(D0, 3)} (3 days out, inside the T-7 window) with ZERO reminders ever recorded`);
  r = await runCronOn(D0);
  assert.strictEqual(r.body.ok, false, 'a silent-failure alert must flip ok to false, not look like a clean run');
  const alert = r.body.silent_failure_alerts.find((a) => a.tx_id === 'T3' && a.deadline_type === 'closing_date');
  assert.ok(alert, `expected a silent_failure_alert for T3/closing_date, got: ${JSON.stringify(r.body.silent_failure_alerts)}`);
  console.log('    silent_failure_alerts entry:', JSON.stringify(alert));
  console.log('  PASS: Scenario 3 (silent-failure alarm fires when a deadline is inside the window with nothing recorded)');
  // Close T3 out so its (deliberately unresolved) alarm doesn't leak into
  // every later scenario's ok:true assertions below.
  db.transactions.get('T3').status = 'closed';

  // === SCENARIO 4: final_walkthrough — buyer-side only, T-7/T-3/T-1 off closing_date ===
  const fwClose = addDays(D0, 7);
  db.transactions.set('T4', baseTx({ id: 'T4', user_id: 'U1', property_address: '44 Buyer Side Dr', role: 'buyer', closing_date: fwClose }));
  db.wire_fraud_deliveries.push({ id: 'wfd4', transaction_id: 'T4' });
  db.transactions.set('T5', baseTx({ id: 'T5', user_id: 'U1', property_address: '55 Listing Side Dr', role: 'listing', closing_date: fwClose }));
  db.wire_fraud_deliveries.push({ id: 'wfd5', transaction_id: 'T5' });

  console.log(`\n  Scenario 4 (today=${D0}): closing_date=${fwClose} (T-7) for a buyer-side (T4) and a listing-side (T5) transaction`);
  r = await runCronOn(D0);
  assert.strictEqual(r.body.ok, true, `Scenario 4 run not ok: ${JSON.stringify(r.body.errors)}`);
  printRows('T4 (buyer-side) final_walkthrough rows', 'T4', 'final_walkthrough');
  printRows('T5 (listing-side) final_walkthrough rows', 'T5', 'final_walkthrough');
  assert.deepStrictEqual(remindersFor('T4', 'final_walkthrough'), [{ days_out: 7, deadline_date: fwClose }], 'buyer-side T-7 final walkthrough reminder must fire');
  assert.deepStrictEqual(remindersFor('T5', 'final_walkthrough'), [], 'listing-side must NEVER get a final walkthrough reminder');
  // Standard closing_date reminder must be unaffected/independent (also fires for T4, not a duplicate key collision).
  assert.deepStrictEqual(remindersFor('T4', 'closing_date'), [{ days_out: 7, deadline_date: fwClose }], 'the standard closing reminder must still fire independently (distinct deadline_type, no collision)');

  const fwDay3 = addDays(fwClose, -3);
  console.log(`\n  Day (today=${fwDay3} = closing-3): T-3 "confirm it's booked" should fire for T4 only`);
  r = await runCronOn(fwDay3);
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(remindersFor('T4', 'final_walkthrough'), [
    { days_out: 7, deadline_date: fwClose },
    { days_out: 3, deadline_date: fwClose },
  ]);
  assert.deepStrictEqual(remindersFor('T5', 'final_walkthrough'), []);

  const fwDay1 = addDays(fwClose, -1);
  console.log(`\n  Day (today=${fwDay1} = closing-1): T-1 "the walkthrough itself" should fire for T4 only`);
  r = await runCronOn(fwDay1);
  assert.strictEqual(r.body.ok, true);
  printRows('T4 final_walkthrough after all 3 beats', 'T4', 'final_walkthrough');
  assert.deepStrictEqual(remindersFor('T4', 'final_walkthrough'), [
    { days_out: 7, deadline_date: fwClose },
    { days_out: 3, deadline_date: fwClose },
    { days_out: 1, deadline_date: fwClose },
  ]);
  assert.deepStrictEqual(remindersFor('T5', 'final_walkthrough'), [], 'listing-side stays empty across the whole chain');
  console.log('  PASS: Scenario 4 (final_walkthrough: buyer-side only, 3 beats, no collision with closing_date)');

  // === SCENARIO 5: final_walkthrough also self-heals on a closing date move ===
  const fwNewClose = addDays(fwClose, 10);
  db.transactions.get('T4').closing_date = fwNewClose;
  const fwNewDay1 = addDays(fwNewClose, -1);
  console.log(`\n  Scenario 5: T4 closing moved ${fwClose} -> ${fwNewClose}; at new T-1 (${fwNewDay1}) the stale old T-1 final_walkthrough row must regenerate too`);
  r = await runCronOn(fwNewDay1);
  assert.strictEqual(r.body.ok, true, `Scenario 5 run not ok: ${JSON.stringify(r.body.errors)}`);
  printRows('T4 final_walkthrough after the move', 'T4', 'final_walkthrough');
  const fwRows = remindersFor('T4', 'final_walkthrough');
  const t1Row = fwRows.find((x) => x.days_out === 1);
  assert.ok(t1Row && t1Row.deadline_date === fwNewClose, 'final_walkthrough T-1 must regenerate against the moved closing date, same mechanism as closing_date itself');
  console.log('  PASS: Scenario 5 (final_walkthrough inherits the amendment fix)');

  console.log('\n=========================================================================================');
  console.log('All tests passed');
}

main().catch((e) => {
  global.Date = RealDate;
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
});
