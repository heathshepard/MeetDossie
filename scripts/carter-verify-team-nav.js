'use strict';
// Real-browser verification of the new in-app Team nav item.
// Usage: node verify-team-nav.js <BASE_URL> <email> <password> <shot-prefix>
const { chromium } = require('playwright');

const [, , BASE, EMAIL, PASSWORD, PREFIX] = process.argv;
if (!BASE || !EMAIL || !PASSWORD || !PREFIX) {
  console.error('Usage: node verify-team-nav.js <BASE_URL> <email> <password> <shot-prefix>');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + String(err && err.message ? err.message : err)));

  console.log(`[verify] navigating ${BASE}/app`);
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Switch to password mode, sign in.
  const pwToggle = page.getByRole('button', { name: 'Password' });
  if (await pwToggle.count()) await pwToggle.click();
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/${PREFIX}-01-after-signin.png`, fullPage: true });

  const teamNav = page.getByRole('button', { name: /^👥\s*Team$/ }).or(page.locator('button', { hasText: 'Team' })).first();
  const teamNavVisible = await page.locator('aside.app-sidebar button', { hasText: 'Team' }).count();
  console.log('[verify] Team nav button count in sidebar:', teamNavVisible);

  if (teamNavVisible > 0) {
    await page.locator('aside.app-sidebar button', { hasText: 'Team' }).first().click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `/tmp/${PREFIX}-02-team-view.png`, fullPage: true });

    // Try clicking a roster member if present.
    const rosterButtons = page.locator('div', { hasText: 'dossier' }).locator('..').locator('button');
    const bodyText = await page.locator('body').innerText();
    console.log('[verify] body text snippet:', bodyText.replace(/\s+/g, ' ').slice(0, 400));

    // Click first roster item by finding buttons that contain "@" (email) text.
    const memberButtons = await page.$$eval('button', (btns) => btns
      .filter((b) => /@meetdossie\.com/.test(b.innerText))
      .map((b) => b.innerText));
    console.log('[verify] roster member buttons found:', memberButtons.length, memberButtons);

    // Click the SECOND roster member (not the already-selected first one) to
    // actually prove switching updates the board.
    const secondMemberBtn = page.locator('button', { hasText: '@meetdossie.com' }).nth(1);
    if (await secondMemberBtn.count()) {
      await secondMemberBtn.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `/tmp/${PREFIX}-03-member-board.png`, fullPage: true });
    }
  }

  console.log('[verify] console/page errors:', consoleErrors.filter(e => !/403|Failed to load resource/i.test(e)));
  await browser.close();
})();
