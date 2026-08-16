#!/usr/bin/env node
/**
 * Clean the demo account so it can be screen-shared.
 *
 * DRY RUN BY DEFAULT. Prints exactly what it would delete and changes nothing.
 * Pass --execute to actually delete. Pass --yes to skip the confirmation pause.
 *
 *   node scripts/carter-clean-demo-account.js              # report only
 *   node scripts/carter-clean-demo-account.js --execute    # delete
 *
 * WHY
 * ---
 * The production demo account (demo@meetdossie.com) currently shows, in the
 * live UI:
 *   - a real client's listing with real buyer and seller names on it
 *   - ~20 QA artefacts: "999 Carter Test Ln", "555 Quinn Round 2 Verify Dr",
 *     "E2E-<timestamp> 100 Test Ln", "1234 Loop Test Lane #1", 13x "123 Main St"
 *   - a dossier with a blank address
 * It cannot be shown to a prospect as-is.
 *
 * WHAT IT TOUCHES
 * ---------------
 * Only rows belonging to profiles where is_demo = true. Every candidate is
 * matched against an explicit allow/deny list below — nothing is deleted on a
 * loose heuristic. Child rows (documents, action_items, dossier_milestones,
 * deadline_reminders, email_queue) are removed for the same transaction ids so
 * the cleanup doesn't strand orphans.
 *
 * REAL-CLIENT ROWS ARE REPORTED, NOT DELETED. Those dossiers may be the only
 * copy of that file. They are listed under "REASSIGN" — they need to be moved
 * to Heath's own account, not destroyed. Decide per row.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (read from .env.local)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXECUTE = process.argv.includes('--execute');
const SKIP_PAUSE = process.argv.includes('--yes');

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// QA/test artefacts — safe to delete outright.
const JUNK_PATTERNS = [
  /^E2E-\d+/i,
  /\bCarter Test\b/i,
  /\bQuinn (Round \d+ )?Verify\b/i,
  /\bQuinn Buyer APV\b/i,
  /\bAPV Buyer Test\b/i,
  /\bLoop Test Lane\b/i,
  /\bZelda Demo Way\b/i,
  /\bMock Trail\b/i,
  /\bSample Park\b/i,
  /^ATLAS-E2E/i,
  /^HADLEY-AMENDMENT/i,
  /^123 Main St(reet)?\.?$/i,
  /^1234 Main St\.?$/i,
  /^456 Builder Blvd$/i,
];

// Real client / real listing addresses must never be auto-deleted. They are NOT
// hardcoded here: this is a public repo and a client's property address is their
// information, not ours to publish. Instead the classifier is deny-by-default —
// anything that is not a recognised QA artefact and not on the keep list falls
// through to REVIEW, which this script never touches.
//
// To tag specific addresses as "reassign to Heath" for a run, drop a local
// (gitignored) JSON file next to this script:
//   scripts/.demo-cleanup-protected.json  ->  ["123 Example St", "456 Other Ave"]
function loadProtectedPatterns() {
  const p = path.join(__dirname, '.demo-cleanup-protected.json');
  if (!fs.existsSync(p)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (Array.isArray(list) ? list : [])
      .filter((s) => typeof s === 'string' && s.trim())
      .map((s) => new RegExp(s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  } catch (err) {
    console.warn(`Could not read ${p}: ${err.message}`);
    return [];
  }
}
const REAL_CLIENT_PATTERNS = loadProtectedPatterns();

// Presentable demo content — explicitly kept.
const KEEP_PATTERNS = [
  /205 Kendall Falls/i,
  /4521 Meadow Creek/i,
  /742 Lakeview/i,
  /987 Magnolia Creek/i,
  /789 Ranch Rd/i,
  /311 Rilla Vista/i,
  /1847 Vintage Way/i,
  /142 River Bend/i,
  /8734 Stone Oak/i,
  /6821 Presidio/i,
  /23418 Cibolo Vista/i,
  /2814 Huebner/i,
  /4501 Broadway/i,
  /2801 Broadway/i,
  /321 Oak St/i,
  /8412 Mock Trail/i,
];

const CHILD_TABLES = [
  'documents',
  'action_items',
  'dossier_milestones',
  'deadline_reminders',
  'email_queue',
  'amendments',
  'transaction_offers',
];

// ---------------------------------------------------------------------------

function loadEnv() {
  const p = path.join(__dirname, '..', '.env.local');
  const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}

const env = loadEnv();
const BASE = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

async function rest(pathAndQuery, init = {}) {
  const res = await fetch(`${BASE}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${pathAndQuery} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function classify(address) {
  const a = String(address || '').trim();
  if (!a) return 'junk';                                              // blank address
  if (REAL_CLIENT_PATTERNS.some((re) => re.test(a))) return 'reassign';
  if (KEEP_PATTERNS.some((re) => re.test(a))) return 'keep';
  if (JUNK_PATTERNS.some((re) => re.test(a))) return 'junk';
  return 'review';                                                    // unknown -> human decides
}

(async () => {
  const demos = await rest('profiles?select=id,email&is_demo=eq.true');
  if (!demos.length) {
    console.log('No profiles with is_demo = true. Nothing to do.');
    return;
  }

  const buckets = { junk: [], reassign: [], keep: [], review: [] };

  for (const prof of demos) {
    const txs = await rest(
      `transactions?select=id,property_address,status,created_at&user_id=eq.${prof.id}&order=created_at.desc`,
    );
    for (const tx of txs) {
      buckets[classify(tx.property_address)].push({ ...tx, owner: prof.email });
    }
  }

  const line = (t) => `  ${(t.status || '-').padEnd(8)} ${String(t.property_address || '(blank address)').slice(0, 52).padEnd(54)} ${t.id.slice(0, 8)}  ${t.owner}`;

  console.log(`\nDemo accounts: ${demos.map((d) => d.email).join(', ')}`);
  console.log(`\n--- DELETE (${buckets.junk.length}) — QA artefacts and blank rows ---`);
  buckets.junk.forEach((t) => console.log(line(t)));

  console.log(`\n--- REASSIGN (${buckets.reassign.length}) — REAL CLIENT DATA, not deleted ---`);
  console.log('    These carry real names. Move them to Heath\'s account; do not destroy.');
  buckets.reassign.forEach((t) => console.log(line(t)));

  console.log(`\n--- REVIEW (${buckets.review.length}) — unrecognised, left alone ---`);
  buckets.review.forEach((t) => console.log(line(t)));

  console.log(`\n--- KEEP (${buckets.keep.length}) — presentable demo content ---`);
  buckets.keep.forEach((t) => console.log(line(t)));

  if (!EXECUTE) {
    console.log(`\nDRY RUN. Nothing was changed.`);
    console.log(`Would delete ${buckets.junk.length} dossiers and their child rows.`);
    console.log(`Re-run with --execute to apply.\n`);
    return;
  }

  if (!SKIP_PAUSE) {
    console.log(`\n*** --execute given: deleting ${buckets.junk.length} dossiers in 5 seconds. Ctrl-C to abort. ***`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  let deleted = 0;
  for (const tx of buckets.junk) {
    for (const table of CHILD_TABLES) {
      try {
        await rest(`${table}?transaction_id=eq.${tx.id}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
        });
      } catch (err) {
        // A table without a transaction_id column just 400s; not fatal.
        if (!/column .* does not exist|42703/i.test(err.message)) {
          console.warn(`  child cleanup ${table} for ${tx.id.slice(0, 8)}: ${err.message}`);
        }
      }
    }
    await rest(`transactions?id=eq.${tx.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    deleted++;
    console.log(`  deleted ${tx.id.slice(0, 8)}  ${tx.property_address || '(blank)'}`);
  }

  console.log(`\nDone. Deleted ${deleted} dossiers.`);
  console.log(`Still to handle by hand: ${buckets.reassign.length} real-client dossiers (REASSIGN above).\n`);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
