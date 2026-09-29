'use strict';
process.env.BROKERAGE_PROFILE_DIR = 'C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\brokerage-browser-profile-nopalito-disclosure-resend';
const { launchBrokerageContext } = require('./_lib/brokerage-browser');
const fs = require('fs');
const creds = JSON.parse(fs.readFileSync('C:\\Users\\Heath\\.zipform-creds.json', 'utf8'));
const OUT = 'C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\nopalito-disclosure-resend';

async function ensureSignedIn(page) {
  await page.goto('https://www.zipformplus.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const bodyText0 = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (/sign in|username|password/i.test(bodyText0) && !/dashboard|transactions/i.test(bodyText0)) {
    let userInput = await page.$('input[placeholder="Username"]');
    if (!userInput) userInput = await page.$('input[type="email"], input[name*="user" i], input[id*="user" i], input[id*="email" i]');
    if (userInput) {
      await userInput.fill(creds.username);
      let passInput = await page.$('input[placeholder="Password"]');
      if (!passInput) passInput = await page.$('input[type="password"]');
      if (passInput) {
        await passInput.fill(creds.password);
        const signInBtn = page.getByText('Sign In', { exact: true }).first();
        if (await signInBtn.count()) await signInBtn.click({ timeout: 8000 }).catch(() => {});
        else await page.keyboard.press('Enter');
        await page.waitForTimeout(6000);
      }
    }
  }
}

async function clickByText(page, text) {
  return page.evaluate((t) => {
    const nodes = Array.from(document.querySelectorAll('a, li, button, span, div'));
    const target = nodes.find(n => n.textContent.trim() === t && n.offsetParent !== null && n.children.length === 0);
    if (target) { target.click(); return true; }
    const target2 = nodes.find(n => n.textContent.trim() === t && n.offsetParent !== null);
    if (target2) { target2.click(); return 'loose'; }
    return false;
  }, text);
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend13' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    await page.waitForTimeout(2000);
    const txnLink = page.locator('text=SCRATCH - blank form').first();
    await txnLink.waitFor({ state: 'visible', timeout: 20000 });
    await txnLink.click({ timeout: 8000, force: true });
    await page.waitForTimeout(3500);
    console.log('docs tab click:', await clickByText(page, 'Documents'));
    await page.waitForTimeout(2500);

    // Double-click the Wire Fraud thumbnail image (2nd doc card) directly.
    const thumbImg = page.locator('img, canvas').filter({ hasNotText: '' }).nth(1);
    // Fallback: click by known on-screen position of the 2nd doc thumbnail.
    await page.mouse.dblclick(541, 357);
    await page.waitForTimeout(1500);
    await page.mouse.dblclick(541, 357);
    await page.screenshot({ path: `${OUT}/f13-01-opened.png`, fullPage: true }).catch(() => {});

    const dlBtn = page.locator('button.btn-link:has-text("download"), [aria-label="Download" i]').first();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      (async () => {
        await dlBtn.click({ timeout: 8000 });
        await page.waitForTimeout(1000);
        const sf = page.locator('.dropdown-item:has-text("Single File")').first();
        if (await sf.count()) await sf.click({ timeout: 8000 }).catch(() => {});
      })(),
    ]);
    if (download) {
      const savePath = `${OUT}\\txr2517-blank-RAW.pdf`;
      await download.saveAs(savePath);
      console.log('DOWNLOADED txr2517 TO', savePath);
    } else {
      console.log('NO DOWNLOAD for txr2517');
      await page.screenshot({ path: `${OUT}/f13-02-nodownload.png`, fullPage: true }).catch(() => {});
    }
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/f13-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
