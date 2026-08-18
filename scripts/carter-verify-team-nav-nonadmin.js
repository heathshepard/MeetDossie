'use strict';
// Confirms a non-admin team member does NOT see the Team nav item at all.
// Usage: node carter-verify-team-nav-nonadmin.js <BASE_URL> <email> <password> <shot-prefix>
const { chromium } = require('playwright');

const [, , BASE, EMAIL, PASSWORD, PREFIX] = process.argv;
if (!BASE || !EMAIL || !PASSWORD || !PREFIX) {
  console.error('Usage: node carter-verify-team-nav-nonadmin.js <BASE_URL> <email> <password> <shot-prefix>');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  console.log(`[verify] navigating ${BASE}/app`);
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const pwToggle = page.getByRole('button', { name: 'Password' });
  if (await pwToggle.count()) await pwToggle.click();
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/${PREFIX}-01-after-signin.png`, fullPage: true });

  const teamNavCount = await page.locator('aside.app-sidebar button', { hasText: 'Team' }).count();
  console.log('[verify] Team nav button count in sidebar (expect 0):', teamNavCount);

  const bodyText = await page.locator('aside.app-sidebar').innerText();
  console.log('[verify] sidebar text:', bodyText.replace(/\s+/g, ' '));

  await browser.close();
})();
