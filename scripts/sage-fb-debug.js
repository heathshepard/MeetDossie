'use strict';

// Debug version — opens Ginger Unger group, dumps URL, title, body length,
// number of role=article nodes, and saves screenshot + HTML for inspection.

const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.SAGE_PROFILE_NAME || 'Default';

(async () => {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });
  const page = await ctx.newPage();

  console.log('Navigating to home first to confirm session...');
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(4000);
  const homeUrl = page.url();
  const homeTitle = await page.title();
  console.log('home URL:', homeUrl);
  console.log('home title:', homeTitle);

  // Detect login by checking for the password field
  const hasLoginField = await page.locator('input[name="pass"]').count();
  console.log('login pass field count:', hasLoginField);

  // Take screenshot
  await page.screenshot({ path: path.join(__dirname, 'sage-fb-debug-home.png'), fullPage: false });

  console.log('\nNavigating to Ginger group...');
  await page.goto('https://www.facebook.com/groups/gingerungerinstructor/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await page.waitForTimeout(6000);
  const gurl = page.url();
  const gtitle = await page.title();
  console.log('ginger URL:', gurl);
  console.log('ginger title:', gtitle);

  const articleCount = await page.locator('div[role="article"]').count();
  console.log('div[role=article] count:', articleCount);

  // Scroll
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(2000);
  }
  const articleCount2 = await page.locator('div[role="article"]').count();
  console.log('article count after scroll:', articleCount2);

  // Dump first article inner text length
  const sample = await page.evaluate(() => {
    const a = document.querySelectorAll('div[role="article"]');
    return [...a].slice(0, 3).map(el => ({
      len: (el.innerText || '').length,
      preview: (el.innerText || '').slice(0, 200),
    }));
  });
  console.log('sample articles:', JSON.stringify(sample, null, 2));

  await page.screenshot({ path: path.join(__dirname, 'sage-fb-debug-ginger.png'), fullPage: false });

  // Save body html slice
  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, 'sage-fb-debug-ginger.html'), html.slice(0, 200000), 'utf8');

  console.log('Screenshots + html written. Closing in 5s.');
  await page.waitForTimeout(5000);
  await ctx.close();
})().catch(e => { console.error('DEBUG ERR:', e.message); process.exit(1); });
