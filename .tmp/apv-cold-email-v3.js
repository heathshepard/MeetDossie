// APV v3: Inspect localStorage shape after demo signin + verify auth gate
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

  console.log('1. Sign in as demo...');
  await page.goto(`${STAGING_URL}/signin`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', DEMO_EMAIL);
  await page.fill('input[type="password"]', DEMO_PASSWORD);
  await page.click('button:has-text("Sign In")');
  // Wait for either URL change or for localStorage to have the auth token
  await page.waitForFunction(() => {
    return Object.keys(localStorage).some(k => k.includes('auth-token'));
  }, { timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('   - signed in, on:', page.url());

  // Inspect localStorage keys
  console.log('\n2. Inspect localStorage keys...');
  const lsKeys = await page.evaluate(() => Object.keys(localStorage));
  console.log('   - keys:', JSON.stringify(lsKeys, null, 2));

  const expectedKey = 'sb-pgwoitbdiyubjugwufhk-auth-token';
  const raw = await page.evaluate((k) => localStorage.getItem(k), expectedKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      console.log('   - parsed top-level keys:', Object.keys(parsed));
      console.log('   - .access_token present:', !!parsed.access_token);
      console.log('   - .access_token preview:', parsed.access_token ? parsed.access_token.slice(0, 40) + '...' : 'NONE');
      console.log('   - parsed.user.email:', parsed.user ? parsed.user.email : 'no user');

      // Manually call the metrics endpoint with this token
      console.log('\n3. Call /api/cold-email-metrics directly with demo token...');
      const metricsRes = await page.evaluate(async (token) => {
        const r = await fetch('/api/cold-email-metrics', {
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
        });
        const text = await r.text();
        return { status: r.status, body: text.slice(0, 300) };
      }, parsed.access_token);
      console.log('   - status:', metricsRes.status);
      console.log('   - body:', metricsRes.body);

    } catch (e) {
      console.log('   - parse error:', e.message);
      console.log('   - raw preview:', raw.slice(0, 200));
    }
  } else {
    console.log('   - KEY MISSING — token not in expected localStorage key');
    // Try other keys
    for (const k of lsKeys) {
      const v = await page.evaluate((kk) => localStorage.getItem(kk), k);
      if (v && v.includes('access_token')) {
        console.log(`   - found access_token in key: ${k}`);
        console.log('   - preview:', v.slice(0, 200));
      }
    }
  }

  // Now navigate to admin-cold-email and see what happens
  console.log('\n4. Navigate to /admin-cold-email.html...');
  await page.goto(`${STAGING_URL}/admin-cold-email.html`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: '.tmp/apv-cold-email-v3-T4-dashboard.png', fullPage: true });
  console.log('   - final url:', page.url());
  console.log('   - title:', await page.title());
  const headerExists = await page.locator('h1:has-text("Cold Email Metrics")').count();
  const loadingVisible = await page.locator('#loading').isVisible().catch(() => false);
  const errorVisible = await page.locator('#error').isVisible().catch(() => false);
  const dashboardVisible = await page.locator('#dashboard').isVisible().catch(() => false);
  console.log(`   - h1 header: ${headerExists > 0 ? 'PRESENT' : 'absent'}`);
  console.log(`   - #loading visible: ${loadingVisible}`);
  console.log(`   - #error visible: ${errorVisible}`);
  console.log(`   - #dashboard visible: ${dashboardVisible}`);
  if (errorVisible) {
    const errorText = await page.locator('#error').innerText();
    console.log('   - error text:', errorText);
  }

  console.log('\n5. Console errors:');
  if (consoleErrors.length === 0) console.log('   - NONE');
  else consoleErrors.forEach(e => console.log('   - ' + e.slice(0, 300)));

  await browser.close();
})().catch(e => {
  console.error('APV FAILED:', e.message);
  process.exit(1);
});
