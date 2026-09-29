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

async function fetchBlankForm(context, page, searchTerm, matchText, tag) {
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

  const dlBtn = page.locator('button.btn-link:has-text("download")').first();
  await dlBtn.waitFor({ state: 'visible', timeout: 8000 });
  await dlBtn.click({ timeout: 8000 });
  await page.waitForTimeout(1000);

  const singleFileItem = page.locator('.dropdown-item:has-text("Single File")').first();
  await singleFileItem.waitFor({ state: 'visible', timeout: 8000 });

  let download = null, newPage = null;
  const results = await Promise.allSettled([
    page.waitForEvent('download', { timeout: 20000 }),
    context.waitForEvent('page', { timeout: 20000 }),
    singleFileItem.click({ timeout: 8000 }),
  ]);
  if (results[0].status === 'fulfilled') download = results[0].value;
  if (results[1].status === 'fulfilled') newPage = results[1].value;
  console.log(`${tag} download=${!!download} newPage=${!!newPage}`);

  if (!download && !newPage) {
    // "Save Changes" modal blocks the download until the blank form is
    // saved to a scratch transaction. Accept (YES), then retry the
    // download menu from inside that transaction.
    const yesBtn = page.locator('button:has-text("YES")').first();
    if (await yesBtn.count()) {
      await yesBtn.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(4000);
      await page.screenshot({ path: `${OUT}/${tag}-after-yes.png`, fullPage: true }).catch(() => {});

      // Re-open the download menu from wherever we landed.
      const dlBtn2 = page.locator('button.btn-link:has-text("download")').first();
      if (await dlBtn2.count()) {
        await dlBtn2.click({ timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const sf2 = page.locator('.dropdown-item:has-text("Single File")').first();
        if (await sf2.count()) {
          const results3 = await Promise.allSettled([
            page.waitForEvent('download', { timeout: 15000 }),
            context.waitForEvent('page', { timeout: 15000 }),
            sf2.click({ timeout: 5000 }),
          ]);
          if (results3[0].status === 'fulfilled') download = results3[0].value;
          if (results3[1].status === 'fulfilled') newPage = results3[1].value;
        }
      }
      console.log(`${tag} (post-YES) download=${!!download} newPage=${!!newPage}`);
    }
  }

  if (download) {
    const savePath = `${OUT}\\${tag}-blank-RAW.pdf`;
    await download.saveAs(savePath);
    console.log(`DOWNLOADED ${tag} TO`, savePath);
    return true;
  }
  if (newPage) {
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    console.log(`${tag} new page url:`, newPage.url());
    // maybe the new tab itself triggers a download shortly after load
    const d2 = await newPage.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    if (d2) {
      const savePath = `${OUT}\\${tag}-blank-RAW.pdf`;
      await d2.saveAs(savePath);
      console.log(`DOWNLOADED (via newPage) ${tag} TO`, savePath);
      await newPage.close().catch(() => {});
      return true;
    }
    await newPage.screenshot({ path: `${OUT}/${tag}-newpage.png`, fullPage: true }).catch(() => {});
    await newPage.close().catch(() => {});
  }
  await page.screenshot({ path: `${OUT}/${tag}-after-singlefile.png` }).catch(() => {});
  console.log(`STILL NO DOWNLOAD for ${tag}`);
  return false;
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend3' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) { await formsLink.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(3000); }

    const ok1406 = await fetchBlankForm(context, page, '1406', 'Seller', 'txr1406');
    const ok2517 = await fetchBlankForm(context, page, '2517', 'Wire Fraud', 'txr2517');
    console.log('RESULTS', JSON.stringify({ ok1406, ok2517 }));
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
  } finally {
    await context.close();
  }
})();
