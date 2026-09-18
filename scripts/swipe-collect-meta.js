'use strict';

// scripts/swipe-collect-meta.js
//
// Swipe-file collector #1 — Meta Ad Library (facebook.com/ads/library).
//
// VERIFIED WORKING 2026-09-18: a live run against "transaction coordinator"
// returned real, currently-running US ads with advertiser name, full body
// copy, and Meta's own "Started running on <date>" line. That start date is
// the whole point of this source — Meta publishes no impressions or spend for
// commercial ads, so RUN LENGTH is the only honest performance signal here,
// and it is a good one: nobody keeps paying to run a loser.
//
// WHY NOT THE OFFICIAL API: the Graph ads_archive endpoint needs a Meta
// developer app plus identity confirmation (1-2 weeks), and per Meta's own
// reference, "ads that did not reach any location in the EU will only return
// if they are about social issues, elections or politics." Our three markets
// are US commercial advertisers. The API would return nothing for them. The
// public web surface is the only route that covers our markets. See
// docs/SWIPE-FILE-PIPELINE.md for the full access/terms writeup.
//
// REUSES scripts/ad-library-scraper.js's parseAdsFromBodyText() — the tested
// "split on the stable 'Library ID:' marker" parser, rather than fragile CSS
// selectors against Meta's obfuscated class names. This script adds the
// per-market term lists, CTA capture, creative-type detection, longevity
// maths, and the Supabase write that the older script doesn't do.
//
// USAGE
//   node scripts/swipe-collect-meta.js                 # all three markets
//   node scripts/swipe-collect-meta.js --market tc_saas
//   node scripts/swipe-collect-meta.js --dry-run       # parse + print, no writes
//   node scripts/swipe-collect-meta.js --limit 10      # cap ads analysed
//   node scripts/swipe-collect-meta.js --keep-unknown  # keep cards that matched no market
//
// SCHEDULING: not a Vercel cron (Vercel is at 99/100 and this needs a real
// browser). api/cron-competitor-scan-weekly.js enqueues a `swipe_collect`
// agent_queue task every Monday; scripts/agent-queue-poller.js on Heath's PC
// picks it up and runs this file. Same handoff the competitor scan already uses.

const path = require('path');
const { loadEnvLocal } = require('./_lib/load-env-local');
loadEnvLocal(path.join(__dirname, '..'));

const { parseAdsFromBodyText } = require('./ad-library-scraper');
const { classifyMarket, ingestOne } = require('./_lib/swipe-store');

// ─── Search terms per market ────────────────────────────────────────────────
// Meta's keyword search is loose and unordered, so these are intentionally
// plain-language: whoever is paying to run against this phrase right now.

const MARKET_TERMS = {
  tx_real_estate: [
    'realtor san antonio',
    'sell your home fast texas',
    'texas real estate agent',
    'list your home',
    'free home valuation',
  ],
  tc_saas: [
    'transaction coordinator',
    'real estate transaction software',
    'contract to close',
    'real estate compliance software',
    'TREC forms',
  ],
  fitness_ai: [
    'ai fitness coach',
    'personal trainer app',
    'strength training app',
    'ai workout plan',
  ],
};

const CTA_MARKERS = [
  'Learn more', 'Shop now', 'Sign up', 'Get Started', 'Get started',
  'Apply now', 'Book now', 'Contact us', 'Download', 'Send message',
  'Get offer', 'Subscribe', 'Watch more', 'See menu', 'Get quote',
];

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { market: null, dryRun: false, limit: 40, headful: false, keepUnknown: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--market' && a[i + 1]) { out.market = a[++i]; continue; }
    if (a[i] === '--dry-run') { out.dryRun = true; continue; }
    if (a[i] === '--headful') { out.headful = true; continue; }
    if (a[i] === '--keep-unknown') { out.keepUnknown = true; continue; }
    if (a[i] === '--limit' && a[i + 1]) { out.limit = parseInt(a[++i], 10) || 40; continue; }
  }
  return out;
}

// Meta prints "Started running on Mar 14, 2025" (and sometimes a date range).
// Returns an ISO date string or null. Never guesses — an unparseable line
// yields null, which downstream scores as "run length unknown" rather than
// inventing a start.
function parseStartedRunning(s) {
  if (!s) return null;
  const m = s.match(/([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mo = months[m[1]];
  if (mo === undefined) return null;
  const d = new Date(Date.UTC(Number(m[3]), mo, Number(m[2])));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function daysSince(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(`${iso}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// Pull the fields the base parser drops: the CTA button label and whether the
// card rendered a video player.
function enrichFromChunk(bodyText, libraryId) {
  const marker = `Library ID: ${libraryId}`;
  const start = bodyText.indexOf(marker);
  if (start < 0) return { cta: null, creativeType: 'unknown' };
  const next = bodyText.indexOf('Library ID: ', start + marker.length);
  const chunk = bodyText.slice(start, next < 0 ? bodyText.length : next);

  let cta = null;
  for (const c of CTA_MARKERS) {
    if (new RegExp(`\\n${c}\\b`).test(chunk)) { cta = c; break; }
  }
  const creativeType = /\n0:00 \//.test(chunk) ? 'video' : 'image';
  return { cta, creativeType };
}

function firstLine(text) {
  if (!text) return null;
  const line = String(text).split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

async function scrapeTerm(page, term) {
  const url = 'https://www.facebook.com/ads/library/'
    + `?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(term)}`
    + '&search_type=keyword_unordered&media_type=all';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(1500);
  }
  const bodyText = await page.evaluate(() => document.body.innerText);
  const ads = parseAdsFromBodyText(bodyText);
  return ads.map((ad) => {
    const extra = enrichFromChunk(bodyText, ad.libraryId);
    return { ...ad, ...extra, searchTerm: term };
  });
}

async function main() {
  const args = parseArgs();
  const markets = args.market ? [args.market] : Object.keys(MARKET_TERMS);
  for (const m of markets) {
    if (!MARKET_TERMS[m]) {
      console.error(`[swipe-meta] unknown market "${m}". Known: ${Object.keys(MARKET_TERMS).join(', ')}`);
      process.exit(1);
    }
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: !args.headful });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  const byId = new Map();
  try {
    for (const market of markets) {
      for (const term of MARKET_TERMS[market]) {
        const ads = await scrapeTerm(page, term).catch((err) => {
          console.warn(`[swipe-meta] "${term}" failed: ${err.message}`);
          return [];
        });
        console.log(`[swipe-meta] ${market} / "${term}": ${ads.length} card(s)`);
        for (const ad of ads) {
          if (!byId.has(ad.libraryId)) byId.set(ad.libraryId, { ...ad, searchMarket: market });
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  } finally {
    await browser.close();
  }

  const all = [...byId.values()];
  console.log(`[swipe-meta] ${all.length} unique ad(s) collected`);

  // Classify on the AD's OWN text, never on the search term that surfaced it.
  // Meta's keyword search is loose and unordered — a run for "contract to
  // close" returns fight-gym and annuity ads. Inheriting the search term's
  // market would file those as real TC/SaaS signal and quietly poison the
  // digest. An ad that doesn't classify on its own content is 'unknown' and,
  // by default, dropped. (Verified 2026-09-18: 124 raw cards for tc_saas
  // included Ventus Therapy, Dan Lok and an annuity pitch.)
  const classified = all.map((ad) => {
    const startedOn = parseStartedRunning(ad.startedRunning);
    return {
      ...ad,
      startedOn,
      days: daysSince(startedOn),
      market: classifyMarket(ad.adBody, ad.advertiser),
    };
  });

  const offTopic = classified.filter((a) => a.market === 'unknown');
  const onTopic = args.keepUnknown ? classified : classified.filter((a) => a.market !== 'unknown');
  if (offTopic.length) {
    console.log(`[swipe-meta] dropped ${offTopic.length} off-topic card(s) that matched no market on their own copy`
      + `${args.keepUnknown ? ' (kept anyway: --keep-unknown)' : ''}`);
  }

  // Collapse near-identical variants of the same ad. Advertisers run the same
  // creative under many Library IDs; keeping them all would make one
  // advertiser look like a trend. Keep the longest-running of each group —
  // that's the one with the strongest evidence behind it.
  const variants = new Map();
  for (const ad of onTopic) {
    const key = `${(ad.advertiser || '').toLowerCase()}::`
      + String(ad.adBody || '').replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase();
    const prev = variants.get(key);
    if (!prev || (ad.days ?? -1) > (prev.days ?? -1)) variants.set(key, ad);
  }
  const deduped = [...variants.values()];
  if (deduped.length !== onTopic.length) {
    console.log(`[swipe-meta] collapsed ${onTopic.length - deduped.length} near-duplicate variant(s)`);
  }

  // Longest-running first — that's the strongest evidence we have, so if we
  // hit --limit we spend the analysis budget on the best candidates.
  const ranked = deduped
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1))
    .slice(0, args.limit);

  let stored = 0; let analysed = 0; let skipped = 0;
  for (const ad of ranked) {
    const market = ad.market;

    const row = {
      source: 'meta_ad_library',
      source_ref: ad.libraryId,
      market,
      advertiser: ad.advertiser,
      creative_type: ad.creativeType || 'unknown',
      hook_text: firstLine(ad.adBody),
      full_copy: ad.adBody,
      cta_text: ad.cta,
      link: `https://www.facebook.com/ads/library/?id=${ad.libraryId}`,
      run_started_on: ad.startedOn,
      still_active: true, // we only query active_status=active
      evidence: ad.days === null
        ? { kind: 'none' }
        : { kind: 'ad_longevity', days_running: ad.days, as_of: new Date().toISOString().slice(0, 10) },
      evidence_kind: ad.days === null ? 'none' : 'ad_longevity',
      raw: { search_term: ad.searchTerm, started_running_raw: ad.startedRunning },
    };

    if (args.dryRun) {
      console.log(`  [dry] ${market} · ${ad.advertiser} · ${ad.days ?? '?'}d · ${row.cta_text || 'no CTA'} · ${String(row.hook_text).slice(0, 80)}`);
      continue;
    }

    const res = await ingestOne(row);
    if (!res.ok) { console.warn(`  ! ${ad.libraryId}: ${JSON.stringify(res.error).slice(0, 200)}`); continue; }
    stored++;
    if (res.skipped) skipped++;
    if (res.analysed) analysed++;
    console.log(`  ok ${market} · ${ad.advertiser} · ${ad.days ?? '?'}d`
      + `${res.analysed ? ` · score ${res.evidence_score}` : res.skipped ? ' · already analysed' : ''}`);
  }

  console.log(`[swipe-meta] done. stored=${stored} newly_analysed=${analysed} already_had_pattern=${skipped}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[swipe-meta] fatal:', err && err.message);
    process.exit(1);
  });
}

module.exports = { parseStartedRunning, daysSince, enrichFromChunk, MARKET_TERMS };
