'use strict';

// api/_lib/deal-watch-reminder.test.js
//
// The still-true reminder, and why "say it once" alone was not enough.
//
// Replaying the real corpus over seven days showed the watcher behaving
// perfectly on the metric it was designed for — 1 notification instead of 26 —
// and simultaneously revealed that 23 Nopalito's blind spot, the case the whole
// feature exists for, was recorded at baseline and then never mentioned again.
// A standing, unresolved, expensive condition going permanently quiet is the
// regression-suite failure wearing the opposite mask. These tests pin the fix.
//
// Run: node --test api/_lib/deal-watch-reminder.test.js

const test = require('node:test');
const assert = require('node:assert');

const {
  decideFact, decideRun, reminderKeyFor, REMINDER_DAYS,
} = require('./deal-watch-policy.js');

const BASE = '2026-09-20T00:00:00Z';

test('a standing unresolved condition is not silent forever', () => {
  const o = {
    factKey: 'missing_contacts:nop:no-contacts:high',
    dealId: 'nop', consequence: 'high', observedAt: '2026-08-09T00:00:00Z',
  };
  const known = new Set([o.factKey]);
  const firstSeen = new Map([[o.factKey, BASE]]);

  // Day 5 — inside the window. Silence.
  let d = decideFact({
    observation: o, knownFactKeys: known, factFirstSeen: firstSeen,
    nowMs: Date.parse('2026-09-25T00:00:00Z'), baselineAt: BASE, notifyEnabled: true,
  });
  assert.strictEqual(d.speak, false, 'no nagging inside the reminder window');

  // Day 15 — one reminder.
  d = decideFact({
    observation: o, knownFactKeys: known, factFirstSeen: firstSeen,
    nowMs: Date.parse('2026-10-05T00:00:00Z'), baselineAt: BASE, notifyEnabled: true,
  });
  assert.strictEqual(d.speak, true, 'a still-true expensive condition must resurface');
  assert.strictEqual(d.isReminder, true);
  assert.ok(d.reminderKey.endsWith(':still-true:1'), d.reminderKey);
});

test('the reminder is once per period, not a daily nag', () => {
  const o = {
    factKey: 'missing_contacts:nop:no-contacts:high',
    dealId: 'nop', consequence: 'high', observedAt: '2026-08-09T00:00:00Z',
  };
  const known = new Set([o.factKey]);
  const firstSeen = new Map([[o.factKey, BASE]]);

  let alerts = 0;
  for (let day = 15; day <= 27; day += 1) {
    const nowMs = Date.parse(BASE) + day * 86400000;
    const r = decideRun({
      observations: [o], knownFactKeys: known, factFirstSeen: firstSeen,
      nowMs, baselineAt: BASE, notifyEnabled: true,
    });
    alerts += r.spoken.length;
    for (const s of r.spoken) known.add(s.reminderKey);
  }
  assert.strictEqual(alerts, 1, `13 days inside one ${REMINDER_DAYS}-day period must yield exactly one reminder`);
});

test('a dormant deal earns no reminder either', () => {
  const o = {
    factKey: 'missing_contacts:nop:no-contacts:high',
    dealId: 'nop', consequence: 'high', observedAt: '2026-08-09T00:00:00Z',
  };
  const d = decideFact({
    observation: o, knownFactKeys: new Set([o.factKey]),
    factFirstSeen: new Map([[o.factKey, BASE]]),
    dormant: true,
    nowMs: Date.parse('2026-10-05T00:00:00Z'), baselineAt: BASE, notifyEnabled: true,
  });
  assert.strictEqual(d.speak, false, 'an abandoned record does not get nudged about');
});

test('a low-consequence standing fact never earns a reminder', () => {
  const o = {
    factKey: 'party_reply:d1:old:low',
    dealId: 'd1', consequence: 'low', observedAt: '2026-08-01T00:00:00Z',
  };
  const d = decideFact({
    observation: o, knownFactKeys: new Set([o.factKey]),
    factFirstSeen: new Map([[o.factKey, '2026-09-01T00:00:00Z']]),
    nowMs: Date.parse('2026-10-30T00:00:00Z'), baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true,
  });
  assert.strictEqual(d.speak, false, 'reminders are for things that cost something, not for everything');
});

test('the flag still gates a reminder', () => {
  const o = {
    factKey: 'missing_contacts:nop:no-contacts:high',
    dealId: 'nop', consequence: 'high', observedAt: '2026-08-09T00:00:00Z',
  };
  const d = decideFact({
    observation: o, knownFactKeys: new Set([o.factKey]),
    factFirstSeen: new Map([[o.factKey, BASE]]),
    nowMs: Date.parse('2026-10-05T00:00:00Z'), baselineAt: BASE, notifyEnabled: false,
  });
  assert.strictEqual(d.speak, false, 'the switch governs reminders exactly as it governs new facts');
});

test('reminderKeyFor is a pure function of fact and elapsed time', () => {
  assert.strictEqual(reminderKeyFor('k', BASE, Date.parse('2026-09-25T00:00:00Z')), null);
  assert.strictEqual(reminderKeyFor('k', BASE, Date.parse('2026-10-05T00:00:00Z')), 'k:still-true:1');
  assert.strictEqual(reminderKeyFor('k', BASE, Date.parse('2026-10-19T00:00:00Z')), 'k:still-true:2');
  assert.strictEqual(reminderKeyFor('k', null, Date.now()), null, 'no first-seen means no reminder');
});
