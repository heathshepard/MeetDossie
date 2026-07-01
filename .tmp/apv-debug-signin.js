const { chromium } = require('playwright');
const STAGING_URL = 'https://meet-dossie-kdcqbng1w-heathshepard-6590s-projects.vercel.app';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const networkLog = [];
  page.on('response', r => {
    if (r.url().includes('supabase') || r.url().includes('/auth/')) {
      networkLog.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`);
    }
  });
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });

  await page.goto(`${STAGING_URL}/signin`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', 'demo@meetdossie.com');
  await page.fill('input[type="password"]', 'DossieDemo-VaIiAt6Bab');
  await page.click('button:has-text("Sign In")');
  await page.waitForTimeout(8000);

  console.log('URL after click:', page.url());
  console.log('Page body excerpt:');
  console.log((await page.locator('body').innerText()).slice(0, 800));
  console.log('\nNetwork:');
  networkLog.forEach(l => console.log('  ' + l));
  console.log('\nLocalStorage keys:', await page.evaluate(() => Object.keys(localStorage)));
  await page.screenshot({ path: '.tmp/apv-debug-signin.png' });
  await browser.close();
})();
