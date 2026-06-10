const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1500 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await ctx.newPage();

  await page.goto('https://www.facebook.com/TexasRealtors/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(5000);

  // Try closing login overlay
  for (let i = 0; i < 3; i++) {
    try {
      const closeBtn = page.locator('[aria-label="Close"]').first();
      if (await closeBtn.isVisible({ timeout: 1200 })) {
        await closeBtn.click().catch(() => {});
        await page.waitForTimeout(800);
      } else break;
    } catch { break; }
  }
  // Try escape
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(1000);

  // Scroll
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(1500);
  }

  await page.screenshot({ path: path.join(__dirname, '.tx-realtors-desktop.png'), fullPage: false });

  // Try a few selectors for posts
  const data = await page.evaluate(() => {
    const result = { articleCount: 0, anchorsWithPosts: 0, sampleAnchors: [], bodySnippet: '' };
    result.articleCount = document.querySelectorAll('div[role="article"]').length;
    const anchors = document.querySelectorAll('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]');
    result.anchorsWithPosts = anchors.length;
    for (let i = 0; i < Math.min(10, anchors.length); i++) {
      result.sampleAnchors.push({
        href: anchors[i].getAttribute('href'),
        text: (anchors[i].innerText || '').trim().slice(0, 60),
      });
    }
    result.bodySnippet = (document.body.innerText || '').slice(0, 3000);
    return result;
  });

  console.log('articleCount:', data.articleCount);
  console.log('anchorsWithPosts:', data.anchorsWithPosts);
  console.log('sampleAnchors:');
  for (const a of data.sampleAnchors) console.log('  ', a);
  console.log('\nbodySnippet:');
  console.log(data.bodySnippet);

  await browser.close();
})();
