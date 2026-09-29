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

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend7' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    // Go straight to the transaction we just created and named.
    await page.goto('https://www.zipformplus.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const searchInput = page.locator('input[placeholder*="Search" i]').first();
    if (await searchInput.count()) {
      await searchInput.fill('SCRATCH - blank form export');
      await page.waitForTimeout(2000);
    }
    await page.screenshot({ path: `${OUT}/f7-00-search.png`, fullPage: true }).catch(() => {});
    const txnLink = page.locator('text=SCRATCH - blank form export').first();
    await txnLink.waitFor({ state: 'visible', timeout: 10000 });
    await txnLink.click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/f7-01-txn-open.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${OUT}/f7-01-url.txt`, page.url());

    // Find the FORMS section / +ADD button in the transaction workspace.
    const formsNav = page.locator('text=FORMS').first();
    if (await formsNav.count()) { await formsNav.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2000); }
    const addBtn = page.locator('button:has-text("ADD"), a:has-text("+ ADD"), button:has-text("+ ADD")').first();
    await addBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/f7-02-add-menu.png`, fullPage: true }).catch(() => {});

    // The "+ADD" button likely opens a menu with "Add TREC/TAR Forms" etc.
    const trecOpt = page.locator('text=/TREC|TAR Forms|Association Forms/i').first();
    if (await trecOpt.count()) {
      await trecOpt.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/f7-03-after-trecopt.png`, fullPage: true }).catch(() => {});
    }

    const searchBox = page.getByPlaceholder('Search for name or description');
    if (await searchBox.count()) {
      await searchBox.fill('2517');
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/f7-04-search2517.png`, fullPage: true }).catch(() => {});
      const dialog = page.locator('div[role="dialog"]').last();
      const resultRow = dialog.locator('text=Wire Fraud').first();
      await resultRow.waitFor({ state: 'visible', timeout: 10000 });
      const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
      const rowAddBtn = rowContainer.getByText('ADD', { exact: true }).first();
      await rowAddBtn.click({ timeout: 8000 });
      await page.waitForTimeout(3000);
      const closeBtn = page.locator('button:has-text("CLOSE")').first();
      if (await closeBtn.count()) { await closeBtn.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
    }
    await page.screenshot({ path: `${OUT}/f7-05-after-add2517.png`, fullPage: true }).catch(() => {});

    // Open the newly added Wire Fraud doc and download it.
    const docEntry = page.locator('text=Wire Fraud').last();
    if (await docEntry.count()) { await docEntry.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
    await page.screenshot({ path: `${OUT}/f7-06-doc-open.png`, fullPage: true }).catch(() => {});

    const dlBtn = page.locator('button.btn-link:has-text("download")').first();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      (async () => {
        await dlBtn.click({ timeout: 8000 });
        await page.waitForTimeout(800);
        const sf = page.locator('.dropdown-item:has-text("Single File")').first();
        await sf.click({ timeout: 8000 });
      })(),
    ]);
    if (download) {
      const savePath = `${OUT}\\txr2517-blank-RAW.pdf`;
      await download.saveAs(savePath);
      console.log('DOWNLOADED txr2517 TO', savePath);
    } else {
      console.log('NO DOWNLOAD for txr2517');
      await page.screenshot({ path: `${OUT}/f7-07-nodownload.png`, fullPage: true }).catch(() => {});
    }
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/f7-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
