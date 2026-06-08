'use strict';

// scripts/fb-group-watcher.js
//
// Finds approved group_posts rows with posted_at IS NULL and fires
// fb-group-poster.js for each one, sequentially.
//
// Intended to run on a schedule (Windows Task Scheduler, every 30 min).
// Exits silently when no posts are pending.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

const SESSION_FILE = path.join(__dirname, 'sessions', 'facebook.json');

async function alertSessionExpired() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: 'Facebook login needs renewal. Run: node scripts/capture-facebook-session.js',
    }),
  }).catch(() => {});
}

function sessionIsValid() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return Array.isArray(data.cookies) && data.cookies.some(c => c.name === 'c_user' && c.value);
  } catch {
    return false;
  }
}

function ts() {
  return new Date().toISOString();
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

  if (!sessionIsValid()) {
    console.error(`[${ts()}] [fb-group-watcher] Session file missing or invalid. Sending Telegram alert.`);
    await alertSessionExpired();
    process.exit(1);
  }

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
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[${ts()}] [fb-group-watcher] Fatal error: ${err.message}`);
  process.exit(1);
});
