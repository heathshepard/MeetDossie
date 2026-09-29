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

async function addAndPrintForm(page, searchTerm, matchText, tag, expectPages) {
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
  const rowText = await resultRow.innerText().catch(() => '');
  fs.writeFileSync(`${OUT}/${tag}-matched-row.txt`, rowText);
  const rowContainer = resultRow.locator('xpath=ancestor::*[self::li or self::div][.//button][1]');
  const addBtn = rowContainer.getByText('ADD', { exact: true }).first();
  await addBtn.click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  const closeBtn = page.locator('button:has-text("CLOSE")').first();
  if (await closeBtn.count()) { await closeBtn.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(2500); }
  await page.waitForTimeout(2000);

  // Switch viewer to "FIT TO WIDTH"? already default. Set zoom out a bit so
  // pages render fully, then print-to-PDF the current viewer state page by
  // page using the pager (arrows) if present, OR just call page.pdf() which
  // captures the whole DOM in print media (continuous flow), letting CSS
  // @media print rules from the viewer handle pagination.
  await page.emulateMedia({ media: 'print' }).catch(() => {});
  const pdfPath = `${OUT}\\${tag}-blank-PRINTED.pdf`;
  await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true, margin: { top: '0.2in', bottom: '0.2in', left: '0.2in', right: '0.2in' } }).catch(async (e) => {
    console.log(`${tag} page.pdf() failed:`, e.message);
  });
  await page.emulateMedia({ media: 'screen' }).catch(() => {});
  console.log(`${tag} printed to`, pdfPath);
  return pdfPath;
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend4' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) { await formsLink.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(3000); }
    await addAndPrintForm(page, '1406', 'Seller', 'txr1406', 7);
    // reset back to the forms library before adding the second form
    const formsLink2 = page.getByText('Forms', { exact: true }).first();
    if (await formsLink2.count()) { await formsLink2.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(2000); }
    await addAndPrintForm(page, '2517', 'Wire Fraud', 'txr2517', 2);
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/fetch4-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
