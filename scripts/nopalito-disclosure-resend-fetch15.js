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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-disclosure-resend15' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    await page.waitForTimeout(2000);
    const txnLink = page.locator('text=SCRATCH - blank form').first();
    await txnLink.waitFor({ state: 'visible', timeout: 20000 });
    await txnLink.click({ timeout: 8000, force: true });
    await page.waitForTimeout(3500);
    await clickByText(page, 'Documents');
    await page.waitForTimeout(2500);
    await page.mouse.click(541, 357);
    await page.waitForTimeout(800);
    await page.mouse.click(541, 357);
    await page.waitForTimeout(2500);

    console.log('open prev workspace:', await clickByText(page, 'OPEN MY PREVIOUS WORKSPACE'));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/f15-01-workspace.png`, fullPage: true }).catch(() => {});

    // In the Workspace panel, select the Wire Fraud Warning checkbox, then
    // use the workspace-level download icon.
    const wfCheckbox = page.locator('text=Wire Fraud Warning (Seller)').first()
      .locator('xpath=preceding::input[@type="checkbox"][1]');
    // Simpler: click the checkbox that sits directly left of the text in the Workspace list.
    const checked = await page.evaluate(() => {
      const label = Array.from(document.querySelectorAll('*')).find(n =>
        n.textContent.trim().startsWith('Wire Fraud Warning (Seller)') && n.offsetParent !== null && n.children.length === 0);
      if (!label) return 'no-label';
      // walk up to find a row container with an input[type=checkbox]
      let el = label;
      for (let i = 0; i < 5 && el; i++) {
        const cb = el.querySelector && el.querySelector('input[type=checkbox]');
        if (cb) { cb.click(); return 'clicked'; }
        el = el.parentElement;
      }
      return 'no-checkbox-found';
    });
    console.log('checkbox result:', checked);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/f15-02-checked.png`, fullPage: true }).catch(() => {});

    // Workspace toolbar download icon (the one near +ADD/pencil/envelope/download/print/trash).
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
      (async () => {
        // Click the download icon in the Workspace toolbar (4th icon after +ADD, pencil, envelope).
        const icons = await page.$$('div.workspace, .workspace-toolbar, button');
        // Fall back: click by aria-label / title containing download, scoped near "Workspace" text.
        const ok = await page.evaluate(() => {
          const wsHeader = Array.from(document.querySelectorAll('*')).find(n => n.textContent.trim() === 'Workspace' && n.offsetParent !== null);
          if (!wsHeader) return false;
          const container = wsHeader.closest('div');
          if (!container) return false;
          const btns = Array.from(container.parentElement.querySelectorAll('button, i, svg'));
          const dl = btns.find(b => (b.getAttribute('aria-label')||'').toLowerCase().includes('download') || (b.className||'').toString().toLowerCase().includes('download'));
          if (dl) { dl.click(); return true; }
          return false;
        });
        console.log('workspace download icon click:', ok);
      })(),
    ]);
    if (download) {
      const savePath = `${OUT}\\txr2517-blank-RAW.pdf`;
      await download.saveAs(savePath);
      console.log('DOWNLOADED txr2517 TO', savePath);
    } else {
      console.log('NO DOWNLOAD for txr2517 via workspace icon');
      await page.screenshot({ path: `${OUT}/f15-03-nodownload.png`, fullPage: true }).catch(() => {});
    }
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/f15-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
