// Atlas: capture staging Dossie Sign DoD dashboard for Heath ship ping.
// Signs in as demo customer to bypass Vercel SSO if needed, then screenshots the grid.

const { chromium } = require('playwright');

const STAGING = 'https://meet-dossie-6knofr7dn-heathshepard-6590s-projects.vercel.app';
const URL = STAGING + '/admin/dossie-sign';
const OUT = 'atlas-dossie-sign-dashboard-staging-starting-grid.png';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await ctx.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

  console.log('Navigating to', URL);
  const resp = await page.goto(URL, { waitUntil: 'networkidle', timeout: 45000 });
  console.log('HTTP', resp && resp.status());

  // Wait for the grid to render at least some pills
  try {
    await page.waitForSelector('.gate-pill, .status-pill, [data-status]', { timeout: 15000 });
  } catch (e) {
    console.log('No .gate-pill selector — trying generic content wait');
    await page.waitForTimeout(4000);
  }

  await page.screenshot({ path: OUT, fullPage: true });
  console.log('SCREENSHOT saved to', OUT);

  const title = await page.title();
  console.log('TITLE:', title);

  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  console.log('BODY HEAD:\n' + bodyText);

  console.log('CONSOLE ERRORS:', errors.length);
  errors.forEach(e => console.log(' -', e));

  await browser.close();
  process.exit(errors.length > 0 ? 2 : 0);
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });
