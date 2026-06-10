'use strict';

// scripts/sage-fb-public-scan.js
//
// Public FB content scan — does NOT require login. Targets:
//   - Public Facebook Pages (business pages, professional pages) — visible to logged-out users
//   - Mobile basic interface (mbasic.facebook.com) — sometimes serves content without auth
//
// Strategy: scrape public Texas RE / Texas REALTOR pages and pull recent posts
// with engagement. Public Pages = posts where author chose Page (not personal),
// fully accessible without login.

const path = require('path');
const fs = require('fs');

// Public Texas RE / RE-adjacent Pages
const PUBLIC_PAGES = [
  { name: 'Texas REALTORS', url: 'https://www.facebook.com/TexasRealtors/', priority: 9 },
  { name: 'San Antonio Board of Realtors', url: 'https://www.facebook.com/sanantoniorealtors/', priority: 8 },
  { name: 'Houston Association of Realtors', url: 'https://www.facebook.com/HoustonAOR/', priority: 7 },
  { name: 'MetroTex Association of REALTORS', url: 'https://www.facebook.com/MetroTexREALTORS/', priority: 7 },
  { name: 'Austin Board of REALTORS', url: 'https://www.facebook.com/AustinABoR/', priority: 7 },
  { name: 'TREC - Texas Real Estate Commission', url: 'https://www.facebook.com/TexasRealEstateCommission/', priority: 9 },
  { name: 'Ginger Unger - Real Estate Instructor (page)', url: 'https://www.facebook.com/gingerungerinstructor/', priority: 10 },
];

const RESULTS_FILE = path.join(__dirname, '.sage-fb-public-results.json');

async function scanPage(page, target, allResults) {
  console.log(`[sage-fb-public] Scanning ${target.name}`);
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  } catch (e) {
    console.warn(`[sage-fb-public] nav failed: ${e.message}`);
    return;
  }

  await page.waitForTimeout(4000);

  // Dismiss FB cookie banner / signup prompt
  try {
    const closeBtn = await page.locator('div[aria-label="Close"], div[role="button"][aria-label="Close"]').first();
    if (await closeBtn.isVisible({ timeout: 1500 })) {
      await closeBtn.click().catch(() => {});
      await page.waitForTimeout(800);
    }
  } catch {}

  // Scroll to load posts
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(1800);
  }

  // For public pages, posts are typically in <div data-pagelet="ProfileTimeline">
  // or within div[role="article"]. We also try anchor-based extraction.
  const posts = await page.evaluate(() => {
    const out = [];
    const seen = new Set();

    // Try role=article
    const articles = document.querySelectorAll('div[role="article"]');
    for (const a of articles) {
      const text = (a.innerText || '').trim();
      if (text.length < 60) continue;
      if (seen.has(text.slice(0, 100))) continue;
      seen.add(text.slice(0, 100));

      let permalink = null;
      const links = a.querySelectorAll('a[href*="/posts/"], a[href*="/story.php"], a[href*="/permalink/"], a[href*="/videos/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href) {
          permalink = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
          break;
        }
      }
      out.push({ text: text.slice(0, 1500), permalink });
    }

    return out;
  });

  console.log(`[sage-fb-public] ${target.name}: ${posts.length} posts captured`);

  for (const p of posts) {
    allResults.push({
      page: target.name,
      pagePriority: target.priority,
      text: p.text,
      url: p.permalink,
      length: p.text.length,
    });
  }
}

(async () => {
  const { chromium } = require('playwright');
  // Use fresh Chromium (NOT persistent) so it doesn't collide with Heath's Chrome
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  const allResults = [];
  try {
    for (const target of PUBLIC_PAGES) {
      try {
        await scanPage(page, target, allResults);
      } catch (e) {
        console.warn(`[sage-fb-public] err on ${target.name}: ${e.message}`);
      }
    }
  } finally {
    try { await browser.close(); } catch {}
  }

  // Filter for posts likely from Texas RE professionals / engagement opportunities
  const interesting = allResults.filter(r => {
    const t = r.text.toLowerCase();
    return r.length > 80 && (
      t.includes('agent') || t.includes('realtor') || t.includes('trec') ||
      t.includes('transaction') || t.includes('contract') || t.includes('deal') ||
      t.includes('listing') || t.includes('?') || t.includes('texas') ||
      t.includes('closing') || t.includes('escrow') || t.includes('title')
    );
  });

  // Sort by priority desc, then length desc
  interesting.sort((a, b) => (b.pagePriority - a.pagePriority) || (b.length - a.length));

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
  console.log(`\n[sage-fb-public] Total ${allResults.length} captured, ${interesting.length} interesting.`);
  console.log(`Results: ${RESULTS_FILE}\n`);

  interesting.slice(0, 8).forEach((r, i) => {
    console.log(`--- #${i + 1} page="${r.page}" len=${r.length} ---`);
    console.log(`URL: ${r.url || '(no url)'}`);
    console.log(`Text: ${r.text.slice(0, 500)}`);
    console.log('');
  });
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
