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
  await unlockProfile({ profileDir: BROKERAGE_COMMAND_PROFILE_DIR, reason: 'nopalito-compliance-recon9' });
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

    // Click the ellipsis "..." button within the Receipted Contract row
    const clicked = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="compliance-documents-table-item"]'));
      const target = rows.find(r => r.innerText.includes('Receipted Contract'));
      if (!target) return 'ROW NOT FOUND';
      const btn = target.querySelector('.dropdown__trigger button');
      if (!btn) return 'BUTTON NOT FOUND';
      btn.click();
      return 'CLICKED';
    });
    console.log('ellipsis click result:', clicked);
    await page.waitForTimeout(1500);
    await dump(page, '09-ellipsis-dropdown');

  } catch (e) {
    console.error('FATAL', e.message);
  } finally {
    await context.close().catch(() => {});
  }
}
main();
