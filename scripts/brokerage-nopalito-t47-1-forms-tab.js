'use strict';
// Step 2: from the authenticated zipForm dashboard, click the top-level
// "Forms" nav item (standalone library, outside any transaction) and look
// for a way to search/add the T-47.1.
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
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-t47-1-formstab' });
  const page = await context.newPage();
  try {
    await ensureSignedIn(page);
    await page.screenshot({ path: `${OUT}/forms-01-dashboard.png`, fullPage: true }).catch(() => {});

    // Click the top nav "Forms" link (not "Forms and Checklists" which is
    // likely a per-transaction thing).
    const formsLink = page.getByText('Forms', { exact: true }).first();
    if (await formsLink.count()) {
      await formsLink.click({ timeout: 8000 }).catch(async (e) => {
        console.log('click failed, trying force', e.message);
        await formsLink.click({ timeout: 8000, force: true }).catch(() => {});
      });
      await page.waitForTimeout(4000);
    } else {
      console.log('NO "Forms" nav link found by exact text');
    }
    await page.screenshot({ path: `${OUT}/forms-02-after-click.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${OUT}/forms-02-url.txt`, page.url());
    const bodyText1 = await page.evaluate(() => document.body.innerText).catch(() => '');
    fs.writeFileSync(`${OUT}/forms-02-bodytext.txt`, bodyText1);

    // Also check for iframes -- zipForm heavily uses them.
    const frames = page.frames();
    fs.writeFileSync(`${OUT}/forms-02-frames.json`, JSON.stringify(frames.map(f => f.url()), null, 2));
    console.log('FRAME COUNT:', frames.length);
    console.log('URL:', page.url());
    console.log('DONE');
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/forms-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
