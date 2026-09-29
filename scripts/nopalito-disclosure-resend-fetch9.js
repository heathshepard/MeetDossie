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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend9' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    await page.waitForTimeout(2000);
    const txnLink = page.locator('text=SCRATCH - blank form').first();
    await txnLink.waitFor({ state: 'visible', timeout: 20000 });
    await txnLink.click({ timeout: 8000, force: true });
    await page.waitForTimeout(3500);

    const formsTab = page.locator('text=FORMS').first();
    if (await formsTab.count()) { await formsTab.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2000); }
    const addBtn = page.locator('button:has-text("+ ADD"), button:has-text("ADD")').first();
    await addBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(2000);

    const searchBox = page.getByPlaceholder('Search for name or description');
    await searchBox.waitFor({ state: 'visible', timeout: 8000 });
    await searchBox.fill('2517');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/f9-search2517.png` }).catch(() => {});
    const dialog = page.locator('div[role="dialog"]').last();
    const resultRow = dialog.locator('text=Wire Fraud Warning (Seller)').first();
    await resultRow.waitFor({ state: 'visible', timeout: 10000 });
    const rowText = await resultRow.innerText().catch(() => '');
    fs.writeFileSync(`${OUT}/f9-matched-row.txt`, rowText);
    const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
    const rowAddBtn = rowContainer.getByText('ADD', { exact: true }).first();
    await rowAddBtn.click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    const closeBtn = page.locator('button:has-text("CLOSE")').first();
    if (await closeBtn.count()) { await closeBtn.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/f9-after-add.png` }).catch(() => {});

    const docEntry = page.locator('text=Wire Fraud Warning (Seller)').last();
    if (await docEntry.count()) { await docEntry.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
    await page.screenshot({ path: `${OUT}/f9-doc-open.png` }).catch(() => {});

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
      await page.screenshot({ path: `${OUT}/f9-nodownload.png` }).catch(() => {});
    }
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/f9-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
