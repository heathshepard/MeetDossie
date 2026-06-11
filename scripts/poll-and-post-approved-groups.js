'use strict';

// scripts/poll-and-post-approved-groups.js
//
// Runs on Windows Task Scheduler (every minute during business hours).
// Queries group_posts where auto_post_at IS NOT NULL AND posted_at IS NULL.
// Spawns fb-group-poster.js for each pending post.
//
// Task Scheduler command:
//   node C:\Users\Heath Shepard\Desktop\MeetDossie\scripts\poll-and-post-approved-groups.js
//
// Env vars (from .env.local):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load .env.local
const envPath = path.join(__dirname, '..', '.env.local');
const env = { ...process.env };

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!env[key]) env[key] = val;
  }
}

const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[poll-and-post-approved-groups] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function getPendingPosts() {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?auto_post_at=not.is.null&posted_at=is.null&order=auto_post_at.asc`,
  );
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function postOne(postId) {
  return new Promise((resolve) => {
    const cmd = process.execPath;
    const args = [
      path.join(__dirname, 'fb-group-poster.js'),
      '--post-id', postId,
    ];

    console.log(`[poll-and-post-approved-groups] Posting ${postId}...`);

    const child = spawn(cmd, args, {
      cwd: path.join(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[poll-and-post-approved-groups] ✅ Posted ${postId}`);
      } else {
        console.error(`[poll-and-post-approved-groups] ❌ Error posting ${postId} (exit code ${code})\n${stderr}`);
      }
      resolve();
    });

    child.on('error', (err) => {
      console.error(`[poll-and-post-approved-groups] Spawn error: ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  try {
    const posts = await getPendingPosts();
    if (!posts.length) {
      console.log(`[poll-and-post-approved-groups] No pending posts. Sleeping.`);
      return;
    }

    console.log(`[poll-and-post-approved-groups] Found ${posts.length} pending post(s). Processing...`);

    // Post one at a time to avoid overwhelming the browser
    for (const post of posts) {
      await postOne(post.id);
      // Small delay between posts
      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log(`[poll-and-post-approved-groups] Batch complete.`);
  } catch (err) {
    console.error('[poll-and-post-approved-groups] Fatal error:', err.message);
  }
}

main();
