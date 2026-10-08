#!/usr/bin/env node
'use strict';

// scripts/outcome-monitor-verify.js
//
// Runs the outcome monitor end-to-end against LIVE data without writing or
// sending anything, and reports which of the eight 2026-09 failures it would
// have caught.
//
// Expectation source, in order:
//   1. the outcome_expectations table, if the migration has been applied
//   2. otherwise the $seed$ JSON block inside
//      supabase/migrations/20260925_outcome_monitor.sql -- the SAME bytes the
//      table is seeded from, so a pre-migration verification run can never be
//      testing a different expectation set than production will hold.
//
// Everything runs with dryRun:true, so:
//   - no outcome_incidents rows are opened or advanced
//   - no Telegram message is sent
//   - no remediation mutates a row (each reports what it WOULD do)
// Nothing here can publish.
//
// Usage:
//   node scripts/outcome-monitor-verify.js
//   node scripts/outcome-monitor-verify.js --key fb_group_posts_daily
//   node scripts/outcome-monitor-verify.js --json
//
// Owner: Atlas, 2026-09-25

const fs = require('fs');
const path = require('path');
const { loadEnvLocal } = require('./_lib/load-env-local.js');

const ROOT = path.join(__dirname, '..');
loadEnvLocal(ROOT);

const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260925_outcome_monitor.sql');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const ONLY = argv.includes('--key') ? argv[argv.indexOf('--key') + 1] : null;

/**
 * Pull the seed JSON straight out of the migration's dollar-quoted block.
 * Anchored to the jsonb_to_recordset call rather than to the bare delimiter,
 * so a mention of the delimiter in a comment cannot shadow the real block.
 */
function seedFromMigration() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const m = sql.match(/jsonb_to_recordset\(\$seed\$([\s\S]*?)\$seed\$::jsonb/);
  if (!m) throw new Error('no jsonb_to_recordset seed block found in the migration');
  return JSON.parse(m[1]);
}

// The eight real failures, and which expectation covers each. Used only to
// label the output -- the monitor itself knows nothing about this list, which
// is the point: it was built against the PATTERN, not against these eight.
const FAILURE_COVERAGE = {
  fb_group_posts_daily:
    '#1 DossieBot Chrome logged out of Facebook -> group posting dead since 2026-09-17',
  linkedin_personal_weekly:
    '#1/#2/#3 DossieBot logged out of LinkedIn; the engager reported "liked 0, commented 0" while the real login alert was cooled off',
  video_render_queue_drains:
    '#4 cron-render-videos reported ok in 168ms while matching zero rows (selector drift)',
  video_published_weekly:
    '#7 Creatomate 402 since 2026-06-30 + #8 videos parked at pending_heath_review',
  comment_opportunities_posted_daily:
    '#8 batch_routine_approvals: rows pending with telegram_message_id NULL -- the tap was never requested',
  comment_replies_daily:
    '#1 same DossieBot profile logout, second channel',
  cron_outcome_reporting:
    '#4/#5/#6/#7 the shared root cause: crons that report 200 without saying what they accomplished',
  credential_probe_fresh:
    '#1 no central record of session health existed at all -- a probe that stops running left nothing to go stale',
};

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not loaded — check .env.local');
    process.exit(1);
  }

  const { loadExpectations } = require('../api/_lib/outcome-expectations.js');
  const { evaluate } = require('../api/_lib/outcome-monitor.js');

  let exps = [];
  let source = 'outcome_expectations table';
  try { exps = await loadExpectations({}); } catch { exps = []; }
  if (!exps.length) {
    exps = seedFromMigration().map((e) => ({ ...e, enabled: true }));
    source = 'migration $seed$ block (table not created yet)';
  }
  if (ONLY) exps = exps.filter((e) => e.key === ONLY);

  const results = [];
  for (const exp of exps) {
    // dryRun: measure + classify + report-what-remediation-would-do, write nothing.
    results.push(await evaluate(exp, { dryRun: true }));
  }

  if (AS_JSON) { console.log(JSON.stringify({ source, results }, null, 2)); return; }

  console.log('='.repeat(78));
  console.log('OUTCOME MONITOR — DRY RUN AGAINST LIVE DATA');
  console.log(`expectation source: ${source}`);
  console.log(`checked at: ${new Date().toISOString()}`);
  console.log('='.repeat(78));

  for (const r of results) {
    const verdict = r.status === 'met' ? 'MET'
      : r.status === 'remediated' ? 'WOULD SELF-HEAL'
      : r.status === 'gap' ? 'GAP'
      : 'ERROR';
    console.log(`\n[${verdict}] ${r.key}`);
    console.log(`  ${r.label}`);
    const inverted = r.expected === 0;
    console.log(`  measured: ${r.actual} ${inverted ? '(must be 0 — backlog assertion)' : `/ floor ${r.expected}`}`);
    if (r.error) console.log(`  error: ${r.error}`);
    if (r.cause) {
      console.log(`  cause: ${r.cause.cause} (${r.cause.confidence})`);
      if (r.cause.detail && Object.keys(r.cause.detail).length) {
        console.log(`  detail: ${JSON.stringify(r.cause.detail).slice(0, 300)}`);
      }
    }
    if (r.remediation && r.remediation.runs && r.remediation.runs.length) {
      for (const run of r.remediation.runs) {
        const what = run.attempted
          ? `${run.ok ? 'ok' : 'failed'}${run.changed ? ` (${run.changed} rows)` : ''}`
          : `skipped — ${run.skipped_reason}`;
        console.log(`  remediation ${run.remediation}: ${what}`);
        if (run.detail && Object.keys(run.detail).length) {
          console.log(`      ${JSON.stringify(run.detail).slice(0, 260)}`);
        }
      }
    }
    if (r.escalation_decision) {
      console.log(`  escalation: ${r.escalation_decision.escalate ? 'WOULD FIRE' : 'held'} — ${r.escalation_decision.reason}`);
    }
    if (r.alert) {
      console.log('  --- message Heath would receive ---');
      for (const line of r.alert.split('\n')) console.log(`  | ${line}`);
    }
    if (FAILURE_COVERAGE[r.key] && (r.status === 'gap' || r.status === 'remediated')) {
      console.log(`  >> CATCHES: ${FAILURE_COVERAGE[r.key]}`);
    }
  }

  const caught = results.filter((r) => (r.status === 'gap' || r.status === 'remediated') && FAILURE_COVERAGE[r.key]);
  console.log(`\n${'='.repeat(78)}`);
  console.log(`expectations: ${results.length} | met: ${results.filter((r) => r.status === 'met').length} ` +
              `| gaps: ${results.filter((r) => r.status === 'gap').length} ` +
              `| would self-heal: ${results.filter((r) => r.status === 'remediated').length} ` +
              `| errors: ${results.filter((r) => r.status === 'error').length}`);
  console.log(`known 2026-09 failures caught: ${caught.length}`);
  for (const c of caught) console.log(`  - ${c.key}: ${FAILURE_COVERAGE[c.key]}`);
  console.log(`alerts that would fire: ${results.filter((r) => r.alert).length}`);
  console.log('='.repeat(78));
}

main().catch((e) => { console.error('fatal:', e.stack || e.message); process.exit(1); });
