'use strict';

// scripts/reddit-scan-with-session.js
//
// One-off scanner that fetches r/realtors/new and r/realestate/new via the
// Reddit OAuth API, filters by a broadened keyword set, and prints the top
// candidate posts as JSON for downstream insertion into reddit_engagements.
//
// (Previously used a saved Playwright session — migrated to OAuth on
//  2026-06-08. Filename kept for backwards compatibility.)
//
// Env vars: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and either
//           REDDIT_REFRESH_TOKEN or REDDIT_USERNAME + REDDIT_PASSWORD.

const path = require('path');
const fs = require('fs');

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

const reddit = require(path.join(__dirname, '..', 'api', '_lib', 'reddit-oauth.js'));

const KEYWORDS = [
  'tc', 'transaction coordinator', 'transaction coordination',
  'deadlines', 'deadline', 'title company', 'amendment',
  'option period', 'closing', 'drowning', 'burnt out', 'burned out',
  'missed deadline', 'zipforms', 'dotloop', 'skyslope',
  'paperwork', 'overwhelmed', 'compliance',
];

const SUBREDDITS = ['realtors', 'realestate'];

async function main() {
  const allPosts = [];

  for (const sub of SUBREDDITS) {
    try {
      const posts = await reddit.fetchSubredditNew(sub, 50);
      console.error(`r/${sub}: fetched ${posts.length} posts`);
      for (const p of posts) {
        allPosts.push({ ...p, _subreddit: sub });
      }
    } catch (err) {
      console.error(`r/${sub} fetch error:`, err.message);
    }
  }

  // Filter by keyword match in title or body
  const matches = [];
  for (const post of allPosts) {
    const text = `${post.title || ''} ${post.selftext || ''}`.toLowerCase();
    const hit = KEYWORDS.find(k => {
      // Word boundary for short tokens to avoid false positives
      if (k.length <= 3) {
        return new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
      }
      return text.includes(k);
    });
    if (hit) {
      matches.push({
        id: post.id,
        subreddit: post._subreddit,
        title: post.title,
        selftext: (post.selftext || '').slice(0, 800),
        permalink: post.permalink,
        url: `https://www.reddit.com${post.permalink || ''}`,
        score: post.score || 0,
        created_utc: post.created_utc,
        num_comments: post.num_comments || 0,
        keyword: hit,
      });
    }
  }

  // Rank by recency
  matches.sort((a, b) => (b.created_utc - a.created_utc));

  console.log(JSON.stringify({ total: allPosts.length, matched: matches.length, matches: matches.slice(0, 10) }, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
