const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });
  const page = await ctx.newPage();
  const target = process.argv[2] || 'https://m.facebook.com/TexasRealtors/';
  console.log('target:', target);
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Scroll
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(1500);
  }

  // Dump the full body and the HTML structure of suspected post containers
  const body = await page.locator('body').innerText();
  console.log('FULL BODY LEN:', body.length);
  fs.writeFileSync(path.join(__dirname, '.tx-realtors-body.txt'), body);

  // Find any anchors with /posts/ or /story.php links — those should mark posts
  const anchors = await page.evaluate(() => {
    const out = [];
    const aS = document.querySelectorAll('a[href]');
    for (const a of aS) {
      const href = a.getAttribute('href') || '';
      if (href.includes('/posts/') || href.includes('story_fbid') || href.includes('/permalink/')) {
        // Walk up to find the enclosing post container
        let container = a;
        for (let depth = 0; depth < 12 && container.parentElement; depth++) {
          container = container.parentElement;
          const t = (container.innerText || '').trim();
          if (t.length > 80 && t.length < 3000) {
            out.push({ href, text: t.slice(0, 1500), depth });
            break;
          }
        }
      }
    }
    return out;
  });
  console.log('\nAnchors with post links:', anchors.length);
  const seen = new Set();
  let n = 0;
  for (const x of anchors) {
    const k = x.text.slice(0, 100);
    if (seen.has(k)) continue;
    seen.add(k);
    n++;
    if (n > 12) break;
    console.log(`\n--- ${n} href=${x.href} depth=${x.depth} ---`);
    console.log(x.text.slice(0, 600));
  }
  await browser.close();
})();
