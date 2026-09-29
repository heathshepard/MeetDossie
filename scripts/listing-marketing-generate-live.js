'use strict';

// scripts/listing-marketing-generate-live.js
//
// Atomic live-read + generate wrapper for the listing-marketing pipeline.
// Runs listing-marketing-status-sync.js's connectMLS pull and
// listing-marketing-generator.js's post drafting IN THE SAME PROCESS, so
// there is zero gap between "live MLS read" and "content generated off
// that read" -- no DB re-read in between, no window for a stale snapshot
// to slip in underneath a real price/status change.
//
// THIS IS THE ONLY SAFE WAY TO GENERATE LISTING MARKETING CONTENT.
// api/cron-daily-listing-posts.js (Vercel serverless) was disabled
// 2026-09-11 after it advertised 23 Nopalito at a stale $1,195,000 while
// the live MLS price was $999,000 -- Vercel serverless can't hold a
// connectMLS session, so it can never be trusted to generate listing
// content. Never re-enable that cron; run this script locally instead,
// on the schedule wired into scripts/run-tc-discovery-harvest.cmd.
//
// HARD RULE: if the live MLS read fails outright (connectMLS session dead,
// browser launch fails, sign-in fails) -- or if it succeeds but verifies
// ZERO listings -- this script generates NOTHING and alerts Heath on
// Telegram. It NEVER falls back to a cached/DB snapshot. Per-listing
// partial failures (one MLS# fails to parse but others succeed) exclude
// just that listing from today's rotation -- status-sync.js already
// leaves that listing's existing DB row untouched and logs it for manual
// check; the generator here only ever sees rows freshly verified THIS
// run (passed in-memory via opts.freshStatuses, never re-read from the
// DB), so a listing that failed today can never ride through on
// yesterday's numbers either.
//
// Scheduling: called once/day from scripts/run-tc-discovery-harvest.cmd's
// Windows Task Scheduler tick (which fires every 15-30 min), self-gated
// by STATE_FILE below so it only actually runs once per calendar day --
// same once-per-day pattern as scripts/fb-comment-hunt-daily.js.
//
// Usage:
//   node scripts/listing-marketing-generate-live.js               # run for real
//   node scripts/listing-marketing-generate-live.js --dry-run      # print, no DB/state writes
//   node scripts/listing-marketing-generate-live.js --force        # ignore the once/day gate
//
// Owner: Carter, 2026-09-16

const path = require('path');
const fs = require('fs');

try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch (e) { /* non-fatal */ }

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const STATE_FILE = path.join(__dirname, '.listing-marketing-live-state.json');

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch { /* start fresh */ }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[listing-gen-live] could not persist state:', e.message);
  }
}

async function notifyHeath(text) {
  const token = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[listing-gen-live] No Telegram token/chat id configured -- cannot alert Heath. Message was:', text);
    return { ok: false, reason: 'telegram_env_missing' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4090), disable_web_page_preview: true }),
    });
    return { ok: res.ok };
  } catch (err) {
    console.warn('[listing-gen-live] Telegram alert failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

// opts lets the regression test inject fakes for syncAll/generatorRun/
// notifyHeath/state so it never touches Playwright, connectMLS, the real
// Supabase project, or the real Telegram bot.
async function main(opts = {}) {
  const syncAllFn = opts.syncAll || require('./listing-marketing-status-sync').syncAll;
  const generatorRunFn = opts.generatorRun || require('./listing-marketing-generator').run;
  const notify = opts.notifyHeath || notifyHeath;
  const persistState = opts.saveState || saveState;
  const state = opts.state || loadState();
  const force = FORCE || !!opts.force;
  const dryRun = DRY_RUN || !!opts.dryRun;

  if (!force && state.last_run_date === todayKey()) {
    console.log('[listing-gen-live] already ran today -- exiting (once/day by design)');
    return { skipped: 'already_ran_today' };
  }

  let syncResult;
  try {
    syncResult = await syncAllFn({ verifiedBy: 'listing-marketing-generate-live.js' });
  } catch (err) {
    // The live read itself blew up (dead connectMLS session, browser
    // launch failure, sign-in failure) -- generate NOTHING and alert.
    // Never fall back to a DB/cached snapshot; that fallback is exactly
    // the 23 Nopalito incident.
    const msg = `LISTING MARKETING: live connectMLS read FAILED (${err.message}). Generated ZERO posts -- never falling back to cached/DB data. Fix the connectMLS session (node scripts/brokerage-login-setup.js) and rerun: node scripts/listing-marketing-generate-live.js --force`;
    console.error(`[listing-gen-live] ${msg}`);
    const sendRes = await notify(msg);
    if (!dryRun) {
      persistState({ ...state, last_run_date: todayKey(), last_result: 'live_read_failed', last_error: err.message });
    }
    return { ownedDrafted: 0, groupDrafted: 0, liveReadFailed: true, alertSent: !!(sendRes && sendRes.ok) };
  }

  const { failures = [], statusByMls = {} } = syncResult || {};
  const freshStatuses = Object.values(statusByMls);

  if (!freshStatuses.length) {
    // The read ran but verified nothing usable (every listing failed to
    // parse / address-mismatched / errored). Same hard rule applies: zero
    // posts, alert Heath, never touch the generator's DB-fallback path.
    const msg = `LISTING MARKETING: live connectMLS read completed but verified ZERO listings (${failures.length} failure(s): ${JSON.stringify(failures).slice(0, 500)}). Generated ZERO posts -- never falling back to cached/DB data.`;
    console.error(`[listing-gen-live] ${msg}`);
    const sendRes = await notify(msg);
    if (!dryRun) {
      persistState({ ...state, last_run_date: todayKey(), last_result: 'zero_verified', last_error: JSON.stringify(failures).slice(0, 500) });
    }
    return { ownedDrafted: 0, groupDrafted: 0, liveReadFailed: true, alertSent: !!(sendRes && sendRes.ok) };
  }

  if (failures.length) {
    // Partial failure: the listings in freshStatuses were verified live
    // THIS run and are safe to generate from. The failed ones are simply
    // excluded from today's rotation -- status-sync.js already left their
    // existing DB row untouched and logged them for manual check, and
    // they are never passed to the generator, so they can't ride through
    // on a stale number either. Still worth telling Heath why a listing
    // sat out.
    const msg = `LISTING MARKETING: ${failures.length} listing(s) failed the live MLS read this run and were excluded from today's rotation: ${JSON.stringify(failures).slice(0, 500)}. ${freshStatuses.length} listing(s) verified fine and are proceeding.`;
    console.warn(`[listing-gen-live] ${msg}`);
    await notify(msg);
  }

  const genResult = await generatorRunFn({ freshStatuses });

  if (!dryRun) {
    persistState({
      ...state,
      last_run_date: todayKey(),
      last_result: 'ok',
      ownedDrafted: genResult.ownedDrafted,
      groupDrafted: genResult.groupDrafted,
    });
  }

  console.log(`[listing-gen-live] DONE. Live-verified ${freshStatuses.length}/${freshStatuses.length + failures.length} listings. Tier1 drafted: ${genResult.ownedDrafted}, Tier2 drafted: ${genResult.groupDrafted}.`);
  return { ...genResult, liveReadFailed: false, verifiedCount: freshStatuses.length, failedCount: failures.length };
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[listing-gen-live] FATAL', e.message);
    process.exitCode = 1;
  });
}

module.exports = { main, notifyHeath, loadState, saveState, todayKey, STATE_FILE };
