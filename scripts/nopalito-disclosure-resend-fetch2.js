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
  const closeBtn = page.locator('button:has-text("CLOSE")').first();
  if (await closeBtn.count()) { await closeBtn.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${tag}-doc-open.png` }).catch(() => {});

  // Click the "download" toolbar button (btn-link.btn-lg with text "download")
  const dlBtn = page.locator('button.btn-link:has-text("download")').first();
  await dlBtn.waitFor({ state: 'visible', timeout: 8000 });
  await dlBtn.click({ timeout: 8000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${tag}-after-dl-click.png` }).catch(() => {});

  // A dropdown menu may appear with the real download-trigger item(s).
  const menuItems = page.locator('.dropdown-menu.show .dropdown-item, .dropdown-item:visible');
  const count = await menuItems.count().catch(() => 0);
  console.log(`${tag} dropdown items:`, count);
  let download = null;
  if (count > 0) {
    for (let i = 0; i < count; i++) {
      const txt = (await menuItems.nth(i).innerText().catch(() => '')).trim();
      console.log(`${tag} item ${i}:`, txt);
    }
    [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      menuItems.first().click({ timeout: 8000 }).catch(() => {}),
    ]);
  } else {
    // No dropdown appeared — the click itself may have triggered the download.
    download = await page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
  }
  if (download) {
    const savePath = `${OUT}\\${tag}-blank-RAW.pdf`;
    await download.saveAs(savePath);
    console.log(`DOWNLOADED ${tag} TO`, savePath);
    return true;
  }
  console.log(`STILL NO DOWNLOAD for ${tag}`);
  return false;
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend2' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) { await formsLink.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(3000); }

    const ok1406 = await fetchBlankForm(page, '1406', 'Seller', 'txr1406');
    const ok2517 = await fetchBlankForm(page, '2517', 'Wire Fraud', 'txr2517');
    console.log('RESULTS', JSON.stringify({ ok1406, ok2517 }));
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
  } finally {
    await context.close();
  }
})();
