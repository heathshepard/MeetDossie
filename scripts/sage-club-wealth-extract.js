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

  await page.goto('https://m.facebook.com/groups/ClubWealth/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(4000);

  // Dump ALL anchor hrefs
  const allLinks = await page.evaluate(() => {
    const out = [];
    const anchors = document.querySelectorAll('a[href]');
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const text = (a.innerText || '').trim();
      out.push({ href, text: text.slice(0, 80) });
    }
    return out;
  });

  console.log('All anchors:', allLinks.length);
  console.log('\nFB-related hrefs:');
  const fbLinks = allLinks.filter(l => l.href.includes('facebook.com') || l.href.startsWith('/'));
  for (const l of fbLinks.slice(0, 50)) {
    console.log(`  [${l.href.slice(0, 120)}]  "${l.text}"`);
  }

  // Save HTML for inspection
  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, '.club-wealth.html'), html.slice(0, 300000));
  console.log('\nHTML saved.');

  // Also try the alt URL — desktop redirect to mobile auto-trigger
  console.log('\n--- Trying desktop URL on mobile UA ---');
  await page.goto('https://www.facebook.com/groups/ClubWealth/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(3000);
  console.log('post-redirect URL:', page.url());
  const bodyLen2 = (await page.locator('body').innerText().catch(() => '')).length;
  console.log('body len:', bodyLen2);

  await browser.close();
})();
