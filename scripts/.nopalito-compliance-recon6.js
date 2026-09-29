'use strict';
const path = require('path');
const fs = require('fs');
const BROKERAGE_COMMAND_PROFILE_DIR = 'C:\\Users\\Heath\\.brokerage-command-profile';
const COMMAND_BASE = 'https://console.command.kw.com';
const OPP_ID = '14128336';
const OUT = 'C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\nopalito-compliance-recon';
fs.mkdirSync(OUT, { recursive: true });

async function dump(page, name) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  fs.writeFileSync(path.join(OUT, `${name}.txt`), text);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch((e) => console.log('screenshot err', e.message));
  console.log('---', name, 'url=', page.url(), 'len=', text.length);
}

async function dismissPopups(page) {
  for (const t of ['Remind Me Later', 'Cancel', 'Got it', 'Dismiss', 'Close']) {
    const loc = page.locator(`text=${t}`).first();
    if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
      await loc.click({ timeout: 2000, force: true }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
}

async function main() {
  const { unlockProfile } = require('./_lib/chrome-profile-unlock');
  await unlockProfile({ profileDir: BROKERAGE_COMMAND_PROFILE_DIR, reason: 'nopalito-compliance-recon6' });
  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(BROKERAGE_COMMAND_PROFILE_DIR, {
    headless: true,
    channel: 'chrome',
    viewport: { width: 1700, height: 1100 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });
  try {
    const page = await context.newPage();

    const oppUrl = `${COMMAND_BASE}/command/opportunities/details?id=${OPP_ID}`;
    await page.goto(oppUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('nav err', e.message));
    await page.waitForTimeout(4000);
    await dismissPopups(page);
    await page.mouse.click(705, 160); // Documents tab
    await page.waitForTimeout(3000);
    await dismissPopups(page);
    const ucFolder = page.locator('text=Under Contract').first();
    await ucFolder.click({ timeout: 3000, force: true }).catch((e) => console.log('uc click err', e.message));
    await page.waitForTimeout(2500);
    await dismissPopups(page);

    // Inspect the "Receipted Contract" row's DOM for clickable icon elements
    const rowInfo = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && el.innerText && el.innerText.trim() === 'Receipted Contract');
      if (!rows.length) return 'NOT FOUND';
      const el = rows[0];
      // walk up to find the row container
      let row = el;
      for (let i = 0; i < 6 && row.parentElement; i++) row = row.parentElement;
      return row.outerHTML.slice(0, 3000);
    });
    fs.writeFileSync(path.join(OUT, 'receipted-row-html.txt'), rowInfo);
    console.log('row html len', rowInfo.length);

    // Click the little icon before "Receipted Contract" (an SVG or icon element within the row)
    const iconClicked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('*')).filter(el => el.children.length === 0 && el.innerText && el.innerText.trim() === 'Receipted Contract');
      if (!rows.length) return false;
      let row = rows[0];
      for (let i = 0; i < 4 && row.parentElement; i++) row = row.parentElement;
      const icon = row.querySelector('svg, img, [class*="icon"]');
      if (icon) { icon.dispatchEvent(new MouseEvent('click', {bubbles:true})); return true; }
      return false;
    });
    console.log('icon clicked via JS:', iconClicked);
    await page.waitForTimeout(2000);
    await dismissPopups(page);
    await dump(page, '06-after-icon-click');

  } catch (e) {
    console.error('FATAL', e.message);
  } finally {
    await context.close().catch(() => {});
  }
}
main();
