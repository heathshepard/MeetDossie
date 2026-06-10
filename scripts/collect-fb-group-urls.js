'use strict';

// scripts/collect-fb-group-urls.js
//
// Playwright script: navigates to facebook.com/groups/ using Heath's existing
// Chrome profile, scrapes all group names + URLs, then matches them against
// the group_registry table and updates any PLACEHOLDER URLs.
//
// Usage:
//   node scripts/collect-fb-group-urls.js
//
// Chrome must NOT be running when this script starts.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CHROME_PROFILE_PATH = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);

// ─── Supabase helpers ─────────────────────────────────────────────────────────

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

async function fetchRegistryRows() {
  const { ok, data } = await supabaseFetch('/rest/v1/group_registry?select=id,group_name,group_url&limit=100');
  if (!ok || !Array.isArray(data)) throw new Error(`Failed to fetch group_registry: ${JSON.stringify(data)}`);
  return data;
}

async function updateGroupUrl(id, url) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_registry?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ group_url: url }),
    }
  );
  if (!ok) throw new Error(`PATCH failed for ${id}: ${JSON.stringify(data)}`);
}

// ─── Fuzzy name matching ───────────────────────────────────────────────────────

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Returns the registry row whose normalized name best matches the scraped name.
// Returns null if no match is close enough.
function findMatch(scrapedName, registryRows) {
  const scraped = normalize(scrapedName);

  // Exact match first
  for (const row of registryRows) {
    if (normalize(row.group_name) === scraped) return row;
  }

  // Substring match: scraped contains registry name or vice versa
  for (const row of registryRows) {
    const reg = normalize(row.group_name);
    if (scraped.includes(reg) || reg.includes(scraped)) return row;
  }

  // Word-overlap: >= 60% of registry words appear in scraped
  for (const row of registryRows) {
    const regWords = normalize(row.group_name).split(' ');
    const scrapedWords = new Set(scraped.split(' '));
    const overlap = regWords.filter(w => scrapedWords.has(w)).length;
    if (overlap / regWords.length >= 0.6) return row;
  }

  return null;
}

// ─── Normalize FB group URL ───────────────────────────────────────────────────

function normalizeGroupUrl(href) {
  if (!href) return null;

  // Make absolute
  let url = href.startsWith('http') ? href : `https://www.facebook.com${href}`;

  // Strip query params and fragments
  url = url.split('?')[0].split('#')[0];

  // Must contain /groups/
  if (!url.includes('/groups/')) return null;

  // Extract group slug or numeric ID
  const match = url.match(/facebook\.com\/groups\/([^/]+)/);
  if (!match) return null;

  return `https://www.facebook.com/groups/${match[1]}/`;
}

// ─── Playwright scraper ───────────────────────────────────────────────────────

async function scrapeGroupUrls() {
  const { chromium } = require('playwright');

  console.log('[collect-fb-group-urls] Launching Chrome...');
  console.log('[collect-fb-group-urls] NOTE: Close all Chrome windows before running.');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();

  try {
    console.log('[collect-fb-group-urls] Navigating to facebook.com/groups/');
    await page.goto('https://www.facebook.com/groups/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Abort if not logged in
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      throw new Error('Facebook redirected to login. Make sure Chrome is logged in as Heath.');
    }

    // Wait for at least one group link to appear
    await page.waitForSelector('a[href*="/groups/"]', { timeout: 15000 });

    // Scroll to load all groups — stop when scroll position stops increasing
    console.log('[collect-fb-group-urls] Scrolling to load all groups...');
    let previousHeight = 0;
    let stableRounds = 0;
    while (stableRounds < 3) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      // Wait for any lazy-loaded content to render
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === previousHeight) {
        stableRounds++;
      } else {
        stableRounds = 0;
        previousHeight = currentHeight;
      }
    }

    console.log('[collect-fb-group-urls] Extracting group links...');

    // Collect all /groups/ links from the page
    const rawLinks = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/groups/"]'));
      return anchors.map(a => ({
        href: a.getAttribute('href'),
        text: (a.innerText || a.textContent || '').trim(),
        ariaLabel: a.getAttribute('aria-label') || '',
      }));
    });

    // Deduplicate by normalized URL and filter to actual group pages
    const seen = new Set();
    const groups = [];

    for (const link of rawLinks) {
      const url = normalizeGroupUrl(link.href);
      if (!url) continue;

      // Skip the generic /groups/ hub page itself and feed sub-pages
      if (url === 'https://www.facebook.com/groups/' || url.match(/\/groups\/(feed|discover|joined|create)\//)) continue;

      if (seen.has(url)) continue;
      seen.add(url);

      // Prefer aria-label as the name, fall back to visible text
      const name = (link.ariaLabel || link.text).replace(/\n+/g, ' ').trim();
      if (!name) continue;

      groups.push({ name, url });
    }

    console.log(`[collect-fb-group-urls] Found ${groups.length} unique group links on page`);
    return groups;
  } finally {
    await context.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[collect-fb-group-urls] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
  }

  const registryRows = await fetchRegistryRows();
  console.log(`[collect-fb-group-urls] Loaded ${registryRows.length} rows from group_registry`);

  const scrapedGroups = await scrapeGroupUrls();

  let updated = 0;
  let alreadyCurrent = 0;
  const unmatched = [];

  for (const { name, url } of scrapedGroups) {
    const row = findMatch(name, registryRows);
    if (!row) {
      unmatched.push({ name, url });
      continue;
    }

    // Skip if the URL is already correct (not a placeholder and matches)
    if (!row.group_url.includes('PLACEHOLDER') && row.group_url === url) {
      alreadyCurrent++;
      continue;
    }

    console.log(`[collect-fb-group-urls] Updating "${row.group_name}" -> ${url}`);
    await updateGroupUrl(row.id, url);
    updated++;
  }

  console.log('\n[collect-fb-group-urls] ─── Summary ──────────────────────────────');
  console.log(`  Updated: ${updated} groups`);
  console.log(`  Already current: ${alreadyCurrent} groups`);
  console.log(`  Unmatched (not in registry): ${unmatched.length}`);

  if (unmatched.length > 0) {
    console.log('\n[collect-fb-group-urls] UNMATCHED groups (not in registry):');
    for (const { name, url } of unmatched) {
      console.log(`  UNMATCHED: ${name} -> ${url}`);
    }
  }

  // Report which registry rows still have PLACEHOLDERs
  const stillPlaceholder = registryRows.filter(r => r.group_url.includes('PLACEHOLDER'));
  if (stillPlaceholder.length > 0) {
    console.log('\n[collect-fb-group-urls] Registry rows still with PLACEHOLDER URLs:');
    for (const row of stillPlaceholder) {
      console.log(`  NEEDS_URL: "${row.group_name}"`);
    }
  }

  console.log('[collect-fb-group-urls] Done.');
}

main().catch((err) => {
  console.error('[collect-fb-group-urls] Fatal error:', err.message);
  process.exit(1);
});
