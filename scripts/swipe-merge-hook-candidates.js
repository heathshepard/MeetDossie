'use strict';

// scripts/swipe-merge-hook-candidates.js
//
// The ONLY thing in this pipeline allowed to write to the hook bank in
// docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md — and it only ever moves rows a
// human already set to status='accepted'.
//
// It appends inside the <!-- SWIPE-CANDIDATES:BEGIN/END --> block in §2 and
// never rewrites anything already there, so hand edits inside the block
// survive. Merged rows are marked status='merged' so a second run does not
// duplicate them.
//
// USAGE
//   node scripts/swipe-merge-hook-candidates.js            # merge accepted
//   node scripts/swipe-merge-hook-candidates.js --list     # show pending/accepted
//   node scripts/swipe-merge-hook-candidates.js --accept <uuid> [--accept <uuid>]
//   node scripts/swipe-merge-hook-candidates.js --reject <uuid> --reason "..."
//   node scripts/swipe-merge-hook-candidates.js --dry-run
//
// The accept/reject flags exist so Heath can do the whole review from the
// terminal after reading Monday's brief, without opening the Supabase UI.

const fs = require('fs');
const path = require('path');
const { loadEnvLocal } = require('./_lib/load-env-local');
loadEnvLocal(path.join(__dirname, '..'));

const { sb } = require('./_lib/swipe-store');

const PLAYBOOK = path.join(__dirname, '..', 'docs', 'SCROLL-STOPPING-VIDEO-PLAYBOOK.md');
const BEGIN = '<!-- SWIPE-CANDIDATES:BEGIN -->';
const END = '<!-- SWIPE-CANDIDATES:END -->';
const EMPTY_MARKER = '_None accepted yet._';

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { list: false, accept: [], reject: [], reason: null, dryRun: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--list') { out.list = true; continue; }
    if (a[i] === '--dry-run') { out.dryRun = true; continue; }
    if (a[i] === '--accept' && a[i + 1]) { out.accept.push(a[++i]); continue; }
    if (a[i] === '--reject' && a[i + 1]) { out.reject.push(a[++i]); continue; }
    if (a[i] === '--reason' && a[i + 1]) { out.reason = a[++i]; continue; }
  }
  return out;
}

function renderEntry(c, n) {
  const brand = c.target_brand || c.market || 'dossie';
  const src = c.swipe_patterns || {};
  const ad = src.swipe_ads || {};
  const lines = [
    `${n}. **"${c.candidate_hook.replace(/"/g, "'")}"** — ${brand}.`,
    `   ${c.rationale}`,
  ];
  if (src.evidence_basis) {
    lines.push(`   _Pattern evidence: ${src.evidence_basis}_`);
  }
  if (ad.link) {
    lines.push(`   _Observed at: ${ad.link}${ad.advertiser ? ` (${ad.advertiser})` : ''} — structure only, never their copy._`);
  }
  lines.push(`   <!-- candidate:${c.id} accepted:${(c.reviewed_at || '').slice(0, 10)} -->`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs();

  // ── --accept / --reject: review from the terminal ──────────────────────
  for (const id of args.accept) {
    const r = await sb(`swipe_hook_candidates?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'accepted', reviewed_at: new Date().toISOString(), reviewed_by: 'heath' }),
    });
    console.log(`${r.ok ? 'accepted' : 'FAILED to accept'} ${id}`);
  }
  for (const id of args.reject) {
    const r = await sb(`swipe_hook_candidates?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'rejected',
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'heath',
        reject_reason: args.reason || null,
      }),
    });
    console.log(`${r.ok ? 'rejected' : 'FAILED to reject'} ${id}`);
  }

  // ── --list ─────────────────────────────────────────────────────────────
  if (args.list) {
    const got = await sb(
      'swipe_hook_candidates?status=in.(pending,accepted)&select=id,status,target_brand,market,candidate_hook,evidence_score&order=status.asc,evidence_score.desc.nullslast',
    );
    for (const c of got.data || []) {
      console.log(`[${c.status}] ${c.id}  (${c.target_brand || c.market}, evidence ${c.evidence_score ?? '?'})`);
      console.log(`         "${c.candidate_hook}"`);
    }
    if (!(got.data || []).length) console.log('nothing pending or accepted.');
    return;
  }

  // ── merge accepted -> playbook ─────────────────────────────────────────
  const got = await sb(
    'swipe_hook_candidates?status=eq.accepted&order=created_at.asc'
    + '&select=id,candidate_hook,rationale,target_brand,market,reviewed_at,'
    + 'swipe_patterns(evidence_basis,swipe_ads(link,advertiser))',
  );
  if (!got.ok) { console.error('[swipe-merge] query failed:', got.data); process.exit(1); }
  const accepted = got.data || [];
  if (!accepted.length) {
    console.log('[swipe-merge] nothing accepted. Run with --list to see pending candidates.');
    return;
  }

  const doc = fs.readFileSync(PLAYBOOK, 'utf8');
  const bi = doc.indexOf(BEGIN);
  const ei = doc.indexOf(END);
  if (bi < 0 || ei < 0) {
    console.error('[swipe-merge] the SWIPE-CANDIDATES block is missing from docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md.');
    console.error('  Refusing to guess where it goes — restore the block rather than letting this append blindly.');
    process.exit(1);
  }

  const inner = doc.slice(bi + BEGIN.length, ei);
  // Highest existing number inside the block, so appended entries keep counting.
  const nums = [...inner.matchAll(/^(\d+)\.\s+\*\*/gm)].map((m) => Number(m[1]));
  let n = nums.length ? Math.max(...nums) : 0;

  const fresh = accepted.filter((c) => !inner.includes(`candidate:${c.id}`));
  if (!fresh.length) {
    console.log('[swipe-merge] every accepted candidate is already in the playbook. Marking them merged.');
  }

  const rendered = fresh.map((c) => renderEntry(c, ++n)).join('\n\n');
  let newInner = inner.replace(EMPTY_MARKER, '').trimEnd();
  newInner = `${newInner}\n\n${rendered}\n`;

  const out = doc.slice(0, bi + BEGIN.length) + newInner + doc.slice(ei);

  if (args.dryRun) {
    console.log('--- would append ---');
    console.log(rendered || '(nothing new)');
    return;
  }

  if (fresh.length) {
    fs.writeFileSync(PLAYBOOK, out, 'utf8');
    console.log(`[swipe-merge] appended ${fresh.length} hook(s) to docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §2.`);
  }

  for (const c of accepted) {
    await sb(`swipe_hook_candidates?id=eq.${c.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'merged', merged_at: new Date().toISOString() }),
    });
  }
  console.log(`[swipe-merge] marked ${accepted.length} candidate(s) merged. Commit the playbook change.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[swipe-merge] fatal:', err && err.message);
    process.exit(1);
  });
}
