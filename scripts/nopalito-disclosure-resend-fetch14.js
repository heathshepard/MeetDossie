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

async function downloadFromViewer(vpage, tag) {
  const dlBtn = vpage.locator('button.btn-link:has-text("download")').first();
  await dlBtn.waitFor({ state: 'visible', timeout: 10000 });
  const [download] = await Promise.all([
    vpage.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    (async () => {
      await dlBtn.click({ timeout: 8000 });
      await vpage.waitForTimeout(1000);
      const sf = vpage.locator('.dropdown-item:has-text("Single File")').first();
      if (await sf.count()) await sf.click({ timeout: 8000 }).catch(() => {});
    })(),
  ]);
  if (download) {
    const savePath = `${OUT}\\${tag}-blank-RAW.pdf`;
    await download.saveAs(savePath);
    console.log(`DOWNLOADED ${tag} TO`, savePath);
    return true;
  }
  return false;
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend14' });
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

    const newPagePromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await page.mouse.click(541, 357);
    await page.waitForTimeout(800);
    await page.mouse.click(541, 357);
    let viewerPage = await newPagePromise;
    if (!viewerPage) {
      console.log('no new page opened; treating current page as viewer');
      viewerPage = page;
    } else {
      await viewerPage.waitForLoadState('domcontentloaded').catch(() => {});
      console.log('new viewer page url:', viewerPage.url());
    }
    await viewerPage.waitForTimeout(2000);
    await viewerPage.screenshot({ path: `${OUT}/f14-viewer.png`, fullPage: true }).catch(() => {});

    const ok = await downloadFromViewer(viewerPage, 'txr2517');
    console.log('ok2517', ok);
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/f14-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
