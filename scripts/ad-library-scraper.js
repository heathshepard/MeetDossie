'use strict';

// scripts/ad-library-scraper.js
//
// Pulls real, live competitor/adjacent ad creative from Meta's public Ad
// Library (facebook.com/ads/library) — no login required, no FB session
// needed. Used as content fuel for the persona/brand-voice post generator
// (see api/cron-generate-posts.js): real ad hooks + pain-point language that
// competitors are actively paying to run gives the generation prompt sharper,
// more market-tested angles than guessing in a vacuum.
//
// Same shape as scripts/competitor-monitor.js (scrape -> structured objects
// -> Telegram alert) but sourced from the public Ad Library instead of FB/IG
// pages, and outputs a prompt-injectable "content fuel" block instead of
// (or in addition to) a Telegram post-by-post alert.
//
// Usage:
//   node scripts/ad-library-scraper.js
//   node scripts/ad-library-scraper.js --terms "transaction coordinator,TREC forms"
//
// Env vars (all optional — script runs and prints results with none of them):
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  — best-effort summary alert
//
// Output:
//   scripts/.ad-library-cache.json — latest scrape, keyed by libraryId (deduped)
//   stdout — human-readable summary + one example "content fuel" block

const path = require('path');
const os = require('os');
const fs = require('fs');

// Load .env.local when running locally
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CACHE_FILE = path.join(__dirname, '.ad-library-cache.json');

// Search terms: mix of category terms (surface whoever is actively spending
// money against the TC/paperwork pain point) and named competitors/adjacent
// players from scripts/competitor-monitor.js. Ad Library keyword search is
// loose/unordered — named-brand terms often surface unrelated noise (verified
// 2026-08-17: "DealDock"/"ListedKit"/"Click Contracts" returned zero relevant
// hits, category terms did not). Relevance filtering below handles the noise;
// keep both term types so a new named competitor spending on ads gets caught.
const DEFAULT_SEARCH_TERMS = [
  'transaction coordinator',
  'TREC forms',
  'real estate transaction software',
  'DealDock',
  'ListedKit',
  'Done Deal TC',
  'Click Contracts',
];

// Loose relevance gate — keyword search returns a lot of unrelated ads
// (skincare, timeshare-exit, engine parts). Keep an ad only if its body or
// advertiser name plausibly relates to real estate transactions/paperwork/TC.
const RELEVANCE_PATTERN = new RegExp(
  [
    'real estate', 'realtor', '\\bagent\\b', 'transaction coordinat', '\\btc\\b',
    'trec', 'contract', 'closing', 'listing', 'brokerage', 'buyer', 'seller',
    'escrow', 'paperwork', 'disclosure', 'earnest money', 'title compan',
  ].join('|'),
  'i'
);

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { terms: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--terms' && args[i + 1]) {
      out.terms = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      i++;
    }
  }
  return out;
}

// ─── Ad Library text-based parser ──────────────────────────────────────────
// FB's Ad Library DOM uses obfuscated/unstable class names, so instead of
// CSS selectors this walks document.body.innerText and splits on the one
// stable repeating marker every ad card carries: "Library ID: <digits>".
// Same "structural text pattern, not fragile selectors" approach already
// used in fb-lead-scraper.js (div[role="article"] + innerText).
function parseAdsFromBodyText(bodyText) {
  const ads = [];
  const idRegex = /Library ID:\s*(\d+)/g;
  const idxMatches = [...bodyText.matchAll(idRegex)];
  for (let i = 0; i < idxMatches.length; i++) {
    const start = idxMatches[i].index;
    const end = i + 1 < idxMatches.length ? idxMatches[i + 1].index : bodyText.length;
    const chunk = bodyText.slice(start, end);

    const libraryId = idxMatches[i][1];
    const startedMatch = chunk.match(/Started running on ([^\n]+)/);
    const startedRunning = startedMatch ? startedMatch[1].trim() : null;

    const sponsoredIdx = chunk.indexOf('\nSponsored');
    let advertiser = null;
    let adBody = null;
    if (sponsoredIdx !== -1) {
      const before = chunk.slice(0, sponsoredIdx).split('\n').filter(Boolean);
      advertiser = before[before.length - 1] || null;

      const after = chunk.slice(sponsoredIdx + '\nSponsored'.length);
      const cutMatch = after.match(/\n(0:00 \/|Learn more|Shop now|Sign up|Get Started|Get started|Apply now)/);
      const bodyEnd = cutMatch ? cutMatch.index : Math.min(after.length, 1200);
      adBody = after.slice(0, bodyEnd).trim();
    }

    if (advertiser && adBody) {
      ads.push({ libraryId, advertiser, startedRunning, adBody });
    }
  }
  return ads;
}

function isRelevant(ad) {
  return RELEVANCE_PATTERN.test(ad.adBody || '') || RELEVANCE_PATTERN.test(ad.advertiser || '');
}

// ─── Playwright: scrape one search term ────────────────────────────────────
// Public page, no login/session required — runs against Playwright's bundled
// Chromium (no DossieBot profile dependency, unlike fb-lead-scraper.js).
async function scrapeTerm(page, term) {
  const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(term)}&search_type=keyword_unordered&media_type=all`;
  console.log(`[ad-library-scraper] Searching: "${term}"`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(1500);
  }
  const bodyText = await page.evaluate(() => document.body.innerText);
  const ads = parseAdsFromBodyText(bodyText);
  const relevant = ads.filter(isRelevant).map(ad => ({ ...ad, searchTerm: term }));
  console.log(`[ad-library-scraper]   parsed ${ads.length} ads, ${relevant.length} relevant`);
  return relevant;
}

// ─── Content fuel block ────────────────────────────────────────────────────
// Formats scraped ads for injection into the generation prompt — same shape
// as buildTopPerformerBlock()/buildSageIntelligenceBlock() in
// api/cron-generate-posts.js (a labeled section + bullet examples). Intended
// splice point: buildPrompt() in cron-generate-posts.js, alongside
// topPerformerBlock/sageIntelBlock — NOT wired in today, this proves the
// shape with a real example.
function buildContentFuelBlock(ads, limit = 8) {
  if (!ads || ads.length === 0) return '';
  const lines = [
    '',
    '## COMPETITOR AD LIBRARY INTEL (real, currently-running ads — Meta Ad Library, pulled live)',
    'These are real ads competitors/adjacent players are paying to run right now.',
    'Study the PAIN LANGUAGE and HOOK PATTERNS — do not copy claims or offers, they are',
    'not verified Dossie facts. Use them to calibrate what pain points the market is',
    'already spending money to solve, and where Dossie\'s real shipped features beat',
    'the pitch (Dossie is software the agent uses directly, not a course selling a',
    'side-hustle TC career, and not a generic CRM).',
    '',
  ];
  for (const ad of ads.slice(0, limit)) {
    const snippet = ad.adBody.replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`- [${ad.advertiser}] "${snippet}${ad.adBody.length > 220 ? '...' : ''}"`);
  }
  lines.push('');
  return lines.join('\n');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  }).catch(err => console.warn('[ad-library-scraper] Telegram failed:', err.message));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { terms } = parseArgs();
  const searchTerms = terms && terms.length ? terms : DEFAULT_SEARCH_TERMS;

  const { chromium } = require('playwright');
  console.log('[ad-library-scraper] Launching bundled Chromium (public page, no login/profile needed)');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  const allAds = [];
  try {
    for (const term of searchTerms) {
      const ads = await scrapeTerm(page, term).catch(err => {
        console.warn(`[ad-library-scraper] Error on "${term}":`, err.message);
        return [];
      });
      allAds.push(...ads);
      await new Promise(r => setTimeout(r, 1000));
    }
  } finally {
    await browser.close();
  }

  // Dedupe by libraryId (same ad can surface under multiple search terms)
  const byId = new Map();
  for (const ad of allAds) {
    if (!byId.has(ad.libraryId)) byId.set(ad.libraryId, ad);
  }
  const deduped = [...byId.values()];

  fs.writeFileSync(CACHE_FILE, JSON.stringify({ scrapedAt: new Date().toISOString(), ads: deduped }, null, 2), 'utf8');

  console.log(`\n[ad-library-scraper] Done. ${deduped.length} relevant ad(s) across ${searchTerms.length} search term(s). Cached -> ${CACHE_FILE}`);

  const byAdvertiser = new Map();
  for (const ad of deduped) {
    byAdvertiser.set(ad.advertiser, (byAdvertiser.get(ad.advertiser) || 0) + 1);
  }
  console.log('\nAdvertisers found:');
  for (const [name, count] of [...byAdvertiser.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${name} (${count})`);
  }

  console.log('\n--- CONTENT FUEL BLOCK (would be spliced into cron-generate-posts.js buildPrompt()) ---');
  console.log(buildContentFuelBlock(deduped));

  if (deduped.length) {
    const advertisers = [...byAdvertiser.keys()].slice(0, 5).join(', ');
    await sendTelegram(`Ad Library scrape: ${deduped.length} relevant ads found across ${searchTerms.length} search terms. Advertisers: ${advertisers}`);
  }
}

module.exports = { parseAdsFromBodyText, buildContentFuelBlock, isRelevant };

if (require.main === module) {
  main().catch(err => {
    console.error('[ad-library-scraper] Fatal error:', err.message);
    process.exit(1);
  });
}
