// APV: Cold Email Metrics Dashboard on staging
// Verifies page loads, JS executes, auth gate behaves correctly with demo creds.

const { chromium } = require('playwright');

const STAGING_URL = 'https://meet-dossie-kdcqbng1w-heathshepard-6590s-projects.vercel.app';
const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = 'DossieDemo-VaIiAt6Bab';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push('PAGE-ERROR: ' + err.message));

  console.log('1. Loading dashboard signed-out...');
  await page.goto(`${STAGING_URL}/admin-cold-email.html`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: '.tmp/apv-cold-email-T1-signed-out.png', fullPage: true });
  console.log('   - Title:', await page.title());
  console.log('   - Body text snippet:', (await page.locator('body').innerText()).slice(0, 300));

  console.log('\n2. Signing in as demo via /signin...');
  await page.goto(`${STAGING_URL}/signin`, { waitUntil: 'networkidle', timeout: 30000 });
  // App sign-in page may have email/password fields
  try {
    await page.fill('input[type="email"]', DEMO_EMAIL, { timeout: 8000 });
    await page.fill('input[type="password"]', DEMO_PASSWORD);
    await page.screenshot({ path: '.tmp/apv-cold-email-T2-signin-filled.png' });
    await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (e) {
    console.log('   - Could not auto-fill sign-in:', e.message.slice(0, 200));
  }
  await page.screenshot({ path: '.tmp/apv-cold-email-T3-after-signin.png' });

  console.log('\n3. Loading dashboard as demo (expect 403 admin-only)...');
  await page.goto(`${STAGING_URL}/admin-cold-email.html`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '.tmp/apv-cold-email-T4-as-demo.png', fullPage: true });
  const bodyText = await page.locator('body').innerText();
  console.log('   - Body text snippet:', bodyText.slice(0, 500));

  console.log('\n4. Console errors observed:');
  consoleErrors.forEach(e => console.log('   - ' + e.slice(0, 250)));

  console.log('\nDone. Screenshots in .tmp/apv-cold-email-T*.png');
  await browser.close();
})().catch(e => {
  console.error('APV FAILED:', e.message);
  process.exit(1);
});
