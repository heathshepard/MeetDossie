#!/usr/bin/env node
'use strict';

// scripts/backfill-contacts-from-documents.js
//
// Fill in the people on deals whose contracts were filed BEFORE Dossie started
// saving contacts (2026-09-20).
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SCRIPT AND NOT A CRON
// ---------------------------------------------------------------------------
// This writes client PII onto live deals from a machine reading of a PDF. It
// costs a real Anthropic call per contract and it is not idempotent in the
// sense that matters -- a bad extraction written across ten deals at 3am is
// ten deals a member now has to audit and cannot easily tell apart from data
// they entered themselves.
//
// So it is deliberately: DRY RUN BY DEFAULT, one member at a time, printing
// every single field it would write and where that value came from, and
// refusing to touch a field a human already filled. You read the dry run, then
// you decide.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   # See what it WOULD do for one member (writes nothing):
//   node scripts/backfill-contacts-from-documents.js --user <uuid>
//
//   # One deal only:
//   node scripts/backfill-contacts-from-documents.js --user <uuid> --deal <uuid>
//
//   # Actually write, after reading the dry run:
//   node scripts/backfill-contacts-from-documents.js --user <uuid> --apply
//
// --user is REQUIRED and there is no --all. `transactions` is multi-tenant
// (memory:transactions-table-is-multi-tenant), and a backfill is exactly the
// shape of job that publishes one customer's client data onto another's deal
// if the tenant filter is ever implicit. Making the operator name the tenant
// every single time is the cheapest possible guarantee that it is never
// forgotten.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ANTHROPIC_API_KEY; the
// script reads .env.local when they are not already in the environment.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// --- env -------------------------------------------------------------------
// Searches upward for .env.local rather than assuming the repo root: run from a
// git worktree (.claude/worktrees/agent-*), the repo root IS the worktree and
// it has no .env.local — the file lives in the main checkout several levels up.
// Assuming otherwise makes the script report "no credentials" when the
// credentials are fine, which is the same shape of misleading failure this
// whole change exists to remove.
function findEnvFile(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.env.local');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

(function loadEnv() {
  const p = process.env.DOSSIE_ENV_FILE || findEnvFile(REPO);
  if (!p || !fs.existsSync(p)) return;
  // memory:env-local-bom-breaks-first-var — a BOM makes the first variable
  // look like a rotated key rather than a parse failure.
  const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    if (process.env[m[1]]) continue;
    process.env[m[1]] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
})();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

// --- args ------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};
const USER_ID = flag('--user');
const DEAL_ID = flag('--deal');
const APPLY = args.includes('--apply');
const LIMIT = Number(flag('--limit') || 25);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!USER_ID || !UUID_RE.test(USER_ID)) {
  console.error('ERROR: --user <uuid> is required (and must be a uuid).\n');
  console.error('  Dry run : node scripts/backfill-contacts-from-documents.js --user <uuid>');
  console.error('  Apply   : node scripts/backfill-contacts-from-documents.js --user <uuid> --apply');
  process.exit(2);
}
if (DEAL_ID && !UUID_RE.test(DEAL_ID)) {
  console.error('ERROR: --deal must be a uuid.');
  process.exit(2);
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not available.');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY not available — the backfill has to actually read the PDFs.');
  process.exit(2);
}

// --- supabase --------------------------------------------------------------
async function sb(p, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function downloadDocument(storagePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

const { persistContactsFromScan } = require(path.join(REPO, 'api/_lib/contact-persistence-store'));
const scanner = require(path.join(REPO, 'api/scan-contract.js'));

// Document types worth spending a scan on. The residential contract carries
// the broker block, both parties and the title company; nothing else on a
// normal deal carries all three.
const CONTRACT_TYPES = new Set(['trec-20-17', 'executed-contract']);

function fmt(v) {
  return v == null ? '(none)' : String(v);
}

(async () => {
  console.log('');
  console.log(APPLY ? '=== BACKFILL — APPLYING ===' : '=== BACKFILL — DRY RUN (writes nothing) ===');
  console.log(`member ${USER_ID}${DEAL_ID ? `  deal ${DEAL_ID}` : ''}`);
  console.log('');

  const profileRes = await sb(`profiles?id=eq.${USER_ID}&select=email,full_name&limit=1`);
  const profile = (profileRes.data && profileRes.data[0]) || null;

  // Owner-scoped, always.
  const txRes = await sb(
    `transactions?select=id,property_address,status,role,transaction_type`
    + `&user_id=eq.${USER_ID}`
    + (DEAL_ID ? `&id=eq.${DEAL_ID}` : '&status=neq.closed')
    + `&order=updated_at.desc&limit=${LIMIT}`,
  );
  if (!txRes.ok) {
    console.error('Could not load deals:', txRes.status);
    process.exit(1);
  }
  const deals = txRes.data || [];
  if (!deals.length) {
    console.log('No deals matched.');
    return;
  }

  const totals = { scanned: 0, filled: 0, conflicts: 0, blocked: 0, skipped: 0 };

  for (const deal of deals) {
    // Owner-scoped again — a document row is only this deal's if it is also
    // this member's.
    const docRes = await sb(
      `documents?select=id,file_name,storage_path,document_type,created_at`
      + `&user_id=eq.${USER_ID}&transaction_id=eq.${deal.id}`
      + `&order=created_at.desc`,
    );
    const docs = (docRes.data || []).filter((d) => d.storage_path);
    const contract = docs.find((d) => CONTRACT_TYPES.has(d.document_type))
      || docs.find((d) => /contract/i.test(d.file_name || ''));

    if (!contract) {
      totals.skipped++;
      console.log(`- ${deal.property_address || deal.id}: no contract document filed — skipped`);
      continue;
    }

    const bytes = await downloadDocument(contract.storage_path);
    if (!bytes) {
      totals.skipped++;
      console.log(`- ${deal.property_address || deal.id}: could not download ${contract.file_name} — skipped`);
      continue;
    }

    let extracted = null;
    try {
      const scan = await scanner.scanContract(bytes.toString('base64'));
      extracted = (scan && scan.extracted) || null;
    } catch (err) {
      totals.skipped++;
      console.log(`- ${deal.property_address || deal.id}: scan failed (${err.message}) — skipped`);
      continue;
    }
    if (!extracted) {
      totals.skipped++;
      console.log(`- ${deal.property_address || deal.id}: ${contract.file_name} is not a residential contract — skipped`);
      continue;
    }
    totals.scanned++;

    const result = await persistContactsFromScan(sb, {
      userId: USER_ID,
      transactionId: deal.id,
      extracted,
      source: {
        documentId: contract.id,
        fileName: contract.file_name,
        documentLabel: contract.document_type || 'contract',
        scanId: `backfill-${new Date().toISOString().slice(0, 10)}`,
      },
      profile,
      dryRun: !APPLY,
    });

    console.log('');
    console.log(`${deal.property_address || deal.id}`);
    console.log(`  from: ${contract.file_name}`);
    if (!result.plan) {
      console.log(`  (${result.reason})`);
      continue;
    }
    const p = result.plan;
    console.log(`  member side: ${fmt(p.side)}`);

    if (p.filled.length) {
      console.log(`  WOULD FILL (${p.filled.length}):`);
      for (const f of p.filled) {
        const prov = p.provenance[f.column];
        console.log(`    ${f.column.padEnd(26)} = ${f.value}`);
        console.log(`    ${''.padEnd(26)}   <- ${prov.source_block} / ${prov.source_field}`);
      }
      totals.filled += p.filled.length;
    } else {
      console.log('  WOULD FILL: nothing (already populated, or nothing readable)');
    }

    for (const c of p.conflicts) {
      console.log(`  CONFLICT  ${c.column || c.kind}: ${c.detail}`);
      totals.conflicts++;
    }
    for (const b of p.blocked) {
      console.log(`  NOT SENDABLE  ${b.party}.${b.kind} = ${b.value}  (${b.reason})`);
      totals.blocked++;
    }
    for (const r of p.rejected) {
      console.log(`  DROPPED   ${r.party}.${r.kind}: "${r.raw}" — ${r.reason}`);
    }
    if (APPLY) console.log(`  -> ${result.written ? 'WRITTEN' : `not written (${result.reason})`}`);
  }

  console.log('');
  console.log('---');
  console.log(`contracts scanned ${totals.scanned}  fields ${APPLY ? 'written' : 'to fill'} ${totals.filled}  conflicts ${totals.conflicts}  kept-unsendable ${totals.blocked}  deals skipped ${totals.skipped}`);
  if (!APPLY) {
    console.log('');
    console.log('DRY RUN — nothing was written. Re-run with --apply once the above reads correctly.');
  }
  console.log('');
})().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
