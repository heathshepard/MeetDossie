'use strict';

// scripts/fb-group-watcher.js
//
// Finds approved group_posts rows with posted_at IS NULL and fires
// fb-group-poster.js for each one, sequentially.
//
// Intended to run on a schedule (Windows Task Scheduler, every 60 min).
// Exits silently when no posts are pending.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

// Load .env.local
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Migrated 2026-06-10: no longer reads sessions/facebook.json. The downstream
// poster uses Heath's persistent Chrome profile. Watchdog state tracks
// consecutive poster failures; only escalates to Cole after 3 in a row,
// never to Heath.
const WATCHDOG_FILE = path.join(__dirname, '.fb-watcher-failures.json');
const FAILURE_THRESHOLD = 3;

function readFailureCount() {
  try {
    if (!fs.existsSync(WATCHDOG_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(WATCHDOG_FILE, 'utf8'));
    return Number(data.count) || 0;
  } catch {
    return 0;
  }
}

function writeFailureCount(count) {
  try {
    fs.writeFileSync(WATCHDOG_FILE, JSON.stringify({
      count,
      last_updated: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

async function alertCole(message) {
  // Cole gets the failure escalation, not Heath. If TELEGRAM_BOT_TOKEN is
  // present we log it via a desktop notification file Cole can poll, plus
  // a Telegram message addressed to Cole (not the raw "renew" instruction).
  console.error(`[fb-group-watcher] WATCHDOG ALERT: ${message}`);
  try {
    const alertFile = path.join(__dirname, '..', '.cole-alerts.jsonl');
    fs.appendFileSync(alertFile, JSON.stringify({
      ts: new Date().toISOString(),
      source: 'fb-group-watcher',
      severity: 'warn',
      message,
    }) + '\n');
  } catch {}
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `Cole — FB poster watchdog tripped: ${message}. Investigate and resolve without bothering Heath.`,
    }),
  }).catch(() => {});
}

function ts() {
  return new Date().toISOString();
}

// Guard: Kill any leftover Chrome processes from prior runs (automation-only)
function cleanupZombieChrome() {
  try {
    const cmd = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '(--headless|--remote-debugging|Playwright|\.cache\\\\ms-playwright|\.cache\\\\puppeteer)' -or (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue).Name -in @('powershell','node','python') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    execSync(`powershell -NoProfile -Command "${cmd}"`, { stdio: 'pipe' });
  } catch (e) {
    // Non-fatal; don't block watcher
  }
}

async function fetchApprovedPosts() {
  const url = `${SUPABASE_URL}/rest/v1/group_posts?status=eq.approved&posted_at=is.null&select=id,group_name`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase query failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function runPoster(postId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      ['scripts/fb-group-poster.js', '--post-id', postId],
      {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
      }
    );
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`fb-group-poster exited with code ${code} for post ${postId}`));
      }
    });
    child.on('error', reject);
  });
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`[${ts()}] [fb-group-watcher] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required`);
    process.exit(1);
  }

  // Preflight: close FB tabs in Heath's main Chrome before firing any
  // automation. The poster runs preflight too, but watcher pre-closing
  // tabs avoids a thrash when there are multiple queued posts.
  try {
    const { preflight } = require('./_lib/fb-tab-preflight');
    const pre = await preflight({ reason: 'fb-group-watcher' });
    console.log(`[${ts()}] [fb-group-watcher] preflight: closed=${pre.closed} skipped_dossiebot=${pre.skipped_dossiebot}`);
  } catch (e) {
    console.warn(`[${ts()}] [fb-group-watcher] preflight non-fatal error: ${e.message}`);
  }

  // No more session-file validity check — the poster uses Heath's persistent
  // Chrome profile, which has no expiry. If the profile ever becomes
  // logged-out, the poster throws and we increment the watchdog below.

  cleanupZombieChrome();

  const posts = await fetchApprovedPosts();

  console.log(`[${ts()}] [fb-group-watcher] Found ${posts.length} approved post(s)`);

  if (posts.length === 0) {
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;

  for (const post of posts) {
    console.log(`[${ts()}] [fb-group-watcher] Processing post ${post.id} -> "${post.group_name}"`);
    try {
      await runPoster(post.id);
      console.log(`[${ts()}] [fb-group-watcher] Done: ${post.id}`);
      succeeded++;
    } catch (err) {
      console.error(`[${ts()}] [fb-group-watcher] Failed: ${post.id} - ${err.message}`);
      failed++;
    }
  }

  console.log(`[${ts()}] [fb-group-watcher] Finished. Succeeded: ${succeeded}, Failed: ${failed}`);

  // Watchdog: track CONSECUTIVE failed runs (any success resets the counter).
  // Only escalate to Cole — never Heath — and only after FAILURE_THRESHOLD
  // (3) consecutive all-failure runs to suppress transient FB UI glitches.
  if (succeeded > 0) {
    writeFailureCount(0);
  } else if (failed > 0) {
    const newCount = readFailureCount() + 1;
    writeFailureCount(newCount);
    if (newCount >= FAILURE_THRESHOLD) {
      await alertCole(
        `${newCount} consecutive watcher runs failed. Likely cause: Chrome profile logged out, FB UI changed, or selector drift. ` +
        `Last error: ${failed} of ${succeeded + failed} posts failed.`
      );
    } else {
      console.log(`[${ts()}] [fb-group-watcher] ${newCount}/${FAILURE_THRESHOLD} consecutive failures — staying quiet.`);
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[${ts()}] [fb-group-watcher] Fatal error: ${err.message}`);
  process.exit(1);
});

// Ensure cleanup on exit
process.on('exit', cleanupZombieChrome);
