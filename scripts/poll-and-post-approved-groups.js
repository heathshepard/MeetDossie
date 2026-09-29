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

// 2026-09-16 (Carter, silence-alarm first-firing investigation): this
// runner ONLY ever selects on auto_post_at IS NOT NULL. Every group_posts
// approve callback has set auto_post_at at approval time since 2026-09-11
// (api/group-post-callback.js, api/group5-post-callback.js,
// api/listing-group-post-callback.js), so that's correct for anything
// approved after that fix. But 3 rows approved BEFORE 2026-09-11 (oldest:
// Dallas Texas Realtors, 2026-06-10) have status='approved',
// posted_at=null, auto_post_at=null -- permanently invisible to this
// query, with nothing here ever saying so. Do NOT silently start
// auto-posting arbitrary-age approved rows just because auto_post_at is
// null (stale content risk -- Heath's explicit instruction: review each
// one's content before it goes anywhere near auto-post). Instead, this
// This just makes the failure mode loud locally too, so a future instance
// of the same bug (a new approval path that forgets to set auto_post_at)
// can't go unnoticed for months again.
async function getPendingPosts() {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?auto_post_at=not.is.null&posted_at=is.null&order=auto_post_at.asc`,
  );
  if (!ok || !Array.isArray(data)) return [];

  // Diagnostic only -- never added to the post queue. Surfaces the exact
  // failure mode above locally (console) so it can't go unnoticed again;
  // api/cron-silence-alarm.js's approvals_stale:group_posts condition is
  // the loud Telegram-facing version of the same check.
  const orphaned = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.approved&posted_at=is.null&auto_post_at=is.null&select=id,group_name,approved_at&order=approved_at.asc`,
  );
  if (orphaned.ok && Array.isArray(orphaned.data) && orphaned.data.length > 0) {
    console.warn(
      `[poll-and-post-approved-groups] ${orphaned.data.length} approved row(s) have NO auto_post_at and will NEVER be picked up by this query -- ` +
      `needs manual review + backfill, not auto-post (oldest: ${orphaned.data[0].group_name}, approved ${orphaned.data[0].approved_at}). ` +
      `IDs: ${orphaned.data.map((r) => r.id).join(', ')}`,
    );
  }

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
