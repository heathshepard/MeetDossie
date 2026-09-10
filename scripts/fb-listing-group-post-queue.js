'use strict';

// scripts/fb-listing-group-post-queue.js
//
// Part 3 (paced auto-posting) of the listing-marketing pipeline's Tier-2
// FB-group leg. Near-duplicate of scripts/fb-group5-post-queue.js,
// deliberately -- same battle-tested shape (shell out to the existing,
// unmodified scripts/fb-group-poster.js, SAME shared circuit breaker,
// re-read the row after spawning rather than trust the exit code) but
// pointed at pipeline='listing-groups' rows instead of 'daily5', and a
// SEPARATE budget key ('facebook_group_post_listing') so listing-group
// volume can never eat into the TC-discovery daily5 budget or vice versa.
//
// IMPORTANT -- same Facebook profile as daily5 (fb-group-poster.js drives
// the one DossieBot-Sage Chrome profile regardless of which pipeline
// called it). The two budgets are separate bookkeeping, not separate
// accounts -- combined daily volume (daily5 5/day + listing 3/day = up to
// 8/day group posts) still matters for shadowban risk. Watch actual
// results for the first two weeks before considering either cap higher.
//
// Usage:
//   node scripts/fb-listing-group-post-queue.js               # post (at most ONE per run)
//   node scripts/fb-listing-group-post-queue.js --dry-run      # list the approved queue
//   node scripts/fb-listing-group-post-queue.js --clear-halt   # clear the shared circuit breaker
//
// HARD RULES (same doctrine as fb-group5-post-queue.js):
//   - NOTHING posts without status='approved' (Heath's explicit tap/edit via
//     the lst_approve/lst_edit callbacks).
//   - PACING: 'facebook_group_post_listing' budget (3/day) and a VARIED
//     30-40 min gap (wider floor than daily5's 18-24 -- extra safety margin
//     since this pipeline shares the same profile as daily5's own 18-24 min
//     posts; the two together still land under a 45-60 min average spacing
//     across ALL group posts on the profile most days).
//   - SHARED CIRCUIT BREAKER (scripts/_lib/comment-hunt-halt.js) -- same
//     halt file as daily5 AND the comment-opportunity pipeline. One
//     Facebook profile; a checkpoint/login-redirect on ANY of the three
//     must halt all three.
//   - ANY non-success run halts the pipeline, same as daily5 -- never
//     auto-retry an unattended failure.
//
// Scheduling: NOT yet added to a Task Scheduler tick -- Heath approves the
// first cycle manually before this runs on autopilot. Once approved, append
// as a step in the same script that runs fb-group5-post-queue.js, offset so
// the two never fire in the same minute.
//
// Owner: Carter, 2026-09-10

const path = require('path');
const os = require('os');
const fs = require('fs');

try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* non-fatal */ }

const halt = require('./_lib/comment-hunt-halt');

const BUDGET = 'facebook_group_post_listing';

function makeSbFetch() {
  return async function sbFetch(urlPath, init = {}) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers || {}),
    };
    const res = await fetch(`${process.env.SUPABASE_URL}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  };
}

async function notifyHeath(text) {
  const token = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4090), disable_web_page_preview: true }),
  }).catch(() => {});
}

/** Varied spacing: 30-min floor + fresh 0-10 min jitter per run (30-40, never fixed). */
function variedGapMinutes(capsModule) {
  const floor = (capsModule && capsModule.MIN_GAP_MINUTES && capsModule.MIN_GAP_MINUTES[BUDGET]) || 30;
  return floor + Math.random() * 10;
}

function defaultSpawnPoster(postId) {
  const { spawnSync } = require('child_process');
  const scriptPath = path.join(__dirname, 'fb-group-poster.js');
  const result = spawnSync(process.execPath, [scriptPath, '--post-id', postId], {
    stdio: 'inherit',
    env: process.env,
  });
  return { exitCode: result.status, error: result.error ? result.error.message : null };
}

async function runListingGroupPostQueue(deps = {}) {
  const sbFetch = deps.sbFetch || makeSbFetch();
  const caps = deps.caps || require('./_lib/comment-caps.js');
  const spawnPoster = deps.spawnPoster || defaultSpawnPoster;
  const notify = deps.notify || notifyHeath;
  const log = deps.log || console;
  const haltState = deps.haltState || halt;
  const gapMinutes = deps.gapMinutes != null ? deps.gapMinutes : variedGapMinutes(caps);
  const out = { posted: 0, queuedForCap: 0, failed: 0, skipped: 0, halted: false };

  if (haltState.isHalted()) {
    out.halted = true;
    log.log('[listing-group-post-queue] pipeline HALTED (shared with daily5 + comment pipeline) — nothing posts until cleared');
    return out;
  }

  const { ok, data } = await sbFetch(
    '/rest/v1/group_posts'
    + '?pipeline=eq.listing-groups&status=eq.approved'
    + '&select=id,group_name,group_key,post_body,approved_at'
    + '&order=approved_at.asc',
  );
  if (!ok) throw new Error('failed to load approved listing-group posts');
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  if (!(BUDGET in (caps.PLATFORM_DAILY_CAPS || {}))) {
    log.log(`[listing-group-post-queue] budget key '${BUDGET}' not registered in comment-caps.js yet — refusing to post (fail closed)`);
    out.queuedForCap = rows.length;
    return out;
  }

  const capCheck = await caps.canComment(BUDGET, sbFetch);
  if (!capCheck.allowed) {
    out.queuedForCap = rows.length;
    log.log(`[listing-group-post-queue] cap hit (${capCheck.reason}) — ${rows.length} approved post(s) stay queued`);
    await notify(`Listing group-post queue: daily budget hit (${capCheck.reason}). ${rows.length} approved post(s) queued — post automatically starting tomorrow.`);
    return out;
  }

  const { data: lastData } = await sbFetch(
    '/rest/v1/group_posts?pipeline=eq.listing-groups&status=eq.posted&posted_at=not.is.null&order=posted_at.desc&limit=1&select=posted_at',
  );
  if (Array.isArray(lastData) && lastData.length > 0) {
    const ageMin = (Date.now() - new Date(lastData[0].posted_at).getTime()) / 60000;
    if (ageMin < gapMinutes) {
      out.queuedForCap = rows.length;
      log.log(`[listing-group-post-queue] spacing gap not elapsed (${Math.round(ageMin)}m/${Math.round(gapMinutes)}m) — queued for a later run`);
      return out;
    }
  }

  const row = rows[0];

  let spawnResult;
  try {
    spawnResult = await spawnPoster(row.id);
  } catch (err) {
    spawnResult = { exitCode: 1, error: err.message };
  }

  const { data: afterRows } = await sbFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(row.id)}&select=id,status,post_url`,
  );
  const after = Array.isArray(afterRows) && afterRows.length > 0 ? afterRows[0] : null;

  if (after && after.status === 'posted') {
    await caps.recordComment(BUDGET, sbFetch);
    out.posted++;
    log.log(`[listing-group-post-queue] posted listing group post ${row.id} (${row.group_name})`);
    return out;
  }

  haltState.setHalt('listing group-post queue-runner failure (posting or verify did not confirm success)', {
    post_id: row.id, group_name: row.group_name, exit_code: spawnResult.exitCode, spawn_error: spawnResult.error,
  });
  out.failed++;
  out.halted = true;
  await notify(`LISTING GROUP-POST QUEUE HALTED — auto-post attempt for "${row.group_name}" did not confirm success (exit ${spawnResult.exitCode}${spawnResult.error ? `, ${spawnResult.error}` : ''}). Check the DossieBot-Sage profile, then clear the SHARED halt:\nnode scripts/fb-listing-group-post-queue.js --clear-halt\n(this also clears the daily5 + comment pipeline halts — same file)`);
  return out;
}

async function mainCli() {
  const args = process.argv.slice(2);

  if (args.includes('--clear-halt')) {
    const entry = halt.getHalt();
    if (!entry) { console.log('[listing-group-post-queue] no halt set'); return; }
    halt.clearHalt();
    console.log(`[listing-group-post-queue] halt cleared (was: ${entry.reason} @ ${entry.halted_at})`);
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[listing-group-post-queue] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }
  const sbFetch = makeSbFetch();

  if (args.includes('--dry-run')) {
    const { data } = await sbFetch(
      '/rest/v1/group_posts?pipeline=eq.listing-groups&status=eq.approved&select=id,group_name,post_body&order=approved_at.asc',
    );
    const rows = Array.isArray(data) ? data : [];
    console.log(`[listing-group-post-queue][dry-run] ${rows.length} approved listing group post(s) queued:`);
    for (const r of rows) console.log(`  - ${r.group_name}: ${String(r.post_body || '').slice(0, 100)}`);
    console.log(`[listing-group-post-queue][dry-run] halted: ${halt.isHalted()}`);
    return;
  }

  if (halt.isHalted()) {
    const entry = halt.getHalt();
    console.log(`[listing-group-post-queue] HALTED (${entry.reason} @ ${entry.halted_at}) — exiting`);
    return;
  }

  const probe = await sbFetch('/rest/v1/group_posts?pipeline=eq.listing-groups&status=eq.approved&select=id&limit=1');
  if (!probe.ok || !Array.isArray(probe.data) || probe.data.length === 0) {
    console.log('[listing-group-post-queue] nothing approved — exiting without launching Chrome');
    return;
  }

  const result = await runListingGroupPostQueue({ sbFetch });
  console.log('[listing-group-post-queue] done:', JSON.stringify(result));
}

module.exports = {
  runListingGroupPostQueue,
  variedGapMinutes,
  defaultSpawnPoster,
  BUDGET,
};

if (require.main === module) {
  mainCli().catch((err) => {
    console.error('[listing-group-post-queue] fatal:', err.message);
    process.exit(1);
  });
}
