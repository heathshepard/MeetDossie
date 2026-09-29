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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-wirefraud-search' });
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
    await searchBox.fill('Wire Fraud');
    await page.waitForTimeout(2500);
    const dialog = page.locator('div[role="dialog"]').last();
    const rows = dialog.locator('.modal-body >> text=/./').first(); // placeholder
    const allText = await dialog.innerText().catch(() => '');
    fs.writeFileSync(`${OUT}/wf-search-allrows.txt`, allText);
    console.log(allText);
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
  } finally {
    await context.close();
  }
})();
