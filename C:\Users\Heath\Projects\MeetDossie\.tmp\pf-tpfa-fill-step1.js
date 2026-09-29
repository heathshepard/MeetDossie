const { launchBrokerageContext } = require('C:\\Users\\Heath\\Projects\\MeetDossie\\scripts\\_lib\\brokerage-browser.js');

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'pfeiffers-gate-tpfa-fill' });
  try {
    const page = await context.newPage();
    await page.goto('https://www.zipformplus.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const pw = page.locator('input[type="password"]').first();
    if (await pw.isVisible().catch(() => false)) {
      const len = await pw.evaluate(el => (el.value || '').length).catch(() => 0);
      if (len > 0) {
        await page.getByRole('button', { name: /sign in/i }).first().click();
        await page.waitForTimeout(6000);
      }
    }
    await page.waitForTimeout(2000);
    console.log('URL after login attempt:', page.url());
    await page.screenshot({ path: '/tmp/pf-01-after-login.png', fullPage: false });
  } finally {
    console.log('leaving context open for next step... actually closing per rule');
    await context.close();
  }
})().catch(e => { console.error('ERR', e); process.exit(1); });
