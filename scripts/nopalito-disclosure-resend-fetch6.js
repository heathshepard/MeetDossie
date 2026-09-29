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

async function addForm(page, searchTerm, matchText) {
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
  const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
  const addBtn = rowContainer.getByText('ADD', { exact: true }).first();
  await addBtn.click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  const closeBtn = page.locator('button:has-text("CLOSE")').first();
  if (await closeBtn.count()) { await closeBtn.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
  await page.waitForTimeout(1500);
}

async function downloadSingle(page, tag) {
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
    const savePath = `${OUT}\\${tag}-blank-RAW.pdf`;
    await download.saveAs(savePath);
    console.log(`DOWNLOADED ${tag} TO`, savePath);
    return true;
  }
  console.log(`NO DOWNLOAD for ${tag}`);
  return false;
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend6' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) { await formsLink.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(3000); }

    await addForm(page, '1406', 'Seller');

    const dlBtn = page.locator('button.btn-link:has-text("download")').first();
    await dlBtn.click({ timeout: 8000 });
    await page.waitForTimeout(800);
    const sf = page.locator('.dropdown-item:has-text("Single File")').first();
    await sf.click({ timeout: 8000 });
    await page.waitForTimeout(2000);

    const yesBtn = page.locator('button:has-text("YES")').first();
    await yesBtn.waitFor({ state: 'visible', timeout: 8000 });
    await yesBtn.click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    const purchaseOpt = page.locator('text=New Purchase or Offer').first();
    await purchaseOpt.waitFor({ state: 'visible', timeout: 8000 });
    await purchaseOpt.click({ timeout: 5000 });
    await page.waitForTimeout(2000);

    // Fill the required Name + Category fields.
    const nameInput = page.locator('input[placeholder="Enter name or property address"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 8000 });
    await nameInput.fill('SCRATCH - blank form export - safe to delete');

    const categorySelect = page.locator('select').filter({ hasText: '' }).first();
    // Try native select first
    const selects = page.locator('select');
    const selCount = await selects.count();
    console.log('select count', selCount);
    for (let i = 0; i < selCount; i++) {
      const opts = await selects.nth(i).locator('option').allInnerTexts().catch(() => []);
      console.log('select', i, JSON.stringify(opts));
    }
    if (selCount > 0) {
      // pick first select assumed to be Category, choose first non-empty option
      const opts0 = await selects.nth(0).locator('option').allInnerTexts();
      const pick = opts0.find(o => o && !/select/i.test(o)) || opts0[1];
      if (pick) await selects.nth(0).selectOption({ label: pick }).catch(async () => {
        await selects.nth(0).selectOption({ index: 1 }).catch(() => {});
      });
    }
    await page.screenshot({ path: `${OUT}/step6-filled.png`, fullPage: true }).catch(() => {});

    const saveBtn = page.locator('button:has-text("SAVE")').first();
    await saveBtn.click({ timeout: 8000 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${OUT}/step6-after-save.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${OUT}/step6-url-after-save.txt`, page.url());

    // Now retry the download from inside the transaction.
    const ok1406 = await downloadSingle(page, 'txr1406');
    console.log('ok1406', ok1406);

    // Navigate to add the second form into the SAME scratch transaction.
    const ok2517 = await (async () => {
      await addForm(page, '2517', 'Wire Fraud');
      return downloadSingle(page, 'txr2517');
    })();
    console.log('ok2517', ok2517);
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/fetch6-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
