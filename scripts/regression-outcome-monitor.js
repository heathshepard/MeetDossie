#!/usr/bin/env node
'use strict';

// scripts/regression-outcome-monitor.js
//
// Pure-logic regression for the outcome monitor. No network, no database.
// Covers the parts where a silent mistake would reintroduce exactly the bug
// class the monitor exists to catch:
//   - query construction + the filter allowlist (a stored filter is data in a
//     table, therefore an injection surface)
//   - window direction (recent vs older_than) and the inverted assertion
//   - the escalation ladder: intervals SHRINK, a new cause is never suppressed,
//     and a long-dead pipeline does not start at level 0
//   - the telemetry item-count extraction that makes "ok, 0 items" possible
//
// Usage: node scripts/regression-outcome-monitor.js

const assert = require('assert');

const {
  buildQuery, countProjection, isInverted, windowMode, validColumn, ALLOWED_OPS,
} = require('../api/_lib/outcome-expectations.js');
const telegramGate = require('../api/_lib/telegram-gate.js');
const { classifyDelivery } = require('../api/_lib/outcome-monitor.js');
const esc = require('../api/_lib/outcome-escalation.js');
const { extractItemCount, withOutcome } = require('../api/_lib/cron-telemetry.js');
const { REGISTRY, allowedByMode } = require('../api/_lib/outcome-remediation.js');
const { CLASSIFIERS } = require('../api/_lib/outcome-causes.js');

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0); // fixed clock
let passed = 0;
function t(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
async function ta(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('\nquery construction');

t('builds a recent-window count query', () => {
  const q = buildQuery({
    source_table: 'group_posts', source_filters: { status: 'eq.posted' },
    time_column: 'posted_at', window_hours: 24, min_count: 1,
  }, { nowMs: NOW });
  assert.strictEqual(q, 'group_posts?select=posted_at&status=eq.posted&posted_at=gte.2026-09-24T12:00:00.000Z');
});

t('the count projection never ASSUMES an id column', () => {
  // Regression for the shipped defect: `select=id` was hardcoded, and
  // credential_health's primary key is `channel` with no id column at all, so
  // PostgREST answered credential_probe_fresh with HTTP 400 on every run.
  const credentialProbe = {
    source_table: 'credential_health', source_filters: {},
    time_column: 'last_probe_at', window_hours: 48, min_count: 1,
  };
  assert.strictEqual(countProjection(credentialProbe), 'last_probe_at');
  assert.ok(!buildQuery(credentialProbe, { nowMs: NOW }).includes('select=id'),
    'must not project a column the table may not have');
  // No time column and nothing declared: '*' exists on every table.
  assert.strictEqual(countProjection({ source_table: 'x', source_filters: {} }), '*');
  // An explicit override wins, and is validated like any other identifier.
  assert.strictEqual(countProjection({ count_column: 'channel', time_column: 'last_probe_at' }), 'channel');
  assert.throws(() => countProjection({ count_column: 'id&select=*' }), /invalid count_column/);
});

t('no seeded expectation projects a column its table may lack', () => {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260925_outcome_monitor.sql'), 'utf8');
  const seed = JSON.parse(sql.match(/jsonb_to_recordset\(\$seed\$([\s\S]*?)\$seed\$::jsonb/)[1]);
  for (const e of seed) {
    const proj = countProjection(e);
    // Either the expectation's own time_column, its declared count_column, or
    // '*' — never a name nobody checked.
    assert.ok(proj === '*' || proj === e.time_column || proj === e.count_column,
      `${e.key} projects "${proj}", which is not a column it declares`);
  }
});

t('older_than flips the comparison', () => {
  const q = buildQuery({
    source_table: 'social_posts', source_filters: { status: 'eq.pending_video' },
    time_column: 'created_at', window_mode: 'older_than', window_hours: 48, min_count: 0,
  }, { nowMs: NOW });
  assert.ok(q.includes('created_at=lt.2026-09-23T12:00:00.000Z'), q);
});

t('window direction is never inferred from min_count', () => {
  // min_count=0 alone must NOT flip the comparison — cron_outcome_reporting is
  // inverted AND recent. Conflating the two asks the wrong question silently.
  const q = buildQuery({
    source_table: 'cron_runs', source_filters: {},
    time_column: 'last_run', window_mode: 'recent', window_hours: 24, min_count: 0,
  }, { nowMs: NOW });
  assert.ok(q.includes('last_run=gte.'), q);
  assert.strictEqual(windowMode({ window_mode: 'recent' }), 'recent');
  assert.strictEqual(isInverted({ min_count: 0 }), true);
});

t('allows a JSON-path column', () => {
  const q = buildQuery({
    source_table: 'cron_runs', source_filters: { 'last_meta->>outcome': 'is.null' },
    min_count: 0,
  }, { nowMs: NOW });
  assert.ok(q.includes('last_meta->>outcome=is.null'), q);
  assert.ok(validColumn('last_meta->>outcome'));
});

t('rejects an injected column name', () => {
  assert.throws(() => buildQuery({
    source_table: 'social_posts', source_filters: { 'id&select=*;drop': 'eq.1' }, min_count: 1,
  }), /invalid filter column/);
  assert.strictEqual(validColumn('id&select=*'), false);
});

t('rejects an operator outside the allowlist', () => {
  assert.throws(() => buildQuery({
    source_table: 'social_posts', source_filters: { status: 'fts.posted' }, min_count: 1,
  }), /disallowed operator/);
  assert.ok(ALLOWED_OPS.has('eq'));
  assert.ok(!ALLOWED_OPS.has('fts'));
});

t('rejects an injected table name', () => {
  assert.throws(() => buildQuery({ source_table: 'social_posts?x=1', source_filters: {}, min_count: 1 }),
    /invalid source_table/);
});

console.log('\nescalation ladder');

t('resend interval SHRINKS as level rises — never backs off', () => {
  const iv = [0, 1, 2, 3].map((l) => esc.resendIntervalHours(l));
  assert.deepStrictEqual(iv, [24, 12, 6, 3]);
  for (let i = 1; i < iv.length; i += 1) {
    assert.ok(iv[i] < iv[i - 1], `level ${i} must be louder than ${i - 1}`);
  }
});

t('level climbs with age', () => {
  assert.strictEqual(esc.levelForAge(1), 0);
  assert.strictEqual(esc.levelForAge(25), 1);
  assert.strictEqual(esc.levelForAge(80), 2);
  assert.strictEqual(esc.levelForAge(200), 3);
  assert.strictEqual(esc.levelForAge(10000), 3); // clamped to the table
});

t('a NEW problem class is never suppressed by a cooldown', () => {
  const exp = { grace_hours: 0 };
  const incident = { opened_at: new Date().toISOString(), escalation_level: 0,
                     last_escalated_at: new Date().toISOString() };
  // Same incident, just escalated: held.
  assert.strictEqual(esc.shouldEscalate(exp, incident, { isNew: false }).escalate, false);
  // Brand-new incident (a different cause opens its own row): fires regardless.
  assert.strictEqual(esc.shouldEscalate(exp, incident, { isNew: true }).escalate, true);
});

t('an unresolved incident speaks again once its shrinking interval elapses', () => {
  const exp = { grace_hours: 0 };
  const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  // level 0 -> 24h interval -> still held at 7h
  assert.strictEqual(esc.shouldEscalate(exp,
    { opened_at: sevenHoursAgo, escalation_level: 0, last_escalated_at: sevenHoursAgo },
    {}).escalate, false);
  // level 2 -> 6h interval -> fires at 7h. Older problem, louder.
  assert.strictEqual(esc.shouldEscalate(exp,
    { opened_at: sevenHoursAgo, escalation_level: 2, last_escalated_at: sevenHoursAgo },
    {}).escalate, true);
});

t('true outage age beats "when the monitor first looked"', () => {
  const justOpened = { opened_at: new Date().toISOString(), escalation_level: 0 };
  // Nothing known: age is how long the incident has been open (~0h).
  assert.ok(esc.incidentAgeHours(justOpened) < 1);
  // System of record says 8 days: that wins, on the very first check.
  assert.ok(esc.incidentAgeHours(justOpened, 192) >= 192);
  // And it is always the larger of the two — noticing late cannot shrink it.
  const old = { opened_at: new Date(Date.now() - 300 * 3600 * 1000).toISOString() };
  assert.ok(esc.incidentAgeHours(old, 10) >= 300);
});

t('grace period cannot hide an already-long outage', () => {
  const exp = { grace_hours: 6 };
  const incident = { opened_at: new Date().toISOString(), escalation_level: 0 };
  // Freshly noticed, genuinely new: held by grace.
  assert.strictEqual(esc.shouldEscalate(exp, incident, { isNew: true, outageHours: 1 }).escalate, false);
  // Freshly noticed, but dead 8 days: fires immediately.
  assert.strictEqual(esc.shouldEscalate(exp, incident, { isNew: true, outageHours: 192 }).escalate, true);
});

t('the alert carries cost AND cure', () => {
  const exp = {
    label: 'Facebook group posts published', window_hours: 24,
    cost_unit: 'group posts unsent', human_fix_minutes: 2,
    human_fix: 'Open Chrome on the DossieBot-Sage profile and log into Facebook.',
  };
  const incident = {
    opened_at: new Date(Date.now() - 192 * 3600 * 1000).toISOString(),
    escalation_level: 3, backlog_count: 4,
  };
  const msg = esc.formatEscalation(exp, incident, { cause: 'credential_missing', confidence: 'high', detail: {} },
    { actual: 0, expected: 1, outage_hours: 192 });
  assert.ok(/8 days/.test(msg), msg);              // how long
  assert.ok(/4 group posts unsent/.test(msg), msg); // what it cost
  assert.ok(/~2 min to fix/.test(msg), msg);        // how cheap the fix is
  assert.ok(/DossieBot-Sage/.test(msg), msg);       // the exact fix
  assert.ok(/STILL BROKEN/.test(msg), msg);         // it gets louder
});

console.log('\ntelemetry outcome accounting');

t('a zero-item run is distinguishable from a working one', () => {
  assert.strictEqual(withOutcome({ published: 0, errors: 0 }).outcome, 'zero');
  assert.strictEqual(withOutcome({ published: 3 }).outcome, 'produced');
  assert.strictEqual(withOutcome({ published: 3 }).outcome_items, 3);
});

t('a run that reports no count at all is flagged blind, not healthy', () => {
  // This is cron-render-videos' exact last_meta.
  const m = withOutcome({ duration_ms: 168, http_status: 200 });
  assert.strictEqual(m.outcome, 'unknown');
  assert.strictEqual(m.outcome_items, undefined);
});

t('item counts sum across recognised keys', () => {
  assert.strictEqual(extractItemCount({ sent: 2, failed: 1, published: 3 }), 5); // failed is not an item key
  assert.strictEqual(extractItemCount({ duration_ms: 12 }), null);
  assert.strictEqual(extractItemCount(null), null);
});

console.log('\nremediation registry');

t('every registry entry declares a side effect and what it handles', () => {
  for (const [key, entry] of Object.entries(REGISTRY)) {
    assert.ok(typeof entry.run === 'function', `${key} has no run()`);
    assert.ok(['internal_state', 'causes_publish', 'read_only'].includes(entry.side_effect), `${key} side_effect`);
    assert.ok(Array.isArray(entry.handles) && entry.handles.length, `${key} handles`);
    assert.ok(typeof entry.describes === 'string' && entry.describes.length > 20, `${key} describes`);
  }
});

t('safe mode can never run a publish-causing remediation', () => {
  for (const entry of Object.values(REGISTRY)) {
    if (entry.side_effect === 'causes_publish') {
      assert.strictEqual(allowedByMode(entry, 'safe'), false);
      assert.strictEqual(allowedByMode(entry, 'off'), false);
      assert.strictEqual(allowedByMode(entry, 'full'), true);
    } else {
      assert.strictEqual(allowedByMode(entry, 'safe'), true);
      assert.strictEqual(allowedByMode(entry, 'off'), false);
    }
  }
});

t('every classifier named in the seed exists', () => {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20260925_outcome_monitor.sql'), 'utf8');
  const m = sql.match(/jsonb_to_recordset\(\$seed\$([\s\S]*?)\$seed\$::jsonb/);
  assert.ok(m, 'seed block not found');
  const seed = JSON.parse(m[1]);
  assert.ok(seed.length >= 8, `expected a real expectation set, got ${seed.length}`);
  for (const e of seed) {
    for (const c of e.classifiers || []) {
      assert.ok(CLASSIFIERS[c], `expectation ${e.key} names unknown classifier "${c}"`);
    }
    for (const r of e.remediations || []) {
      assert.ok(REGISTRY[r], `expectation ${e.key} names unknown remediation "${r}"`);
    }
    assert.ok(['off', 'safe', 'full'].includes(e.remediation_mode), `${e.key} remediation_mode`);
    // A human-only expectation with no fix text is an alert Heath cannot act on.
    if (e.human_only) assert.ok(e.human_fix, `${e.key} is human_only but has no human_fix`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ESCALATION DELIVERY ACCOUNTING
//
// The defect most likely to silently regress, and the one this whole system
// exists to prevent: recording an escalation as delivered when the telegram
// gate ate it. Shipped in 017aa8cf — markEscalated() ran at message-FORMAT
// time, before any send, and nothing checked wasSuppressed() on the gate's
// fake HTTP 200. A suppressed alert therefore stamped last_escalated_at and
// the ladder went quiet for 24h on a message Heath never received.
//
// These run against the REAL gate (its actual fake-200 response object), not a
// hand-written imitation, so a change to the gate's suppression contract fails
// here instead of silently reopening the hole.
// ─────────────────────────────────────────────────────────────────────────────
async function deliveryTests() {
  console.log('\nescalation delivery accounting');

  // Force the gate closed for this process regardless of local env, then take
  // the response it genuinely produces for a suppressed sendMessage.
  process.env.TELEGRAM_CRON_NOTIFICATIONS = 'off';
  telegramGate.install('regression-not-on-allowlist');
  const suppressedBody = await (await fetch(
    'https://api.telegram.org/bot123:FAKE/sendMessage',
    { method: 'POST', body: JSON.stringify({ chat_id: 1, text: 'regression probe' }) }
  )).json();

  await ta('the gate\'s suppression really does look like success', async () => {
    // If this ever stops being true the defect is impossible — but it IS true,
    // which is why res.ok was never enough.
    assert.strictEqual(suppressedBody.ok, true);
    assert.strictEqual(suppressedBody.suppressed, true);
    assert.strictEqual(telegramGate.wasSuppressed(suppressedBody), true);
    assert.strictEqual(telegramGate.isAllowed('regression-not-on-allowlist'), false);
  });

  await ta('a gate-suppressed send is classified suppressed, never sent', async () => {
    const d = classifyDelivery({ ok: true, status: 200, body: suppressedBody });
    assert.strictEqual(d.state, 'suppressed', 'the fake 200 must not read as a delivery');
  });

  await ta('a real send is classified sent; an error is classified failed', async () => {
    assert.strictEqual(classifyDelivery({
      ok: true, status: 200, body: { ok: true, result: { message_id: 4817 } },
    }).state, 'sent');
    assert.strictEqual(classifyDelivery({ ok: false, status: 429, body: { ok: false, description: 'Too Many Requests' } }).state, 'failed');
    assert.strictEqual(classifyDelivery({ error: 'socket hang up' }).state, 'failed');
    // ok:true with no message_id is not evidence of anything.
    assert.strictEqual(classifyDelivery({ ok: true, status: 200, body: { ok: true, result: {} } }).state, 'failed');
    // Nothing at all is failed, never sent — fail closed.
    assert.strictEqual(classifyDelivery({}).state, 'failed');
  });

  await ta('THE DEFECT: a suppressed send leaves the incident un-escalated and still due', async () => {
    const exp = { grace_hours: 0 };
    const incident = {
      id: 1, opened_at: new Date(Date.now() - 200 * 3600 * 1000).toISOString(),
      escalation_level: 3, escalation_count: 0, last_escalated_at: null,
      suppressed_escalations: 0, failed_escalations: 0,
    };
    // It is due right now.
    assert.strictEqual(esc.shouldEscalate(exp, incident, { isNew: true }).escalate, true);

    const patch = esc.escalationPatch(incident, classifyDelivery({ ok: true, status: 200, body: suppressedBody }));
    // The ladder must not move one inch.
    assert.ok(!('last_escalated_at' in patch), 'suppressed must NOT stamp last_escalated_at');
    assert.ok(!('escalation_count' in patch), 'suppressed must NOT advance escalation_count');
    assert.strictEqual(patch.suppressed_escalations, 1);
    assert.strictEqual(patch.last_delivery_state, 'suppressed');

    // And after applying it, the incident is STILL due — it speaks again on the
    // next run, and the moment the gate opens.
    const after = { ...incident, ...patch };
    assert.strictEqual(esc.shouldEscalate(exp, after, { isNew: false }).escalate, true,
      'a suppressed escalation must stay due, not cool off for 24h');
  });

  await ta('a failed send is also still due, and is distinguishable from suppressed', async () => {
    const incident = { id: 2, opened_at: new Date().toISOString(), escalation_level: 0,
                       escalation_count: 0, last_escalated_at: null, failed_escalations: 0 };
    const patch = esc.escalationPatch(incident, { state: 'failed', detail: 'telegram http 429' });
    assert.strictEqual(patch.last_delivery_state, 'failed');
    assert.strictEqual(patch.failed_escalations, 1);
    assert.ok(!('last_escalated_at' in patch));
    assert.strictEqual(esc.shouldEscalate({ grace_hours: 0 }, { ...incident, ...patch }, {}).escalate, true);
  });

  await ta('a CONFIRMED send still works the ladder normally — not spam, not silence', async () => {
    const exp = { grace_hours: 0 };
    const incident = { id: 3, opened_at: new Date(Date.now() - 200 * 3600 * 1000).toISOString(),
                       escalation_level: 3, escalation_count: 7, last_escalated_at: null };
    const patch = esc.escalationPatch(incident, classifyDelivery({
      ok: true, status: 200, body: { ok: true, result: { message_id: 991 } },
    }));
    assert.strictEqual(patch.last_delivery_state, 'sent');
    assert.strictEqual(patch.escalation_count, 8);
    assert.ok(patch.last_escalated_at, 'a confirmed send MUST stamp last_escalated_at');

    const after = { ...incident, ...patch };
    // Level 3 -> 3h interval. Held immediately after...
    assert.strictEqual(esc.shouldEscalate(exp, after, {}).escalate, false);
    // ...and due again 3h later. The ladder still gets louder, never quieter.
    after.last_escalated_at = new Date(Date.now() - 3.1 * 3600 * 1000).toISOString();
    assert.strictEqual(esc.shouldEscalate(exp, after, {}).escalate, true);
  });

  await ta('markEscalated is gone — no stamping without evidence', async () => {
    assert.strictEqual(typeof esc.markEscalated, 'undefined',
      'markEscalated() stamped the ladder before any send; it must not come back');
    assert.strictEqual(typeof esc.recordEscalationOutcome, 'function');
  });
}

deliveryTests().then(() => {
  console.log(`\n${passed} assertion group(s) passed${process.exitCode ? ' — WITH FAILURES' : ''}\n`);
});
