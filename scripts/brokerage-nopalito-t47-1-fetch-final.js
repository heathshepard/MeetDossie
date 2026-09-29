'use strict';
// Step 4: search, ADD the T-47.1 form, close modal, then download the
// resulting blank PDF via zipForm's download control.
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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-t47-1-fetchfinal' });
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
    // The row's own small ADD button, scoped to the result row's container,
    // not the modal-wide "Add a Form" primary button which also matches
    // any 'has-text("ADD")' substring search.
    const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
    const addBtn = rowContainer.getByText('ADD', { exact: true }).first();
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/fetch-01-after-add.png`, fullPage: true }).catch(() => {});

    // Close the modal (CLOSE button) to return to the document view.
    const closeBtn = page.locator('button:has-text("CLOSE")').first();
    if (await closeBtn.count()) {
      await closeBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
    await page.screenshot({ path: `${OUT}/fetch-02-doc-added.png`, fullPage: true }).catch(() => {});
    const bodyText1 = await page.evaluate(() => document.body.innerText).catch(() => '');
    fs.writeFileSync(`${OUT}/fetch-02-bodytext.txt`, bodyText1);
    fs.writeFileSync(`${OUT}/fetch-02-url.txt`, page.url());

    // Try clicking the sidebar document entry to open/preview it full-screen.
    const docEntry = page.locator('text=T-47.1').first();
    if (await docEntry.count()) {
      await docEntry.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    await page.screenshot({ path: `${OUT}/fetch-03-doc-open.png`, fullPage: true }).catch(() => {});

    // Attempt download via the download icon in the top toolbar.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      page.locator('[aria-label="Download" i], button:has-text("download"), .download, svg[aria-label="download" i]').first().click({ timeout: 8000 }).catch(() => {}),
    ]);
    if (download) {
      const savePath = `${OUT}\\zipform-t47-1-blank-RAW.pdf`;
      await download.saveAs(savePath);
      console.log('DOWNLOADED TO', savePath);
    } else {
      console.log('NO DOWNLOAD EVENT CAPTURED — will try the top download icon by coordinates next.');
    }
    console.log('DONE');
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/fetch-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
