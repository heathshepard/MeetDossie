'use strict';

// scripts/reddit-pain-scraper.js
//
// Pulls real, current complaint/pain-point language from r/realtors,
// r/RealEstateAgents, r/RealEstateAdvice — TC-pain, deadline-stress,
// paperwork-overwhelm — so the content generator (api/cron-generate-posts.js)
// can write hooks sourced from real language agents actually use, not guessed
// in a vacuum. Same "content fuel" pattern as scripts/ad-library-scraper.js:
// scrape -> rank -> cache -> prompt-injectable block.
//
// Reddit's .json search/listing endpoints 403 from datacenter IPs (confirmed
// 2026-08-18, and already documented in scripts/reddit-scanner.js). The
// public Atom RSS feeds (*.rss) do NOT require auth and are not blocked —
// this uses those, same as reddit-scanner.js. RSS carries no vote score, so
// ranking here is match-count (how many pain keywords hit) + recency, not
// upvotes — matches the "rank by frequency/recency" ask.
//
// Usage:
//   node scripts/reddit-pain-scraper.js
//   node scripts/reddit-pain-scraper.js --dry-run   (skip Supabase writes)
//
// Env vars:
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — writes to reddit_pain_language
//     (table + social_posts.hook_variant added by
//     supabase/migrations/20260818c_reddit_pain_and_hook_variant.sql /
//     api/admin-migrate-reddit-pain-hook-variant.js). Falls back to
//     cache-only if unset.
//
// Output:
//   scripts/.reddit-pain-cache.json — latest scrape, deduped by reddit_id
//   Supabase reddit_pain_language — upserted on conflict(reddit_id)
//   stdout — summary + one example "content fuel" block

const path = require('path');
const fs = require('fs');

// ─── Env load ───────────────────────────────────────────────────────────────
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const seen = new Set();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (val === '[SENSITIVE]') continue; // vercel env pull placeholder — not a real value
      if (seen.has(key)) continue; // first non-placeholder wins; skip later dupes too
      seen.add(key);
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) {
    // Non-fatal
  }
})();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CACHE_FILE = path.join(__dirname, '.reddit-pain-cache.json');

const SUBREDDITS = ['realtors', 'RealEstateAgents', 'RealEstateAdvice'];
const FEED_LIMIT = 100;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// ─── Pain-language categories ──────────────────────────────────────────────
// Loose keyword sets, not exact phrase matching — real Reddit language is
// messy. Each category is checked independently so one post can match more
// than one category (e.g. "my TC missed the option deadline" hits both).
const PAIN_CATEGORIES = {
  tc_pain: [
    'transaction coordinator', /\btc\b/i, 'fired my tc', 'quit on me', 'ghosted',
    'flaked', 'hired a tc', 'need a tc', 'tc quit', 'without a tc', 'my tc',
  ],
  deadline_stress: [
    'option period', 'deadline', 'missed the deadline', 'closing date',
    'extension', 'running out of time', 'last minute', 'forgot to submit',
    'forgot to send', 'time crunch', 'earnest money deadline', 'option ends',
  ],
  paperwork_overwhelm: [
    'paperwork', 'so many forms', 'zipform', 'dotloop', 'skyslope',
    'drowning in', 'overwhelmed', 'too many tabs', 'disclosures', 'amendment',
    'confusing forms', 'buried in paperwork', 'admin work', 'busy work',
  ],
};

function classify(text) {
  const lower = text.toLowerCase();
  const categories = [];
  let matchCount = 0;
  for (const [cat, patterns] of Object.entries(PAIN_CATEGORIES)) {
    let hits = 0;
    for (const p of patterns) {
      if (p instanceof RegExp) {
        if (p.test(text)) hits++;
      } else if (lower.includes(p.toLowerCase())) {
        hits++;
      }
    }
    if (hits > 0) {
      categories.push(cat);
      matchCount += hits;
    }
  }
  return { categories, matchCount };
}

// ─── RSS parse ──────────────────────────────────────────────────────────────

function decodeHtml(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtml(str) {
  return decodeHtml(str)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRedditId(atomId, permalink) {
  const t3Match = atomId && atomId.match(/t3_([a-z0-9]+)/i);
  if (t3Match) return t3Match[1];
  const urlMatch = permalink && permalink.match(/\/comments\/([a-z0-9]+)\//i);
  if (urlMatch) return urlMatch[1];
  return atomId || '';
}

function parseRss(xml, subreddit) {
  const posts = [];
  const entries = xml.split(/<entry>/i).slice(1);
  for (const entry of entries) {
    const titleMatch = entry.match(/<title>([^<]*)<\/title>/i);
    const idMatch = entry.match(/<id>([^<]*)<\/id>/i);
    const linkMatch = entry.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
    const publishedMatch = entry.match(/<published>([^<]*)<\/published>/i);
    const contentMatch = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/i);

    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const permalink = linkMatch ? linkMatch[1] : '';
    const redditId = extractRedditId(idMatch ? idMatch[1] : '', permalink);
    const publishedAt = publishedMatch ? publishedMatch[1] : null;
    const bodyText = contentMatch ? stripHtml(contentMatch[1]) : '';

    if (!title || !redditId) continue;
    posts.push({ redditId, subreddit, title, permalink, publishedAt, bodyText });
  }
  return posts;
}

// ─── Fetch with 429 backoff ─────────────────────────────────────────────────
// Confirmed live 2026-08-18: rapid-fire requests to reddit.com/*.rss trigger
// 429s within ~3s of each other. This backs off on 429 (honoring Retry-After
// when present) and spaces every request out regardless of outcome.
async function fetchRssWithBackoff(url, { maxAttempts = 4 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'User-Agent': USER_AGENT,
        },
      });
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
        const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 15000;
        console.warn(`[reddit-pain-scraper] 429 on ${url}, waiting ${waitMs}ms (attempt ${attempt}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        break;
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

// ─── Ranking ─────────────────────────────────────────────────────────────
function computeRankScore(matchCount, publishedAt) {
  let recencyBonus = 0;
  if (publishedAt) {
    const ageDays = (Date.now() - new Date(publishedAt).getTime()) / 86400000;
    recencyBonus = Math.max(0, 14 - ageDays); // 2-week decay window
  }
  return matchCount * 10 + recencyBonus;
}

// ─── Content fuel block ────────────────────────────────────────────────────
// Same shape as buildContentFuelBlock() in scripts/ad-library-scraper.js /
// buildTopPerformerBlock() in api/cron-generate-posts.js — labeled section +
// bullet examples of REAL language, ranked highest first.
function buildRedditPainBlock(rows, limit = 8) {
  if (!rows || rows.length === 0) return '';
  const lines = [
    '',
    '## REAL AGENT PAIN LANGUAGE (r/realtors, r/RealEstateAgents, r/RealEstateAdvice — pulled live)',
    'These are real complaints/questions agents posted, in their own words.',
    'Study the PHRASING — write hooks that sound like something a real agent',
    'would actually say, not a marketing paraphrase of the same idea.',
    'Do not quote these verbatim or reference Reddit in the post.',
    '',
  ];
  for (const row of rows.slice(0, limit)) {
    const snippet = row.snippet ? ` — "${row.snippet.slice(0, 160)}"` : '';
    lines.push(`- [r/${row.subreddit}] "${row.title}"${snippet}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ─── Supabase upsert ────────────────────────────────────────────────────────
async function upsertToSupabase(rows) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[reddit-pain-scraper] SUPABASE_URL/SERVICE_ROLE_KEY not set — skipping DB write, cache-only');
    return { attempted: 0, ok: 0 };
  }
  let ok = 0;
  for (const row of rows) {
    const payload = {
      reddit_id: row.redditId,
      subreddit: row.subreddit,
      title: row.title.slice(0, 500),
      snippet: row.bodyText ? row.bodyText.slice(0, 500) : null,
      url: row.permalink || null,
      pain_categories: row.categories,
      match_count: row.matchCount,
      posted_at: row.publishedAt || null,
      rank_score: row.rankScore,
      last_seen_at: new Date().toISOString(),
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/reddit_pain_language?on_conflict=reddit_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) ok++;
    else console.warn(`[reddit-pain-scraper] upsert failed for ${row.redditId}: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return { attempted: rows.length, ok };
}

// ─── Core scrape (shared by CLI main() and api/admin-run-reddit-pain-scraper.js) ──
// fetchRssFn(url) -> Promise<string xml>. Defaults to the raw-fetch-with-backoff
// path (works fine from a residential/task-scheduler IP); the Vercel admin
// endpoint passes its own egress path, since Reddit blocks bursty requests
// from this sandbox's specific IP but not necessarily every cloud IP.
async function scrapeAll({ fetchRssFn = fetchRssWithBackoff, gapMs = 8000, log = console.log, warn = console.warn } = {}) {
  const allMatched = [];
  const scanStats = [];

  for (let i = 0; i < SUBREDDITS.length; i++) {
    const sub = SUBREDDITS[i];
    const url = `https://www.reddit.com/r/${sub}/new.rss?limit=${FEED_LIMIT}`;
    log(`[reddit-pain-scraper] Fetching r/${sub}/new.rss (limit=${FEED_LIMIT})`);
    let xml;
    try {
      xml = await fetchRssFn(url);
    } catch (err) {
      warn(`[reddit-pain-scraper] Failed r/${sub}: ${err.message}`);
      scanStats.push({ sub, scanned: 0, matched: 0, error: err.message });
      continue;
    }
    const posts = parseRss(xml, sub);
    let matched = 0;
    for (const post of posts) {
      const combined = `${post.title} ${post.bodyText}`;
      const { categories, matchCount } = classify(combined);
      if (matchCount === 0) continue;
      matched++;
      allMatched.push({
        ...post,
        categories,
        matchCount,
        rankScore: computeRankScore(matchCount, post.publishedAt),
      });
    }
    scanStats.push({ sub, scanned: posts.length, matched });
    log(`[reddit-pain-scraper]   r/${sub}: ${posts.length} posts scanned, ${matched} pain-language matches`);

    // Space requests out — confirmed 2026-08-18 that <5s gaps trigger 429s.
    if (i < SUBREDDITS.length - 1) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }

  // Dedupe by redditId, keep highest rankScore instance (shouldn't collide
  // across subs since ids are per-post, but a re-run could re-fetch the same
  // post under a different scrape — keep the freshest).
  const byId = new Map();
  for (const row of allMatched) {
    const existing = byId.get(row.redditId);
    if (!existing || row.rankScore > existing.rankScore) byId.set(row.redditId, row);
  }
  const deduped = [...byId.values()].sort((a, b) => b.rankScore - a.rankScore);

  return { deduped, scanStats };
}

// ─── Main (CLI) ───────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { deduped } = await scrapeAll();

  fs.writeFileSync(
    CACHE_FILE,
    JSON.stringify({ scrapedAt: new Date().toISOString(), rows: deduped }, null, 2),
    'utf8',
  );

  console.log(`\n[reddit-pain-scraper] Done. ${deduped.length} real pain-language post(s) across ${SUBREDDITS.length} subreddit(s). Cached -> ${CACHE_FILE}`);

  const byCategory = new Map();
  for (const row of deduped) {
    for (const cat of row.categories) byCategory.set(cat, (byCategory.get(cat) || 0) + 1);
  }
  console.log('\nPain categories found:');
  for (const [cat, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${cat} (${count})`);
  }

  console.log('\nTop 5 by rank_score:');
  for (const row of deduped.slice(0, 5)) {
    console.log(`  [${row.rankScore.toFixed(1)}] r/${row.subreddit} "${row.title}" (${row.categories.join(',')})`);
  }

  console.log('\n--- CONTENT FUEL BLOCK (spliced into cron-generate-posts.js buildPrompt() via fetchRedditPainLanguage()) ---');
  console.log(buildRedditPainBlock(deduped));

  if (!dryRun) {
    const { attempted, ok } = await upsertToSupabase(deduped);
    console.log(`\n[reddit-pain-scraper] Supabase upsert: ${ok}/${attempted} rows written to reddit_pain_language.`);
  } else {
    console.log('\n[reddit-pain-scraper] --dry-run set, skipped Supabase write.');
  }
}

module.exports = { classify, parseRss, computeRankScore, buildRedditPainBlock, PAIN_CATEGORIES, scrapeAll, upsertToSupabase, fetchRssWithBackoff };

if (require.main === module) {
  main().catch((err) => {
    console.error('[reddit-pain-scraper] Fatal error:', err.message);
    process.exit(1);
  });
}
