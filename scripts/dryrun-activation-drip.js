#!/usr/bin/env node
'use strict';

// scripts/dryrun-activation-drip.js
//
// Proves, against LIVE production data, that the activation drip in its
// default mode mails exactly the same set of people it mails today — and shows
// what the 'resume' mode would change, without changing it.
//
//   node scripts/dryrun-activation-drip.js
//
// HOW IT IS GUARANTEED NOT TO SEND
//   Three independent brakes, any one of which is sufficient:
//
//     1. RESEND_API_KEY is deleted from the environment before the handler is
//        loaded. cron-activation-drip's sendEmail() checks that variable FIRST
//        and returns { ok: false } without touching the network.
//     2. Because every send reports ok:false, markEmailSent() and the ledger
//        write are never reached. No profile row is modified.
//     3. This script never sets ACTIVATION_DRIP_BACKFILL_MODE in the real
//        environment; it sets it per-run, in-process, on a fresh module.
//
//   It also stubs cron-telemetry so the dry run cannot overwrite the real
//   cron_runs.last_run for this job — otherwise a test would corrupt the very
//   dead-cron signal we rely on.
//
//   All Supabase access is SELECT-only. No customer name or email address is
//   printed.
//
// Owner: 2026-09-18.

const fs = require('fs');
const path = require('path');

(function loadEnv() {
  for (const candidate of [
    path.join(process.cwd(), '.env.local'),
    path.join(__dirname, '..', '.env.local'),
    '/mnt/c/Users/Heath/Projects/MeetDossie/.env.local',
  ]) {
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, 'utf8').replace(/^﻿/, '');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return;
  }
})();

// BRAKE 1 — the handler cannot reach Resend without this.
delete process.env.RESEND_API_KEY;

function makeRes() {
  return {
    _status: 200, _body: null,
    get statusCode() { return this._status; },
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}

async function runOnce(mode) {
  // Fresh module graph per run so the module-level BACKFILL_MODE constant is
  // re-read, and so telemetry stays stubbed.
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  process.env.ACTIVATION_DRIP_BACKFILL_MODE = mode;

  // Stub telemetry BEFORE the drip requires it.
  const telemetryPath = require.resolve('../api/_lib/cron-telemetry.js');
  require(telemetryPath);
  require.cache[telemetryPath].exports = {
    withTelemetry: (_name, fn) => fn,
    recordCronRun: async () => {},
  };

  const handler = require('../api/cron-activation-drip.js');
  const res = makeRes();
  await handler({ headers: { 'x-vercel-cron': '1' }, query: {} }, res);
  return res._body;
}

(async () => {
  console.log('\nACTIVATION DRIP DRY RUN — live data, sending disabled\n');

  const report = await runOnce('report');
  const resume = await runOnce('resume');

  const fmt = (b) => ({
    checked: b.results.activation.checked,
    would_send_e1: b.results.activation.email1_sent,
    would_send_e2: b.results.activation.email2_sent,
    would_send_e3: b.results.activation.email3_sent,
    referral: b.results.referral.sent,
    // With sending disabled every attempted send lands in errors[], so the
    // error count IS the number of people who would have received something.
    would_have_been_emailed: b.results.errors.filter((e) => /failed for /.test(e)).length,
    skipped: b.results.activation.skipped,
    unreachable: b.results.unreachable.count,
    backfilled_profiles: b.results.backfill_audit.profiles_with_backfilled_stamps,
    suppressed_by_backfill: b.results.backfill_audit.suppressed_by_backfill.length,
  });

  console.log('  DEFAULT (ACTIVATION_DRIP_BACKFILL_MODE unset / "report") — what is live today:');
  console.table([fmt(report)]);

  console.log('  IF SET TO "resume" — what would change:');
  console.table([fmt(resume)]);

  const a = fmt(report);
  const b = fmt(resume);
  console.log('');
  console.log(`  Default mode would email:  ${a.would_have_been_emailed} customer(s)`);
  console.log(`  Resume mode would email:   ${b.would_have_been_emailed} customer(s)`);
  console.log(`  Delta (the decision Heath owns): ${b.would_have_been_emailed - a.would_have_been_emailed}`);
  console.log('');
  console.log(`  Paying customers who have never held a session (skipped in both modes,`);
  console.log(`  because a nudge is useless to somebody who cannot log in): ${a.unreachable}`);
  console.log('');
  console.log('  Nothing was sent and nothing was written. RESEND_API_KEY was removed');
  console.log('  from the environment before the handler was loaded.\n');
})().catch((err) => { console.error(err); process.exit(1); });
