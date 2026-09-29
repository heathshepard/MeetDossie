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

async function clickByText(page, text) {
  return page.evaluate((t) => {
    const nodes = Array.from(document.querySelectorAll('a, li, button, span, div'));
    const target = nodes.find(n => n.textContent.trim() === t && n.offsetParent !== null && n.children.length === 0);
    if (target) { target.click(); return true; }
    const target2 = nodes.find(n => n.textContent.trim() === t && n.offsetParent !== null);
    if (target2) { target2.click(); return 'loose'; }
    return false;
  }, text);
}

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend12' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    await page.waitForTimeout(2000);
    const txnLink = page.locator('text=SCRATCH - blank form').first();
    await txnLink.waitFor({ state: 'visible', timeout: 20000 });
    await txnLink.click({ timeout: 8000, force: true });
    await page.waitForTimeout(3500);

    console.log('docs tab click:', await clickByText(page, 'Documents'));
    await page.waitForTimeout(2500);

    console.log('add doc click:', await clickByText(page, 'Add Doc'));
    await page.waitForTimeout(2000);
    console.log('add form click:', await clickByText(page, 'Add Form'));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/f12-00-adddoc.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${OUT}/f12-00-body.txt`, await page.evaluate(() => document.body.innerText).catch(() => ''));

    // This entry point defaults the library picker to SABOR, not TAR/TREC.
    // Switch it to "All libraries" so the TAR 2517 Wire Fraud form is found.
    const libPicker = page.locator('text=San Antonio Board of REALTORS').first();
    if (await libPicker.count()) {
      await libPicker.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);
      console.log('TXR click:', await clickByText(page, '[TXR] - Texas Realtors\u00ae'));
      await page.waitForTimeout(1500);
    }
    await page.screenshot({ path: `${OUT}/f12-00b-libswitch.png` }).catch(() => {});

    const searchBox = page.getByPlaceholder('Search for name or description');
    if (await searchBox.count()) {
      await searchBox.click({ timeout: 5000 }).catch(() => {});
      await searchBox.fill('');
      await searchBox.pressSequentially('2517', { delay: 80 });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `${OUT}/f12-00c-search2517.png` }).catch(() => {});
      const resultRow = page.locator('a:has-text("Wire Fraud Warning (Seller)"), div:has-text("Wire Fraud Warning (Seller)")').last();
      await resultRow.waitFor({ state: 'visible', timeout: 10000 });
      await resultRow.click({ timeout: 8000, force: true });
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${OUT}/f12-00d-afterrowclick.png` }).catch(() => {});
      console.log('close click:', await clickByText(page, 'CLOSE'));
      await page.waitForTimeout(2000);
    } else {
      console.log('NO SEARCH BOX after Add Doc — different modal shape');
    }
    await page.screenshot({ path: `${OUT}/f12-01-afteradd.png`, fullPage: true }).catch(() => {});

    console.log('docs tab click2:', await clickByText(page, 'Documents'));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/f12-02-docslist.png`, fullPage: true }).catch(() => {});
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/f12-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
