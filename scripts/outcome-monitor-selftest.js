#!/usr/bin/env node
'use strict';

// scripts/outcome-monitor-selftest.js
//
// Proves the SELF-HEALING half of the outcome monitor for real:
//   gap detected -> cause classified -> remediation run -> RE-MEASURED -> met,
//   and therefore NO alert sent.
//
// A dry run can only ever show what a remediation WOULD do. This exercises the
// real write path against the real database, which is the only way to know the
// loop closes.
//
// WHAT IT TOUCHES, exactly:
//   ONE synthetic social_posts row that this script creates and deletes.
//   - status='publishing', which NO publisher drains (cron-publish-approved
//     selects status='approved'), so it can never go out.
//   - zernio_post_id set to a selftest marker, i.e. it carries the delivery
//     evidence that makes reconciliation the correct action rather than a
//     resend.
//   - content carries the marker string so the scoped expectation matches only
//     this row and nothing real.
//   Deleted in a finally block whether the test passes, fails or throws.
//
// NOTHING PUBLISHES. The remediation under test moves a status forward to
// reflect a delivery that (in the fixture) already happened; it never calls a
// posting API.
//
// Usage: node scripts/outcome-monitor-selftest.js
//
// Owner: Atlas, 2026-09-25

const path = require('path');
const crypto = require('crypto');
const { loadEnvLocal } = require('./_lib/load-env-local.js');

loadEnvLocal(path.join(__dirname, '..'));

const { sb } = require('../api/_lib/outcome-expectations.js');
const { evaluate } = require('../api/_lib/outcome-monitor.js');

const MARKER = `atlas-outcome-selftest-${crypto.randomUUID()}`;

// A scoped expectation that can only ever see the fixture row.
const EXPECTATION = {
  key: '_selftest_stale_publish_lock',
  pipeline: 'social_publish',
  label: '[SELFTEST] fixture post reaches posted',
  source_table: 'social_posts',
  source_filters: { status: 'eq.posted', post_id: `eq.${MARKER}` },
  time_column: 'posted_at',
  window_mode: 'recent',
  window_hours: 24,
  min_count: 1,
  classifiers: ['stale_publish_lock'],
  remediations: ['clear_stale_publish_lock'],
  remediation_mode: 'safe',
  severity: 'info',
  grace_hours: 0,
  human_only: false,
  cost_unit: 'fixture rows',
};

async function insertFixture() {
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const { ok, status, data } = await sb('social_posts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      post_id: MARKER,
      platform: 'facebook',
      content: `[${MARKER}] outcome-monitor selftest fixture — safe to delete`,
      status: 'publishing',
      publishing_started_at: threeHoursAgo,
      zernio_post_id: `${MARKER}-delivery-evidence`,
      video_required: false,
    }]),
  });
  if (!ok) throw new Error(`fixture insert failed (${status}): ${JSON.stringify(data).slice(0, 300)}`);
  return Array.isArray(data) ? data[0] : data;
}

async function deleteFixture() {
  const r = await sb(`social_posts?post_id=eq.${encodeURIComponent(MARKER)}`, { method: 'DELETE' });
  return r.ok;
}

async function countOtherStalePublishing() {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { ok, data } = await sb(
    `social_posts?status=eq.publishing&publishing_started_at=lt.${cutoff}&select=id,post_id&limit=50`
  );
  if (!ok || !Array.isArray(data)) return null;
  return data.filter((r) => r.post_id !== MARKER).length;
}

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not loaded — check .env.local');
    process.exit(1);
  }

  // The remediation under test scans ALL stale publishing rows, capped at 25.
  // If real ones exist, it would touch them too — so refuse to run rather than
  // conflate a test with production traffic.
  const others = await countOtherStalePublishing();
  if (others === null) { console.error('could not check for other stale publishing rows — aborting'); process.exit(1); }
  if (others > 0) {
    console.error(`${others} REAL stale publishing row(s) exist. Refusing to run the selftest — ` +
                  'the remediation would touch them as well. Investigate those first.');
    process.exit(2);
  }

  let pass = false;
  try {
    console.log(`fixture marker: ${MARKER}`);
    await insertFixture();
    console.log('1. inserted fixture: status=publishing, stuck 3h, WITH delivery evidence (zernio_post_id)\n');

    const r = await evaluate(EXPECTATION, { dryRun: false });

    console.log('2. monitor result');
    console.log(`   status            : ${r.status}`);
    console.log(`   measured before   : ${r.actual} / floor ${r.expected}`);
    console.log(`   cause             : ${r.cause && r.cause.cause} (${r.cause && r.cause.confidence})`);
    for (const run of (r.remediation && r.remediation.runs) || []) {
      console.log(`   remediation       : ${run.remediation} -> ` +
        (run.attempted ? `${run.ok ? 'ok' : 'failed'}, ${run.changed} row(s)` : `skipped (${run.skipped_reason})`));
      if (run.detail) console.log(`                       ${JSON.stringify(run.detail).slice(0, 220)}`);
    }
    console.log(`   measured after    : ${r.actual_after_remediation}`);
    console.log(`   alert to Heath    : ${r.alert ? 'SENT' : 'none'}`);

    pass = r.status === 'remediated' && r.actual === 0 && r.actual_after_remediation >= 1 && !r.alert;

    console.log(`\n3. verdict: ${pass ? 'PASS' : 'FAIL'}`);
    if (pass) {
      console.log('   gap detected, cause classified, remediation applied, re-measure confirmed');
      console.log('   the fix, and Heath was never told — which is the entire point.');
    }
  } finally {
    const deleted = await deleteFixture();
    console.log(`\n4. fixture cleanup: ${deleted ? 'deleted' : 'DELETE FAILED — remove post_id=' + MARKER + ' by hand'}`);
    // Close the incident this run may have opened so the selftest leaves no
    // residue in the escalation ladder.
    try {
      await sb(`outcome_incidents?expectation_key=eq.${encodeURIComponent(EXPECTATION.key)}`, { method: 'DELETE' });
      await sb(`outcome_checks?expectation_key=eq.${encodeURIComponent(EXPECTATION.key)}`, { method: 'DELETE' });
    } catch { /* tables may not exist yet; nothing to clean */ }
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
