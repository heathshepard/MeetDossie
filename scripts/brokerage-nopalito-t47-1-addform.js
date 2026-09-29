'use strict';
// Step 3: from the standalone forms/new page, click ADD A FORM, search for
// T-47.1, add it, then export/download the resulting blank PDF.
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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-t47-1-addform' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);

    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) {
      await formsLink.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
    console.log('On forms/new page:', page.url());

    const addFormBtn = page.locator('button:has-text("ADD A FORM")').first();
    await addFormBtn.waitFor({ state: 'attached', timeout: 10000 });
    await addFormBtn.scrollIntoViewIfNeeded().catch(() => {});
    await addFormBtn.click({ timeout: 8000, force: true });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/addform-01-modal.png`, fullPage: true }).catch(() => {});
    const bodyText1 = await page.evaluate(() => document.body.innerText).catch(() => '');
    fs.writeFileSync(`${OUT}/addform-01-bodytext.txt`, bodyText1);

    // Try to find a search box for form name/number.
    const searchBox = await page.$('input[type="text"], input[type="search"], input[placeholder*="search" i], input[placeholder*="form" i]');
    if (searchBox) {
      await searchBox.fill('T-47.1');
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/addform-02-search.png`, fullPage: true }).catch(() => {});
      const bodyText2 = await page.evaluate(() => document.body.innerText).catch(() => '');
      fs.writeFileSync(`${OUT}/addform-02-bodytext.txt`, bodyText2);
    } else {
      console.log('NO SEARCH BOX FOUND');
    }

    console.log('URL:', page.url());
    console.log('DONE');
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/addform-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
