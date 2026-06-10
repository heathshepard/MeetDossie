'use strict';

// Mobile FB scrape — m.facebook.com is more permissive for logged-out users.
// Tries to pull recent posts from Texas RE Pages that are blocked on desktop.

const path = require('path');
const fs = require('fs');

const TARGETS = [
  { name: 'Texas REALTORS', url: 'https://m.facebook.com/TexasRealtors/posts/' },
  { name: 'Texas REALTORS (root)', url: 'https://m.facebook.com/TexasRealtors/' },
  { name: 'San Antonio Board of Realtors', url: 'https://m.facebook.com/sanantoniorealtors/' },
  { name: 'Houston Association of Realtors', url: 'https://m.facebook.com/HoustonAOR/' },
  { name: 'TREC - Texas Real Estate Commission', url: 'https://m.facebook.com/TexasRealEstateCommission/' },
  { name: 'MetroTex Association of REALTORS', url: 'https://m.facebook.com/MetroTexREALTORS/' },
  { name: 'Austin Board of REALTORS', url: 'https://m.facebook.com/AustinABoR/' },
  { name: 'Greater Fort Worth Association of REALTORS', url: 'https://m.facebook.com/GreaterFortWorthRealtors/' },
];

const OUT = path.join(__dirname, '.sage-fb-mobile.json');

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  const all = [];
  for (const t of TARGETS) {
    console.log(`[mobile] ${t.name}`);
    try {
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Mobile FB often has a banner asking to install app — dismiss
      try {
        const closeBtn = page.locator('[aria-label="Close"]').first();
        if (await closeBtn.isVisible({ timeout: 1200 })) {
          await closeBtn.click().catch(() => {});
          await page.waitForTimeout(600);
        }
      } catch {}

      // Scroll
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(1500);
      }

      // Mobile uses different selectors — try article + story_body_container + various
      const posts = await page.evaluate(() => {
        const out = [];

        const selectors = [
          'article',
          'div[role="article"]',
          'div[data-ft]',
          'div._55wo',
          'div._5pcr',  // mobile story containers
          'div[data-sigil="story-popup-metadata"]',
        ];
        const seen = new Set();
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          for (const el of els) {
            const text = (el.innerText || '').trim();
            if (text.length < 60) continue;
            if (seen.has(text.slice(0, 100))) continue;
            seen.add(text.slice(0, 100));

            let permalink = null;
            const a = el.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/story.php"], a[href*="/videos/"]');
            if (a) {
              const href = a.getAttribute('href') || '';
              permalink = href.startsWith('http') ? href : `https://m.facebook.com${href}`;
            }
            out.push({ text: text.slice(0, 2500), url: permalink });
          }
        }
        return out;
      });

      console.log(`  captured ${posts.length}`);
      for (const p of posts) all.push({ source: t.name, ...p });
    } catch (e) {
      console.warn(`  fail: ${e.message}`);
    }
  }

  // Dedupe by text prefix
  const seen = new Set();
  const unique = [];
  for (const p of all) {
    const k = p.text.slice(0, 100);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }

  fs.writeFileSync(OUT, JSON.stringify(unique, null, 2));
  console.log(`\nUnique: ${unique.length}`);
  unique.slice(0, 20).forEach((p, i) => {
    console.log(`\n--- #${i+1} src=${p.source} len=${p.text.length} ---`);
    console.log(`URL: ${p.url || '(no url)'}`);
    console.log(p.text.slice(0, 700));
  });

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
