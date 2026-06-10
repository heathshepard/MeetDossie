const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });
  const page = await ctx.newPage();
  await page.goto('https://m.facebook.com/TexasRealtors/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Dump all anchor hrefs that look like FB post permalinks
  const anchors = await page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll('a[href]');
    for (const a of els) {
      const href = a.getAttribute('href') || '';
      const text = (a.innerText || '').trim();
      if (
        href.includes('/posts/') ||
        href.includes('story_fbid') ||
        href.includes('/story.php') ||
        href.includes('/permalink/') ||
        href.includes('/photos/') ||
        href.includes('/videos/') ||
        href.match(/^\?__cft__/) ||
        /\/TexasRealtors\/[a-z]/.test(href)
      ) {
        out.push({ href, text: text.slice(0, 100) });
      }
    }
    return out;
  });

  console.log('Anchors found:', anchors.length);
  const seen = new Set();
  for (const a of anchors) {
    if (seen.has(a.href)) continue;
    seen.add(a.href);
    console.log(`  [${a.href}]  text="${a.text}"`);
  }

  // Also dump permalinks for each "story" cluster by walking from time-stamp elements
  console.log('\n--- Time anchors ---');
  const timeLinks = await page.evaluate(() => {
    const out = [];
    // Look for spans/abbr near "h" / "d" timestamps
    const all = document.querySelectorAll('a');
    for (const a of all) {
      const text = (a.innerText || '').trim();
      const href = a.getAttribute('href') || '';
      // Mobile FB timestamps are short text like "1h", "5h", "1d"
      if (/^(\d+)(h|m|d|w|y)$/.test(text)) {
        out.push({ text, href });
      }
    }
    return out;
  });
  for (const t of timeLinks) console.log(`  ${t.text} -> ${t.href}`);

  await browser.close();
})();
