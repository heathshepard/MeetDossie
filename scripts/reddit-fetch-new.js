'use strict';

// scripts/reddit-fetch-new.js
//
// Fetches /new from r/realtors + r/realestate using the captured Reddit
// session (cookies from scripts/sessions/reddit.json), bypassing Reddit's
// public-API rate-limit block on bare User-Agents.
//
// Usage:
//   node scripts/reddit-fetch-new.js
//   node scripts/reddit-fetch-new.js --subreddit=realtors --limit=25

const path = require('path');
const fs = require('fs');

const SESSION_FILE = path.join(__dirname, 'sessions', 'reddit.json');

function buildCookieHeader() {
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  const parts = [];
  for (const c of data.cookies || []) {
    // Reddit www cookies only
    if (!c.domain.includes('reddit.com')) continue;
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join('; ');
}

async function fetchSubredditNew(subreddit, limit = 25) {
  const cookie = buildCookieHeader();
  const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': cookie,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  }
  let json;
  try { json = JSON.parse(text); } catch (e) {
    return { ok: false, status: res.status, error: `parse: ${e.message}; head=${text.slice(0, 200)}` };
  }
  const posts = (json?.data?.children || []).map(c => c.data).filter(Boolean);
  return { ok: true, status: res.status, posts };
}

async function main() {
  const args = process.argv.slice(2);
  let subreddit = null;
  let limit = 25;
  for (const a of args) {
    if (a.startsWith('--subreddit=')) subreddit = a.slice('--subreddit='.length);
    if (a.startsWith('--limit=')) limit = parseInt(a.slice('--limit='.length), 10);
  }
  const subs = subreddit ? [subreddit] : ['realtors', 'realestate'];
  const out = {};
  for (const s of subs) {
    const r = await fetchSubredditNew(s, limit);
    out[s] = r;
    if (!r.ok) {
      console.error(`[reddit-fetch-new] r/${s} FAILED ${r.status}: ${r.error}`);
      continue;
    }
    console.error(`[reddit-fetch-new] r/${s}: ${r.posts.length} posts`);
  }
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('[reddit-fetch-new] fatal:', err && err.message);
  process.exit(1);
});
