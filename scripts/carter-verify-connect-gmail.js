'use strict';

const { chromium } = require('playwright');

const BASE = process.argv[2] || 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app';
const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const OUT = '/tmp/claude-1000/-mnt-c-Users-Heath-Projects-MeetDossie/cfa4d869-fe7b-4066-8212-1d7d43963f46/scratchpad';

async function main() {
  if (!DEMO_PASSWORD) { console.error('DEMO_PASSWORD not set'); process.exit(1); }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  // Intercept the google-oauth-init call so we can confirm it fires + returns
  // a real Google consent URL, without actually navigating off-site into
  // Google's automation-blocked consent flow.
  let oauthInitResponse = null;
  page.on('response', async (res) => {
    if (res.url().includes('/api/google-oauth-init')) {
      try { oauthInitResponse = { status: res.status(), body: await res.json().catch(() => null) }; } catch (_) {}
    }
  });

  try {
    await page.goto(`${BASE}/app.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await emailInput.fill(DEMO_EMAIL);
      await page.locator('input[type="password"], input[name="password"]').first().fill(DEMO_PASSWORD);
      await page.screenshot({ path: `${OUT}/00-before-submit.png`, fullPage: true }).catch(() => {});
      await page.locator('button:has-text("Sign In"), button[type="submit"]').first().click({ force: true, timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }

    console.log('URL after login attempt:', page.url());
    await page.screenshot({ path: `${OUT}/01-after-login.png`, fullPage: true });

    // Go to Settings.
    const settingsNav = page.getByText('Settings', { exact: false }).first();
    await settingsNav.click({ timeout: 10000 }).catch((e) => console.log('settings click failed:', e.message));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/02-settings.png`, fullPage: true });

    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('has "Connect Gmail" button text:', /Connect Gmail/.test(bodyText));
    console.log('has stale "Gmail connect coming soon" toast copy anywhere:', /Gmail connect coming soon/.test(bodyText));
    console.log('Reply Monitoring section present:', /Reply Monitoring/.test(bodyText));

    // Click Connect Gmail (demo account is NOT connected -> should hit the
    // real /api/google-oauth-init endpoint and redirect toward Google).
    const connectBtn = page.getByRole('button', { name: /Connect Gmail/i }).first();
    const visible = await connectBtn.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('Connect Gmail button visible:', visible);
    if (visible) {
      await Promise.race([
        connectBtn.click(),
        page.waitForTimeout(500),
      ]);
      await page.waitForTimeout(2000);
      console.log('oauth-init network response:', JSON.stringify(oauthInitResponse));
      console.log('page url after click (should be accounts.google.com if redirect fired):', page.url());
    }

    await page.screenshot({ path: `${OUT}/03-after-click.png`, fullPage: true });

  } catch (err) {
    console.error('ERROR:', err.message);
    await page.screenshot({ path: `${OUT}/ERROR.png`, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
}

main();
