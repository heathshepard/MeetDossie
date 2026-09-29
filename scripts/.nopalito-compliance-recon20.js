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
  await unlockProfile({ profileDir: BROKERAGE_COMMAND_PROFILE_DIR, reason: 'nopalito-compliance-recon20' });
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
    await page.mouse.click(705, 160);
    await page.waitForTimeout(3000);
    await dismissPopups(page);
    const ucFolder = page.locator('text=Under Contract').first();
    await ucFolder.click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(2500);
    await dismissPopups(page);

    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="compliance-documents-table-item"]'));
      const target = rows.find(r => r.innerText.includes('Receipted Contract'));
      const fileBtn = target.querySelector('[data-testid="compliance-documents-table-item-file-preview"] button');
      fileBtn.click();
    });
    await page.waitForTimeout(3000);

    // click Show Pages via JS
    const r = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="document-preview-tab-controls-show-pages-button"]');
      if (!btn) return 'NOT FOUND';
      btn.click();
      return 'CLICKED';
    });
    console.log('show pages result:', r);
    await page.waitForTimeout(2000);
    await dump(page, '20a-thumbnails');

    // Now try to find page 11 thumbnail and click it
    const r2 = await page.evaluate(() => {
      const thumbs = Array.from(document.querySelectorAll('[class*="thumbnail"], [class*="page-thumb"]'));
      return 'thumb count=' + thumbs.length;
    });
    console.log(r2);

  } catch (e) {
    console.error('FATAL', e.message);
  } finally {
    await context.close().catch(() => {});
  }
}
main();
