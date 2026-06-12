#!/usr/bin/env node
// scripts/sage-fb-comment-scanner.js
//
// Hourly Facebook scanner for Sage's comment-engagement pipeline.
//
// Engine: mobile FB (m.facebook.com + iPhone UA) — same approach Sage's
// sage-mobile-groups-scan.js proved bypasses the desktop login wall on
// public Texas RE groups + RE coach pages.
//
// Output: writes posts scoring >= MIN_SCORE (3) into the existing
// public.engagement_candidates table (platform='facebook'). Sage's existing
// pipeline takes it from there:
//   1. cron-sage-draft-engagements (every 30 min) -> drafts a Heath-voice
//      reply via Haiku
//   2. cron-send-engagement-approvals (every 15 min) -> ships to
//      DossieMarketingBot for approval
//   3. PyAutoGUI poster (manual / scheduled) -> posts approved drafts
//
// Schedule: Windows Task Scheduler "Dossie FB Comment Scanner" runs this
// every hour 13:00-23:00 UTC Mon-Fri (= 8 AM - 6 PM CDT).
//
// Failure handling (per the no-quitting rule): zero candidates from one
// group -> move to next group. No Telegram noise. Aggregate failure (the
// whole scan throws) -> exit 1 so Task Scheduler logs it.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env.local');
loadDotenv(ENV_PATH);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
  process.exit(1);
}

const TARGETS = [
  // Texas RE groups -- mobile site renders public posts without login
  { name: 'Ginger Unger - RE Instructor', url: 'https://m.facebook.com/groups/gingerungerinstructor/' },
  { name: 'Texas Real Estate Agents', url: 'https://m.facebook.com/groups/texasusarealestateagents/' },
  { name: 'Texas Real Estate Network', url: 'https://m.facebook.com/groups/texasrealestategroup/' },
  { name: 'Dallas Texas Realtors', url: 'https://m.facebook.com/groups/dallasrealtors/' },
  { name: 'Real Estate Agents Mastermind', url: 'https://m.facebook.com/groups/152569472013647/' },
  { name: 'Shift Talk', url: 'https://m.facebook.com/groups/959497342026290/' },
  { name: 'Club Wealth Mastermind', url: 'https://m.facebook.com/groups/ClubWealth/' },
  // RE coach / educator public pages
  { name: 'Hustle Humbly Podcast', url: 'https://m.facebook.com/hustlehumblypodcast/' },
  { name: 'Real Estate Rookie', url: 'https://m.facebook.com/realestaterookie/' },
  { name: 'Tom Ferry', url: 'https://m.facebook.com/CoachTomFerry/' },
  { name: 'NAR Realtors Association', url: 'https://m.facebook.com/narrealtor/' },
];

const MIN_SCORE = 3;
const MAX_POST_BODY = 1500;
const NAV_TIMEOUT_MS = 25000;
const SETTLE_MS = 3000;
const SCROLL_TIMES = 3;

// ─── Relevance scoring (JS port of unified-scanner/relevance.py) ─────────────

const PAIN_KEYWORDS = [
  'transaction coordinator', ' tc ', 'tc quit', 'tc fees', 'tc cost',
  'drowning in paperwork', 'drowning in deals', 'drowning in files',
  'missed deadline', 'missed the option period', 'option period',
  'trec form', 'trec amendment', 'trec addendum',
  'zipforms', 'ziplogix', 'dotloop', 'skyslope', 'transactiondesk',
  'broker compliance', 'compliance review',
  'too many tabs', 'too many apps', 'real estate software', 'tc software',
  'deal coordinator', 'deadline reminder', 'closing checklist', 'earnest money',
  'back to back closings', 'behind on paperwork', 'burned out', 'burned-out',
  'behind on files', 'office manager quit',
];

const TEXAS_SIGNALS = [
  'texas', ' tx ', 'san antonio', 'houston', 'austin', 'dallas',
  'fort worth', 'dfw', 'san marcos', 'boerne', 'new braunfels',
  'rio grande valley', 'rgv', 'kw ', 'keller williams', 'trec',
];

const HOT_PHRASES = [
  'looking for a tc', 'looking for transaction coordinator',
  'need a transaction coordinator', 'anyone use a tc',
  'what tc do you use', 'how do you handle paperwork',
  'i need help with my files', 'broker requires',
  "broker won't accept", "broker won't sign off", 'office said',
];

const MARKETPLACE_SIGNALS = [
  'for sale', 'for rent', 'asking price', ' obo ', 'best offer',
  'just listed', 'just sold', 'property for', 'real estate for',
  '$ per month', '$ month', '$ /month', '$ annually',
];

function normalize(text) {
  return ' ' + (text || '').toLowerCase().replace(/\n/g, ' ').replace(/\t/g, ' ') + ' ';
}

function isMarketplacePost(text) {
  const n = normalize(text);
  // If contains dollar sign AND marketplace signal, likely a listing.
  // This filters out barn sheds, property sales, rental posts, etc.
  const hasDollar = /\$/.test(text);
  if (!hasDollar) return false;
  for (const sig of MARKETPLACE_SIGNALS) {
    if (n.includes(sig)) return true;
  }
  return false;
}

function scoreText(text) {
  if (!text) return { score: 0, matched: [] };
  // Reject marketplace/listing posts entirely (no score)
  if (isMarketplacePost(text)) {
    return { score: 0, matched: ['MARKETPLACE_FILTERED'] };
  }
  const n = normalize(text);
  let score = 0;
  const matched = [];
  for (const kw of PAIN_KEYWORDS) {
    if (n.includes(kw)) { score += 2; matched.push(kw.trim()); }
  }
  for (const hp of HOT_PHRASES) {
    if (n.includes(hp)) { score += 3; matched.push(hp.trim()); }
  }
  for (const sig of TEXAS_SIGNALS) {
    if (n.includes(sig)) { score += 1; matched.push(sig.trim()); }
  }
  // Dedupe
  return { score, matched: [...new Set(matched)] };
}

// ─── Post splitting ──────────────────────────────────────────────────────────

// Mobile FB renders each post separated by "Like Comment Share" footer or by
// blank-line gaps. We split on those and keep chunks long enough to be real
// posts. Same heuristic as scripts/unified-scanner/fb_groups.py.
const DIVIDER_RX = /\n\s*Like\s*\n\s*Comment\s*\n\s*Share\s*\n/i;

function splitPosts(bodyText) {
  if (!bodyText) return [];
  const normalized = bodyText.replace(/\r\n/g, '\n');
  const chunks = normalized.split(DIVIDER_RX);
  const out = [];
  for (const c of chunks) {
    const trimmed = c.trim();
    if (trimmed.length < 60) continue;
    // Keep last 1500 chars to focus on the post body, not the scrollback above
    out.push(trimmed.slice(-MAX_POST_BODY));
  }
  return out;
}

// Try to lift a per-post permalink out of the chunk. Mobile FB sometimes leaks
// /story.php?... or /groups/<id>/permalink/<id> URLs in copyable text.
const PERMALINK_RX = /https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:groups\/[^\s/]+\/(?:permalink|posts)\/\d+|story\.php\?[^\s]+)/i;

function extractPermalink(chunk) {
  const m = chunk.match(PERMALINK_RX);
  return m ? m[0] : null;
}

// Author heuristic: first short non-empty line that isn't boilerplate.
const BOILERPLATE = new Set(['Like', 'Comment', 'Share', 'See more', 'Edited', 'All reactions:', 'Most relevant', 'Top comments', 'View more comments']);

function extractAuthor(chunk) {
  const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (BOILERPLATE.has(l)) continue;
    if (l.length > 0 && l.length < 80 && !/[.!?]$/.test(l)) {
      return l;
    }
  }
  return '';
}

// ─── Supabase ────────────────────────────────────────────────────────────────

async function upsertCandidate(row) {
  const url = `${SUPABASE_URL}/rest/v1/engagement_candidates?on_conflict=platform,post_url`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    console.warn(`  upsert failed ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return Array.isArray(data) && data[0] ? data[0] : null;
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

async function scanOne(page, target, scannerRunId) {
  console.log(`[${target.name}]`);
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
  } catch (e) {
    console.log(`  nav fail: ${e.message}`);
    return { found: 0, inserted: 0 };
  }

  // Scroll to load more posts past the fold
  for (let i = 0; i < SCROLL_TIMES; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
    await page.waitForTimeout(1500);
  }

  let body = '';
  try { body = await page.locator('body').innerText(); } catch {}

  if (!body || body.length < 200) {
    console.log(`  empty / blocked (len=${body.length})`);
    return { found: 0, inserted: 0 };
  }

  const isLoginWall = /You must log in/i.test(body) || /Create new account/i.test(body) && body.length < 800;
  const isUnavailable = /content isn't available/i.test(body);
  if (isLoginWall || isUnavailable) {
    console.log(`  blocked (loginWall=${isLoginWall} unavail=${isUnavailable})`);
    return { found: 0, inserted: 0 };
  }

  const posts = splitPosts(body);
  console.log(`  parsed ${posts.length} post chunks`);

  let inserted = 0;
  for (const chunk of posts) {
    const { score, matched } = scoreText(chunk);
    if (score < MIN_SCORE) continue;

    const permalink = extractPermalink(chunk);
    // No permalink -> synthesize a per-chunk URL using a content hash so the
    // unique (platform, post_url) constraint dedupes the same post across runs
    // but lets distinct posts in the same group coexist.
    const chunkHash = crypto.createHash('sha1').update(chunk).digest('hex').slice(0, 12);
    const postUrl = permalink || `${target.url}#post-${chunkHash}`;

    const author = extractAuthor(chunk);
    const row = {
      platform: 'facebook',
      post_url: postUrl,
      post_text: chunk.slice(0, 8000),
      author_handle: author.slice(0, 200),
      relevance_score: score,
      matched_keywords: matched,
      status: 'pending',
      scanner_run_id: scannerRunId,
      // Tag with the group name in author_handle if author empty
      // (downstream digest reads "in {group}" from a separate column when set)
    };
    // We don't have a "group_name" column on engagement_candidates; encode it
    // in post_url already (the URL includes /groups/<slug>/) and let the
    // digest cron parse it. Author goes in author_handle.

    const stored = await upsertCandidate(row);
    if (stored) {
      inserted++;
      console.log(`  + score=${score} author="${author.slice(0, 40)}" url=${postUrl.slice(0, 80)}`);
    }
  }

  return { found: posts.length, inserted };
}

async function main() {
  const scannerRunId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  console.log(`\n=== sage-fb-comment-scanner ===`);
  console.log(`run_id: ${scannerRunId}`);
  console.log(`started: ${startedAt}`);
  console.log(`targets: ${TARGETS.length}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  let totalFound = 0;
  let totalInserted = 0;
  const perTarget = [];

  for (const target of TARGETS) {
    try {
      const { found, inserted } = await scanOne(page, target, scannerRunId);
      totalFound += found;
      totalInserted += inserted;
      perTarget.push({ name: target.name, found, inserted });
    } catch (e) {
      console.log(`  target threw: ${e.message}`);
      perTarget.push({ name: target.name, found: 0, inserted: 0, error: e.message });
    }
  }

  await browser.close();

  console.log(`\n=== summary ===`);
  console.log(`run_id: ${scannerRunId}`);
  console.log(`groups scanned: ${TARGETS.length}`);
  console.log(`post chunks parsed: ${totalFound}`);
  console.log(`candidates inserted/updated: ${totalInserted}`);
  console.log(`finished: ${new Date().toISOString()}`);

  // No-quitting rule: zero candidates is a successful no-op, not an error.
  // Only exit non-zero if the entire scan blew up (caught above).
  process.exit(0);
}

// ─── Minimal .env.local loader (no deps) ─────────────────────────────────────

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

main().catch(e => {
  console.error('scanner crashed:', e);
  process.exit(1);
});
