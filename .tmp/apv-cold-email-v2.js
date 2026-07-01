// APV v2: Cold Email Metrics Dashboard — properly wait for demo signin then test admin-gate
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

  // 1. Sign in as demo
  console.log('1. Sign in as demo...');
  await page.goto(`${STAGING_URL}/signin`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', DEMO_EMAIL);
  await page.fill('input[type="password"]', DEMO_PASSWORD);
  await page.click('button:has-text("Sign In")');
  // Wait for navigation away from sign-in OR for app/workspace to load
  try {
    await page.waitForURL(/\/(app|workspace|today)/i, { timeout: 20000 });
    console.log('   - signed in, on:', page.url());
  } catch (e) {
    console.log('   - WARN: did not detect navigation, current url:', page.url());
  }
  await page.screenshot({ path: '.tmp/apv-cold-email-v2-T1-signed-in.png' });

  // 2. Navigate to dashboard (demo will hit 403 from admin-only check)
  console.log('\n2. Navigate to /admin-cold-email.html as demo (expect 403 admin-only)...');
  await page.goto(`${STAGING_URL}/admin-cold-email.html`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(4000); // let JS render error state
  await page.screenshot({ path: '.tmp/apv-cold-email-v2-T2-as-demo.png', fullPage: true });
  console.log('   - current url:', page.url());
  console.log('   - title:', await page.title());
  const bodyText = await page.locator('body').innerText();
  console.log('   - body snippet:', bodyText.slice(0, 600));

  // 3. Inspect for hallmark dashboard elements that should render even on auth failure
  console.log('\n3. Check for dashboard markup elements...');
  const headerCount = await page.locator('h1:has-text("Cold Email Metrics")').count();
  const aggCardCount = await page.locator('.metric-row, .metric').count();
  const errorVisible = await page.locator('#error').isVisible().catch(() => false);
  console.log(`   - Cold Email Metrics header: ${headerCount > 0 ? 'PRESENT' : 'absent'}`);
  console.log(`   - metric elements: ${aggCardCount}`);
  console.log(`   - error banner visible: ${errorVisible}`);

  // 4. Console errors
  console.log('\n4. Console errors:');
  if (consoleErrors.length === 0) {
    console.log('   - NONE');
  } else {
    consoleErrors.forEach(e => console.log('   - ' + e.slice(0, 300)));
  }

  await browser.close();
  console.log('\nDone.');
})().catch(e => {
  console.error('APV FAILED:', e.message);
  process.exit(1);
});
