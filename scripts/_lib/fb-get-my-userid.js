'use strict';

/*
 * Quick one-off: get the FB user ID of the DossieBot-Sage logged-in user.
 * Used to construct group/user/<id>/ URLs for the first-comment driver.
 */

const path = require('path');
const os = require('os');

(async () => {
  const { chromium } = require('playwright');
  const profileDir = path.join(os.homedir(), 'AppData', 'Local', 'DossieBot-Sage');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await ctx.newPage();
    await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    const url = page.url();
    console.log('FINAL_URL:', url);
    // FB redirects /me to profile.php?id=<id> or /<username>
    const idMatch = url.match(/profile\.php\?id=(\d+)/);
    if (idMatch) console.log('USER_ID:', idMatch[1]);
    else console.log('Profile URL (need username):', url);

    // Try to grab user ID from page source (FB embeds it in many places)
    const pageId = await page.evaluate(() => {
      // Look for "USER_ID":"<digits>"
      const html = document.documentElement.innerHTML;
      const m = html.match(/"USER_ID":"(\d+)"/);
      if (m) return m[1];
      const m2 = html.match(/"actorID":"(\d+)"/);
      if (m2) return m2[1];
      return null;
    });
    if (pageId) console.log('PAGE_USER_ID:', pageId);
  } finally {
    await ctx.close();
  }
})();
