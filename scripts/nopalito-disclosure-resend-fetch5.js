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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend5' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) { await formsLink.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(3000); }

    const addFormBtn = page.locator('button:has-text("ADD A FORM")').first();
    await addFormBtn.waitFor({ state: 'attached', timeout: 15000 });
    await addFormBtn.click({ timeout: 8000, force: true });
    await page.waitForTimeout(2000);
    const searchBox = page.getByPlaceholder('Search for name or description');
    await searchBox.waitFor({ state: 'visible', timeout: 8000 });
    await searchBox.fill('1406');
    await page.waitForTimeout(2500);
    const dialog = page.locator('div[role="dialog"]').last();
    const resultRow = dialog.locator('text=Seller').first();
    await resultRow.waitFor({ state: 'visible', timeout: 10000 });
    const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
    const addBtn = rowContainer.getByText('ADD', { exact: true }).first();
    await addBtn.click({ timeout: 8000 });
    await page.waitForTimeout(3000);
    const closeBtn = page.locator('button:has-text("CLOSE")').first();
    if (await closeBtn.count()) { await closeBtn.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
    await page.waitForTimeout(1500);

    const dlBtn = page.locator('button.btn-link:has-text("download")').first();
    await dlBtn.click({ timeout: 8000 });
    await page.waitForTimeout(1000);
    const singleFileItem = page.locator('.dropdown-item:has-text("Single File")').first();
    await singleFileItem.click({ timeout: 8000 });
    await page.waitForTimeout(2000);

    const yesBtn = page.locator('button:has-text("YES")').first();
    await yesBtn.waitFor({ state: 'visible', timeout: 8000 });
    await yesBtn.click({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/step-createtxn.png`, fullPage: true }).catch(() => {});

    const purchaseOpt = page.locator('text=New Purchase or Offer').first();
    await purchaseOpt.waitFor({ state: 'visible', timeout: 8000 });
    await purchaseOpt.click({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/step-purchase-form.png`, fullPage: true }).catch(() => {});
    const bodyTxt = await page.evaluate(() => document.body.innerText).catch(() => '');
    fs.writeFileSync(`${OUT}/step-purchase-form-body.txt`, bodyTxt);
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/fetch5-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
