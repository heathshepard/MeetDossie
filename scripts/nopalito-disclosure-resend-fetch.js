'use strict';
// Fresh isolated-profile pull of blank TXR-1406 (Seller's Disclosure Notice)
// and TXR-2517 (Wire Fraud Warning) from zipForm's standalone forms library
// (Forms > ADD A FORM, outside any transaction). Pattern copied verbatim
// from scripts/brokerage-nopalito-t47-1-fetch-final.js (proven working
// 9/2026 pull of a genuinely blank T-47.1).
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

async function fetchBlankForm(page, searchTerm, matchText, tag) {
  const addFormBtn = page.locator('button:has-text("ADD A FORM")').first();
  await addFormBtn.waitFor({ state: 'attached', timeout: 15000 });
  await addFormBtn.click({ timeout: 8000, force: true });
  await page.waitForTimeout(2000);

  const searchBox = page.getByPlaceholder('Search for name or description');
  await searchBox.waitFor({ state: 'visible', timeout: 8000 });
  await searchBox.fill('');
  await searchBox.fill(searchTerm);
  await page.waitForTimeout(2500);

  const dialog = page.locator('div[role="dialog"]').last();
  const resultRow = dialog.locator(`text=${matchText}`).first();
  await resultRow.waitFor({ state: 'visible', timeout: 10000 });
  const fullRowText = await resultRow.innerText().catch(() => '');
  fs.writeFileSync(`${OUT}/${tag}-matched-row.txt`, fullRowText);

  const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
  const addBtn = rowContainer.getByText('ADD', { exact: true }).first();
  await addBtn.click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/${tag}-01-after-add.png`, fullPage: true }).catch(() => {});

  const closeBtn = page.locator('button:has-text("CLOSE")').first();
  if (await closeBtn.count()) {
    await closeBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
  await page.screenshot({ path: `${OUT}/${tag}-02-doc-added.png`, fullPage: true }).catch(() => {});

  // Click the sidebar entry that best matches, to open/preview it.
  const docEntry = page.locator(`text=${matchText}`).last();
  if (await docEntry.count()) {
    await docEntry.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: `${OUT}/${tag}-03-doc-open.png`, fullPage: true }).catch(() => {});

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.locator('[aria-label="Download" i], button:has-text("download"), .download, svg[aria-label="download" i]').first().click({ timeout: 8000 }).catch(() => {}),
  ]);
  if (download) {
    const savePath = `${OUT}\\${tag}-blank-RAW.pdf`;
    await download.saveAs(savePath);
    console.log(`DOWNLOADED ${tag} TO`, savePath);
    return true;
  } else {
    console.log(`NO DOWNLOAD EVENT for ${tag}`);
    return false;
  }
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    await page.screenshot({ path: `${OUT}/00-postlogin.png`, fullPage: true }).catch(() => {});

    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) {
      await formsLink.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    fs.writeFileSync(`${OUT}/01-formslib-url.txt`, page.url());

    const ok1406 = await fetchBlankForm(page, '1406', 'Seller', 'txr1406');
    const ok2517 = await fetchBlankForm(page, '2517', 'Wire Fraud', 'txr2517');

    console.log('RESULTS', JSON.stringify({ ok1406, ok2517 }));
    console.log('DONE');
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
