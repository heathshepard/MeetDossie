'use strict';
// Step 6: redo the print flow, but this time grab the blob PDF bytes
// directly out of the popup page via fetch() + FileReader instead of
// fighting the Chrome PDF-viewer download icon.
process.env.BROKERAGE_PROFILE_DIR = 'C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\brokerage-browser-profile-nopalito-t47';
const { launchBrokerageContext } = require('./_lib/brokerage-browser');
const fs = require('fs');

const creds = JSON.parse(fs.readFileSync('C:\\Users\\Heath\\.zipform-creds.json', 'utf8'));
const OUT = 'C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\nopalito-t47-1';

async function ensureSignedIn(page) {
  await page.goto('https://www.zipformplus.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-t47-1-blobfetch', acceptDownloads: true });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) {
      await formsLink.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    const addFormBtn = page.locator('button:has-text("ADD A FORM")').first();
    await addFormBtn.waitFor({ state: 'attached', timeout: 10000 });
    await addFormBtn.click({ timeout: 8000, force: true });
    await page.waitForTimeout(2000);
    const searchBox = page.getByPlaceholder('Search for name or description');
    await searchBox.waitFor({ state: 'visible', timeout: 8000 });
    await searchBox.fill('T-47.1');
    await page.waitForTimeout(2500);
    const dialog = page.locator('div[role="dialog"]').last();
    const resultRow = dialog.locator('text=T-47.1 Residential Real Property Declaration').first();
    await resultRow.waitFor({ state: 'visible', timeout: 8000 });
    const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
    const addBtn = rowContainer.getByText('ADD', { exact: true }).first();
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    const closeBtn = page.locator('button:has-text("CLOSE")').first();
    if (await closeBtn.count()) {
      await closeBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }

    const printToggle = page.locator('i[data-lwt-id="icnPrint"]').first();
    await printToggle.waitFor({ state: 'visible', timeout: 8000 });
    await printToggle.click({ timeout: 8000 });
    await page.waitForTimeout(1000);
    const printItem = page.locator('button[data-lwt-id="dropdown-print"]').first();
    await printItem.waitFor({ state: 'visible', timeout: 8000 });

    const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await printItem.click({ timeout: 8000 });
    const popup = await popupPromise;
    if (!popup) throw new Error('No popup opened for the print preview.');
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForTimeout(2500);
    const blobUrl = popup.url();
    console.log('BLOB URL:', blobUrl);

    // Fetch the blob bytes from inside the popup's own JS context (same
    // origin as the blob) and hand them back as base64.
    const base64 = await popup.evaluate(async (url) => {
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }, blobUrl);

    const outPath = `${OUT}\\zipform-t47-1-blank-RAW.pdf`;
    fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
    console.log('SAVED', outPath, Buffer.from(base64, 'base64').length, 'bytes');
    console.log('DONE');
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/blobfetch-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
