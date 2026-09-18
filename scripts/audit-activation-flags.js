#!/usr/bin/env node
'use strict';

// scripts/audit-activation-flags.js
//
// READ-ONLY. Prints which activation_email_*_sent_at stamps are genuine cron
// sends and which are the 2026-06-05 backfill, and tells you exactly what
// would happen if the drip were allowed to resume.
//
//   node scripts/audit-activation-flags.js
//
// Writes nothing. Sends nothing. Names nobody: output is keyed on user_id and
// a masked email, because this file is for reasoning about a MECHANISM and
// there is no reason to print a customer roster to a terminal to do that.
//
// The test it applies is described in full in api/_lib/activation-flag-audit.js.
// One line: JavaScript's toISOString() is millisecond-precision, so a real
// cron write always has three trailing zero microseconds; Postgres now() does
// not. Verified 12/12 against live data on 2026-09-18.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local).
//
// Owner: 2026-09-18.

const fs = require('fs');
const path = require('path');

// Minimal .env.local loader — this repo has no dotenv dependency and local env
// is empty by design (CLAUDE.md section 17).
(function loadEnv() {
  for (const candidate of [
    path.join(process.cwd(), '.env.local'),
    path.join(__dirname, '..', '.env.local'),
    '/mnt/c/Users/Heath/Projects/MeetDossie/.env.local',
  ]) {
    if (!fs.existsSync(candidate)) continue;
    // A UTF-8 BOM silently corrupts the FIRST variable name — a known trap in
    // this repo (memory: env-local-bom-breaks-first-var).
    const raw = fs.readFileSync(candidate, 'utf8').replace(/^﻿/, '');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
    return;
  }
})();

const flagAudit = require('../api/_lib/activation-flag-audit.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function mask(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at < 1) return '(no email)';
  return `${s[0]}***${s.slice(at)}`;
}

async function main() {
  if (!SUPABASE_URL || !KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
    process.exit(1);
  }

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=id,email,created_at,` +
    'activation_email_1_sent_at,activation_email_2_sent_at,activation_email_3_sent_at,referral_ask_sent_at' +
    '&or=(activation_email_1_sent_at.not.is.null,activation_email_2_sent_at.not.is.null,activation_email_3_sent_at.not.is.null)' +
    '&limit=500',
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
  );
  if (!res.ok) {
    console.error('profiles fetch failed:', res.status, (await res.text()).slice(0, 300));
    process.exit(1);
  }
  const profiles = await res.json();

  let clean = 0; let partial = 0; let full = 0;
  const rows = [];

  for (const p of profiles) {
    const a = flagAudit.classifyProfile(p);
    if (a.verdict === 'clean') clean++;
    else if (a.verdict === 'partially_backfilled') partial++;
    else full++;
    rows.push({
      user: `${String(p.id).slice(0, 8)}… ${mask(p.email)}`,
      e1: a.steps.activation_email_1_sent_at,
      e2: a.steps.activation_email_2_sent_at,
      e3: a.steps.activation_email_3_sent_at,
      dup: a.duplicateTimestamps ? 'yes' : '',
      verdict: a.verdict,
    });
  }

  console.log('\nACTIVATION FLAG AUDIT — read-only, nothing modified, nothing sent\n');
  console.table(rows);
  console.log(`\n  clean (all stamps genuine): ${clean}`);
  console.log(`  partially backfilled:       ${partial}`);
  console.log(`  fully backfilled:           ${full}`);
  console.log(`  total profiles with stamps: ${profiles.length}\n`);

  if (partial + full > 0) {
    console.log('  Those stamps are currently SUPPRESSING the activation drip for those');
    console.log('  customers, and that suppression is still in force. Nothing in this');
    console.log('  script changes it.\n');
    console.log('  To see what resuming would send WITHOUT sending it, call the drip');
    console.log('  directly and read results.backfill_audit.suppressed_by_backfill:');
    console.log('    curl -H "Authorization: Bearer $CRON_SECRET" \\');
    console.log('      https://meetdossie.com/api/cron-activation-drip\n');
    console.log('  That call runs in the default inert mode. The ONLY thing that makes');
    console.log('  these customers receive mail is setting the Vercel environment');
    console.log('  variable ACTIVATION_DRIP_BACKFILL_MODE=resume.\n');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
