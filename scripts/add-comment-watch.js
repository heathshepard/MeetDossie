'use strict';

// scripts/add-comment-watch.js
//
// Manually register a comment Heath left on someone else's post so
// scripts/watch-guest-thread-replies.js watches the thread for replies.
// The engagement_queue "Mark Posted" tap does this automatically — this CLI
// covers ad-hoc comments left outside that pipeline (which would otherwise
// be invisible to the reply watcher).
//
// Usage:
//   node scripts/add-comment-watch.js --url "<post/comment permalink>" \
//     --text "<the comment Heath posted, as close to verbatim as possible>" \
//     [--group "Group Name"] [--author "Post Author"] [--posted-at 2026-09-08T15:00:00Z]
//
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Owner: Carter, 2026-09-08

const path = require('path');
const fs = require('fs');

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
} catch (e) { /* non-fatal */ }

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const url = arg('--url');
  const text = arg('--text');
  if (!url || !text) {
    console.error('Usage: node scripts/add-comment-watch.js --url "<permalink>" --text "<comment text>" [--group "..."] [--author "..."] [--posted-at ISO]');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[add-comment-watch] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/comment_watchlist`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      thread_url: url,
      group_name: arg('--group') || null,
      post_author: arg('--author') || null,
      direction: 'heath_commented_on_others',
      our_text: text,
      source_table: 'manual',
      source_id: null,
      posted_at: arg('--posted-at') || new Date().toISOString(),
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`[add-comment-watch] insert failed (${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`[add-comment-watch] watching ${url} (id=${body && body[0] && body[0].id})`);
}

main().catch((err) => { console.error('[add-comment-watch] FATAL:', err.message); process.exit(1); });
