'use strict';

// Deep scan on Ginger Unger's posts (public). Captures larger pages
// and unwraps "See more" expansions so we get full post bodies.

const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '.sage-ginger-deep.json');

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1500 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  // Try multiple Ginger surfaces
  const urls = [
    'https://www.facebook.com/gingerungerinstructor/',
    'https://www.facebook.com/gingerungerinstructor/posts',
    'https://www.facebook.com/gingerungerinstructor/about',
  ];

  const all = [];
  for (const url of urls) {
    console.log(`[deep] ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await page.waitForTimeout(3000);

      // Close login popup if it appears
      try {
        const closeBtn = page.locator('div[aria-label="Close"]').first();
        if (await closeBtn.isVisible({ timeout: 1500 })) {
          await closeBtn.click().catch(() => {});
          await page.waitForTimeout(800);
        }
      } catch {}

      // Scroll harder
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(1800);
      }

      // Click all "See more" expansions
      const seeMoreClicks = await page.evaluate(() => {
        let n = 0;
        const links = document.querySelectorAll('div[role="button"]');
        for (const el of links) {
          const t = (el.innerText || '').trim().toLowerCase();
          if (t === 'see more' || t === '… see more') {
            el.click();
            n++;
          }
        }
        return n;
      });
      console.log(`  clicked ${seeMoreClicks} "See more"`);
      await page.waitForTimeout(1500);

      const posts = await page.evaluate(() => {
        const out = [];
        const articles = document.querySelectorAll('div[role="article"]');
        for (const a of articles) {
          const text = (a.innerText || '').trim();
          if (text.length < 60) continue;
          let permalink = null;
          const links = a.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/videos/"]');
          for (const link of links) {
            const href = link.getAttribute('href');
            if (href) {
              permalink = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
              break;
            }
          }
          out.push({ text: text.slice(0, 2500), permalink });
        }
        return out;
      });
      for (const p of posts) all.push({ source: url, ...p });
      console.log(`  captured ${posts.length}`);
    } catch (e) {
      console.warn(`  fail ${e.message}`);
    }
  }

  // Dedupe by first 100 chars of text
  const seen = new Set();
  const unique = [];
  for (const p of all) {
    const k = p.text.slice(0, 100);
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }

  fs.writeFileSync(OUT, JSON.stringify(unique, null, 2));
  console.log(`\nTotal unique: ${unique.length}`);
  unique.slice(0, 15).forEach((p, i) => {
    console.log(`\n--- #${i+1} len=${p.text.length} ---`);
    console.log(`URL: ${p.permalink || '(no url)'}`);
    console.log(p.text.slice(0, 800));
  });

  await browser.close();
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
