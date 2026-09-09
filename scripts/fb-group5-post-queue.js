'use strict';

// scripts/fb-group5-post-queue.js
//
// Part 3 (paced auto-posting) of the daily 5-group-post pipeline. Drains
// group_posts rows with pipeline='daily5' AND status='approved' (Heath
// explicitly approved each one in Telegram via the gp5_* callbacks in
// api/telegram-webhook.js / api/group5-post-callback.js) and posts each ONE
// AT A TIME by shelling out to the existing, battle-tested
// scripts/fb-group-poster.js --post-id <id> (reused untouched — this file
// does not reimplement any Facebook DOM automation).
//
// Usage:
//   node scripts/fb-group5-post-queue.js               # post (at most ONE per run)
//   node scripts/fb-group5-post-queue.js --dry-run      # list the approved queue
//   node scripts/fb-group5-post-queue.js --clear-halt   # clear the shared circuit breaker
//
// HARD RULES (same doctrine as fb-comment-opp-poster.js):
//   - NOTHING posts without status='approved' (Heath's explicit tap/edit).
//   - PACING over volume: 'facebook_group_post' budget (5/day — exactly one
//     per target group — scripts/_lib/comment-caps.js) and a VARIED 18-24
//     min gap (18-min floor + fresh jitter each run, per Heath 2026-09-09:
//     "do the posts like 20 minutes apart"). In practice the Task Scheduler
//     tick this runs on (30 min, appended to the existing "Dossie TC
//     Discovery Harvest" .cmd) is the real pacing floor — the gap check
//     here just guarantees the tick can never post faster than 18-24 min
//     even if the tick interval is ever shortened.
//   - SHARED CIRCUIT BREAKER (scripts/_lib/comment-hunt-halt.js): the SAME
//     halt file as the comment-opportunity pipeline. It's one Facebook
//     profile — a checkpoint/login-redirect while posting a GROUP POST
//     must halt commenting too, and vice versa.
//   - Every post reuses scripts/fb-group-poster.js's own verification
//     (it re-checks the composer closed / no error banner) and its existing
//     comment_watchlist handoff (scripts/_lib/group-post-watchlist.js,
//     fires automatically on a confirmed post — no separate wiring here).
//   - ANY non-success run (fb-group-poster.js exits non-zero, or the row is
//     NOT 'posted' afterward) halts the pipeline. fb-group-poster.js resets
//     a failed row back to 'approved' for ANY error (checkpoint or a broken
//     selector) — that reset-and-silently-retry-forever behavior is safe
//     for a human running the command by hand and using judgment before
//     re-running it, but NOT safe once a scheduler is the one re-running
//     it. Treating every failure as halt-worthy (never auto-retry) is the
//     conservative default: Heath clears the halt after actually looking.
//
// Scheduling: appended as a new step in scripts/run-tc-discovery-harvest.cmd
// (Windows Task Scheduler task "Dossie TC Discovery Harvest", 30-min tick).
// No-op runs exit in ~2s without launching Chrome.
//
// Owner: Carter, 2026-09-09

const path = require('path');
const os = require('os');
const fs = require('fs');

// Load .env.local when running locally
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

// Shared with fb-comment-opp-poster.js -- same profile, same breaker.
const halt = require('./_lib/comment-hunt-halt');

const BUDGET = 'facebook_group_post';

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

/** Varied spacing: 18-min floor + fresh 0-6 min jitter per run (18-24, never fixed). */
function variedGapMinutes(capsModule) {
  const floor = (capsModule && capsModule.MIN_GAP_MINUTES && capsModule.MIN_GAP_MINUTES[BUDGET]) || 18;
  return floor + Math.random() * 6;
}

/**
 * Shell out to the existing, unmodified fb-group-poster.js. Returns the
 * child process exit code (0 = clean exit — the row's DB status is the
 * real source of truth for success, checked by the caller).
 */
function defaultSpawnPoster(postId) {
  const { spawnSync } = require('child_process');
  const scriptPath = path.join(__dirname, 'fb-group-poster.js');
  const result = spawnSync(process.execPath, [scriptPath, '--post-id', postId], {
    stdio: 'inherit',
    env: process.env,
  });
  return { exitCode: result.status, error: result.error ? result.error.message : null };
}

/**
 * @param {object} deps {
 *   sbFetch, caps, spawnPoster(postId) => {exitCode, error}, notify, log,
 *   gapMinutes  — required spacing for THIS run (prod: variedGapMinutes()),
 *   haltState   — { isHalted, setHalt } (prod: scripts/_lib/comment-hunt-halt, SHARED with comments)
 * }
 * @returns {Promise<{posted:number, queuedForCap:number, failed:number, skipped:number, halted:boolean}>}
 */
async function runGroup5PostQueue(deps = {}) {
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
    log.log('[group5-post-queue] pipeline HALTED (shared with comment pipeline) — nothing posts until cleared');
    return out;
  }

  // ONLY Heath-approved daily5 rows. Nothing else is ever eligible.
  const { ok, data } = await sbFetch(
    '/rest/v1/group_posts'
    + '?pipeline=eq.daily5&status=eq.approved'
    + '&select=id,group_name,group_key,post_body,approved_at'
    + '&order=approved_at.asc',
  );
  if (!ok) throw new Error('failed to load approved daily5 group posts');
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  // Daily cap on the dedicated group-post budget (5/day = 1 per group).
  const capCheck = await caps.canComment(BUDGET, sbFetch);
  if (!capCheck.allowed) {
    out.queuedForCap = rows.length;
    log.log(`[group5-post-queue] cap hit (${capCheck.reason}) — ${rows.length} approved post(s) stay queued`);
    await notify(`Group-post queue: daily budget hit (${capCheck.reason}). ${rows.length} approved post(s) queued — they post automatically starting tomorrow.`);
    return out;
  }

  // Varied 18-24 min spacing against the last group-post (not the comment
  // pipeline's own last-post — a different action class, separate budget).
  const { data: lastData } = await sbFetch(
    '/rest/v1/group_posts?pipeline=eq.daily5&status=eq.posted&posted_at=not.is.null&order=posted_at.desc&limit=1&select=posted_at',
  );
  if (Array.isArray(lastData) && lastData.length > 0) {
    const ageMin = (Date.now() - new Date(lastData[0].posted_at).getTime()) / 60000;
    if (ageMin < gapMinutes) {
      out.queuedForCap = rows.length;
      log.log(`[group5-post-queue] spacing gap not elapsed (${Math.round(ageMin)}m/${Math.round(gapMinutes)}m) — queued for a later run`);
      return out; // silent: resolves within the hour via the next tick
    }
  }

  // ONE post per run — spacing comes from the run cadence + gap, never bursts.
  const row = rows[0];

  let spawnResult;
  try {
    spawnResult = await spawnPoster(row.id);
  } catch (err) {
    spawnResult = { exitCode: 1, error: err.message };
  }

  // fb-group-poster.js is the single source of truth for what actually
  // happened — re-read the row rather than trust the exit code alone.
  const { data: afterRows } = await sbFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(row.id)}&select=id,status,post_url`,
  );
  const after = Array.isArray(afterRows) && afterRows.length > 0 ? afterRows[0] : null;

  if (after && after.status === 'posted') {
    await caps.recordComment(BUDGET, sbFetch);
    out.posted++;
    log.log(`[group5-post-queue] posted group post ${row.id} (${row.group_name})`);
    return out;
  }

  // Anything else (row reverted to 'approved' by fb-group-poster.js's
  // markFailed path, or the child process itself failed/crashed) is a
  // warning sign on the one Facebook profile this whole strategy depends
  // on. HALT — same conservative posture as the comment pipeline's verify
  // failure. Never auto-retry an unattended failure.
  haltState.setHalt('group-post queue-runner failure (posting or verify did not confirm success)', {
    post_id: row.id, group_name: row.group_name, exit_code: spawnResult.exitCode, spawn_error: spawnResult.error,
  });
  out.failed++;
  out.halted = true;
  await notify(`GROUP-POST QUEUE HALTED — auto-post attempt for "${row.group_name}" did not confirm success (exit ${spawnResult.exitCode}${spawnResult.error ? `, ${spawnResult.error}` : ''}). Row is back to 'approved' if fb-group-poster.js reset it. Check the DossieBot-Sage profile, then clear the SHARED halt:\nnode scripts/fb-group5-post-queue.js --clear-halt\n(this also clears the comment pipeline's halt — same file)`);
  return out;
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function mainCli() {
  const args = process.argv.slice(2);

  if (args.includes('--clear-halt')) {
    const entry = halt.getHalt();
    if (!entry) { console.log('[group5-post-queue] no halt set'); return; }
    halt.clearHalt();
    console.log(`[group5-post-queue] halt cleared (was: ${entry.reason} @ ${entry.halted_at})`);
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[group5-post-queue] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }
  const sbFetch = makeSbFetch();

  if (args.includes('--dry-run')) {
    const { data } = await sbFetch(
      '/rest/v1/group_posts?pipeline=eq.daily5&status=eq.approved&select=id,group_name,post_body&order=approved_at.asc',
    );
    const rows = Array.isArray(data) ? data : [];
    console.log(`[group5-post-queue][dry-run] ${rows.length} approved group post(s) queued:`);
    for (const r of rows) console.log(`  - ${r.group_name}: ${String(r.post_body || '').slice(0, 100)}`);
    console.log(`[group5-post-queue][dry-run] halted: ${halt.isHalted()}`);
    return;
  }

  if (halt.isHalted()) {
    const entry = halt.getHalt();
    console.log(`[group5-post-queue] HALTED (${entry.reason} @ ${entry.halted_at}) — exiting`);
    return;
  }

  // Quick emptiness probe before spawning a child process at all.
  const probe = await sbFetch('/rest/v1/group_posts?pipeline=eq.daily5&status=eq.approved&select=id&limit=1');
  if (!probe.ok || !Array.isArray(probe.data) || probe.data.length === 0) {
    console.log('[group5-post-queue] nothing approved — exiting without launching Chrome');
    return;
  }

  const result = await runGroup5PostQueue({ sbFetch });
  console.log('[group5-post-queue] done:', JSON.stringify(result));
}

module.exports = {
  runGroup5PostQueue,
  variedGapMinutes,
  defaultSpawnPoster,
  BUDGET,
};

if (require.main === module) {
  mainCli().catch((err) => {
    console.error('[group5-post-queue] fatal:', err.message);
    process.exit(1);
  });
}
