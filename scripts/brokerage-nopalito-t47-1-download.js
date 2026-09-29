'use strict';
// Step 5: form already added to workspace by the prior run — reopen the
// same forms/new nonce session isn't possible (new nonce each visit), so
// redo add-form quickly then focus on getting the toolbar download icon's
// real selector and triggering the download.
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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-t47-1-download', acceptDownloads: true });
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

    // Dump the toolbar HTML so we can find the real download control.
    const toolbarHtml = await page.evaluate(() => {
      const icons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
        .filter(el => {
          const r = el.getBoundingClientRect();
          return r.top < 60 && r.width > 0 && r.height > 0;
        })
        .map(el => ({
          tag: el.tagName,
          text: (el.innerText || '').trim(),
          title: el.getAttribute('title'),
          aria: el.getAttribute('aria-label'),
          cls: el.className,
          outerHTML: el.outerHTML.slice(0, 300),
        }));
      return JSON.stringify(icons, null, 2);
    });
    fs.writeFileSync(`${OUT}/download-toolbar-icons.json`, toolbarHtml);
    console.log(toolbarHtml);

    // Download requires saving to a transaction first (modal). Try the
    // Print route instead, which may generate a PDF without that step.
    const printToggle = page.locator('i[data-lwt-id="icnPrint"]').first();
    await printToggle.waitFor({ state: 'visible', timeout: 8000 });
    await printToggle.click({ timeout: 8000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/download-print-menu.png`, fullPage: true }).catch(() => {});
    const printItem = page.locator('button[data-lwt-id="dropdown-print"]').first();
    await printItem.waitFor({ state: 'visible', timeout: 8000 });

    let popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    let downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await printItem.click({ timeout: 8000 }).catch((e) => console.log('print click err', e.message));
    await page.waitForTimeout(3000);
    const [download, popup] = await Promise.all([downloadPromise, popupPromise]);
    if (download) {
      const savePath = `${OUT}\\zipform-t47-1-blank-RAW.pdf`;
      await download.saveAs(savePath);
      console.log('DOWNLOADED VIA PRINT TO', savePath);
    } else if (popup) {
      console.log('POPUP OPENED:', popup.url());
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      fs.writeFileSync(`${OUT}/download-popup-url.txt`, popup.url());
      await popup.screenshot({ path: `${OUT}/download-popup.png`, fullPage: true }).catch(() => {});
    } else {
      console.log('STILL NO DOWNLOAD EVENT OR POPUP FROM PRINT');
      await page.screenshot({ path: `${OUT}/download-after-print-click.png`, fullPage: true }).catch(() => {});
    }
    await page.screenshot({ path: `${OUT}/download-final-state.png`, fullPage: true }).catch(() => {});
    console.log('URL:', page.url());
    console.log('DONE');
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/download-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
