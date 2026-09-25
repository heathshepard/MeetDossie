#!/usr/bin/env node
'use strict';

// scripts/sync-video-comment-automations.js
// =============================================================================
// CLI for the comment-to-DM keyword lifecycle. Read-only by default.
//
//   node scripts/sync-video-comment-automations.js
//       Dry run. Prints exactly what WOULD happen and changes nothing, at
//       Zernio or in the database. This is the default and it is the mode
//       you want almost every time.
//
//   node scripts/sync-video-comment-automations.js --apply
//       Executes the plan. Still bounded by the ops flags:
//         zernio_comment_automations      off -> nothing is created
//         zernio_comment_automations_live off -> created automations stay PAUSED
//       So --apply alone can never DM a real person.
//
//   node scripts/sync-video-comment-automations.js --video <video_library_id>
//       Scope to one video.
//
//   node scripts/sync-video-comment-automations.js --declare <video_id> \
//        --keyword TREC --asset <public-url> [--message "..."]
//       Declare the keyword ON the video record. This is the ONLY thing a
//       human does. Refuses a keyword already claimed by another video rather
//       than overwriting, because a recycled keyword makes every lead it ever
//       produced unattributable.
//
//   node scripts/sync-video-comment-automations.js --list
//       Current ledger + leads captured per keyword.
//
// Run from the repo root. Reads .env.local.
// Owner: Atlas, 2026-09-25.
// =============================================================================

const fs = require('fs');
const path = require('path');

// .env.local is gitignored and absent in worktrees; fall back to the main
// checkout so this works from either place without copying secrets around.
(function loadEnv() {
  const candidates = [
    path.join(process.cwd(), '.env.local'),
    '/mnt/c/Users/Heath/Projects/MeetDossie/.env.local',
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); // BOM breaks the first var
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  }
})();

const { syncVideoAutomations, assetReachable } = require('../api/_lib/video-comment-automations.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(p, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const t = await res.text();
  let d = null;
  if (t) { try { d = JSON.parse(t); } catch { d = null; } }
  return { ok: res.ok, status: res.status, data: d, raw: t.slice(0, 400) };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(name);

async function declareKeyword() {
  const videoId = arg('--declare');
  const keyword = arg('--keyword');
  const asset = arg('--asset');
  const message = arg('--message');

  if (!videoId || !keyword) {
    console.error('--declare <video_library_id> --keyword <KEYWORD> [--asset <url>] [--message "..."]');
    process.exit(1);
  }

  const v = await sb(`video_library?id=eq.${encodeURIComponent(videoId)}&select=id,status,topic,dm_keyword`);
  if (!v.ok || !Array.isArray(v.data) || v.data.length === 0) {
    console.error(`No video_library row with id ${videoId}`);
    process.exit(1);
  }

  // Collision check BEFORE the write. The DB unique index would catch it too,
  // but a clear refusal beats a constraint-violation stack trace.
  const clash = await sb(
    `video_library?dm_keyword=ilike.${encodeURIComponent(keyword)}&id=neq.${encodeURIComponent(videoId)}&select=id,dm_keyword`,
  );
  if (clash.ok && Array.isArray(clash.data) && clash.data.length > 0) {
    console.error(`REFUSED: keyword "${keyword}" is already claimed by ${clash.data.map((r) => r.id).join(', ')}.`);
    console.error('Keywords are permanent attribution tokens. Recycling one makes every lead it produced ambiguous.');
    console.error('Pick a different keyword for this video.');
    process.exit(1);
  }

  if (asset) {
    const reach = await assetReachable(asset);
    console.log(`asset check: ${asset} -> ${reach.ok ? `OK (${reach.status})` : `NOT REACHABLE (${reach.reason})`}`);
    if (!reach.ok) console.log('  The keyword can be declared now, but it will NOT arm until this URL resolves.');
  }

  const patch = {
    dm_keyword: keyword,
    ...(asset ? { dm_asset_url: asset } : {}),
    ...(message ? { dm_message: message } : {}),
  };
  const r = await sb(`video_library?id=eq.${encodeURIComponent(videoId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) { console.error('PATCH failed:', r.status, r.raw); process.exit(1); }
  console.log(`Declared "${keyword}" on ${videoId}.`);
  console.log('Next sync run picks it up. Nothing arms until both ops flags are on.');
}

async function listState() {
  const led = await sb('video_comment_automations?select=*&order=created_at.desc');
  const rows = Array.isArray(led.data) ? led.data : [];
  console.log(`\nLEDGER (${rows.length})`);
  for (const r of rows) {
    console.log(`  ${r.keyword.padEnd(14)} ${r.status.padEnd(8)} ${r.platform.padEnd(10)} ${r.video_library_id}`);
    if (r.last_error) console.log(`      error: ${r.last_error}`);
  }

  const dec = await sb('video_library?dm_keyword=not.is.null&select=id,status,dm_keyword,dm_asset_url,retracted_at');
  const decl = Array.isArray(dec.data) ? dec.data : [];
  console.log(`\nDECLARED ON VIDEOS (${decl.length})`);
  for (const d of decl) {
    console.log(`  ${String(d.dm_keyword).padEnd(14)} ${String(d.status).padEnd(10)}${d.retracted_at ? ' RETRACTED' : ''} ${d.id}`);
    console.log(`      asset: ${d.dm_asset_url || '(none - cannot arm)'}`);
  }

  const leads = await sb('comment_dm_leads?select=keyword,dm_status,triggered_at&order=triggered_at.desc&limit=500');
  const l = Array.isArray(leads.data) ? leads.data : [];
  const byKeyword = {};
  for (const row of l) byKeyword[row.keyword || '(none)'] = (byKeyword[row.keyword || '(none)'] || 0) + 1;
  console.log(`\nLEADS CAPTURED (${l.length})`);
  for (const [k, n] of Object.entries(byKeyword)) console.log(`  ${k.padEnd(14)} ${n}`);
  if (l.length === 0) console.log('  (none yet)');

  const flags = await sb('ops_flags?key=like.zernio_comment%25&select=key,enabled');
  console.log('\nFLAGS');
  for (const f of (Array.isArray(flags.data) ? flags.data : [])) {
    console.log(`  ${f.key.padEnd(34)} ${f.enabled ? 'ON' : 'off'}`);
  }
  console.log('');
}

(async () => {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing. Run from the repo root so .env.local loads.');
    process.exit(1);
  }
  if (!process.env.ZERNIO_API_KEY && !has('--list') && !has('--declare')) {
    console.error('ZERNIO_API_KEY missing.');
    process.exit(1);
  }

  if (has('--declare')) return declareKeyword();
  if (has('--list')) return listState();

  const apply = has('--apply');
  const result = await syncVideoAutomations({
    supabaseUrl: SUPABASE_URL,
    serviceKey: SERVICE_KEY,
    dryRun: !apply,
    onlyVideoId: arg('--video'),
  });

  if (result.error) { console.error(result.error); process.exit(1); }

  console.log(`\nMODE: ${result.dry_run ? 'DRY RUN - nothing changed' : 'APPLIED'}`);
  console.log('FLAGS:', JSON.stringify(result.flags));
  if (apply && result.dry_run) {
    console.log('  (--apply was passed but ops_flags.zernio_comment_automations is OFF, so this stayed report-only)');
  }
  console.log('COUNTS:', JSON.stringify(result.counts, null, 1));

  if (result.collisions.length) {
    console.log('\nCOLLISIONS - REFUSED, these keywords will not arm:');
    for (const c of result.collisions) console.log(`  "${c.keyword}" -> ${(c.videos || []).join(', ')} :: ${c.action}`);
  }

  console.log('\nPLAN:');
  if (result.plan.length === 0) console.log('  (nothing to do)');
  for (const p of result.plan) {
    console.log(`  ${String(p.action).toUpperCase().padEnd(7)} ${String(p.keyword || '').padEnd(14)} ${p.video}  ${p.reason}`);
  }

  if (result.orphans.length) {
    console.log('\nORPHANS at Zernio (ours by name, not in the ledger):');
    for (const o of result.orphans) console.log(`  ${o.automationId} ${o.name} active=${o.isActive}`);
  }
  if (result.errors.length) {
    console.log('\nERRORS:');
    for (const e of result.errors) console.log(' ', JSON.stringify(e));
  }
  console.log(`\nzernio requests used: ${result.requests_used}\n`);
})();
