// One-off Playwright verification: confirm self-serve "Cancel Subscription"
// control (Settings) renders and opens the confirm/survey flow on production.
// Ticket 503a1d1b-3c49-4a25-abe1-27eb94afd62f (Amanda Nuckles — "How do I
// cancel my account?"). Fix already shipped to main (commits b578037b,
// 978bddfa, 866197c5, 6787d410) before this task reached the queue — this
// script just proves it's actually live and clickable from a signed-in
// session, not just present in the code.
//
// Usage: node scripts/carter-cancel-sub-verify.js
const fs = require('fs');
const path = require('path');
(function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = { steps: [] };

  try {
    await page.goto('https://meetdossie.com/app', { waitUntil: 'networkidle', timeout: 30000 });
    results.steps.push('loaded /app');

    // Sign in with documented demo account (docs/CUSTOMERS.md)
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ timeout: 15000 });
    await emailInput.fill('demo@meetdossie.com');
    await page.locator('input[type="password"]').first().fill(process.env.DEMO_PASSWORD);
    await page.getByRole('button', { name: /sign in|log in/i }).first().click();
    await page.waitForTimeout(4000);
    results.steps.push('submitted demo login');

    await page.screenshot({ path: 'scripts/.carter-cancel-sub-after-login.png', fullPage: true }).catch(() => {});
    results.urlAfterLogin = page.url();

    // Navigate to Settings
    const settingsNav = page.getByText(/Settings/i).first();
    await settingsNav.click({ timeout: 15000 });
    await page.waitForTimeout(2000);
    results.steps.push('opened Settings');

    // Find Cancel Subscription button
    const cancelBtn = page.getByRole('button', { name: /Cancel Subscription/i }).first();
    await cancelBtn.waitFor({ timeout: 15000 });
    results.cancelButtonVisible = await cancelBtn.isVisible();
    results.steps.push('Cancel Subscription button visible: ' + results.cancelButtonVisible);

    await cancelBtn.click();
    await page.waitForTimeout(1000);
    const confirmText = await page.getByText(/keep full access until the end of your current billing period/i).first().isVisible().catch(() => false);
    results.confirmStepVisible = confirmText;
    results.steps.push('confirm step visible: ' + confirmText);

    results.ok = results.cancelButtonVisible && results.confirmStepVisible;
  } catch (err) {
    results.error = err && err.message;
    results.ok = false;
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.ok ? 0 : 1);
})();
