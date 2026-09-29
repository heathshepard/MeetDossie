'use strict';
// One-off explorer: log into zipForm with direct credentials (per
// zipform-credential-login memory) and find the standalone form library
// ("Add a Form" outside any transaction) so we can pull a genuine blank
// T-47.1 Declaration. Screenshots only, no destructive actions.
process.env.BROKERAGE_PROFILE_DIR = 'C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\brokerage-browser-profile-nopalito-t47';
const { launchBrokerageContext } = require('./_lib/brokerage-browser');
const fs = require('fs');

const creds = JSON.parse(fs.readFileSync('C:\\Users\\Heath\\.zipform-creds.json', 'utf8'));
const OUT = 'C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\nopalito-t47-1';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const context = await launchBrokerageContext({ headless: true, reason: 'nopalito-t47-1-explore' });
  const page = await context.newPage();
  try {
    await page.goto('https://www.zipformplus.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${OUT}/explore-01-landing.png`, fullPage: true }).catch(() => {});

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
          if (await signInBtn.count()) {
            await signInBtn.click({ timeout: 8000 }).catch(() => {});
          } else {
            await page.keyboard.press('Enter');
          }
          await page.waitForTimeout(7000);
        }
      }
    }
    await page.screenshot({ path: `${OUT}/explore-02-postlogin.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${OUT}/explore-02-posturl.txt`, page.url());
    const bodyText1 = await page.evaluate(() => document.body.innerText).catch(() => '');
    fs.writeFileSync(`${OUT}/explore-02-bodytext.txt`, bodyText1);
    console.log('POST LOGIN URL:', page.url());

    // Look for nav items that suggest a standalone forms library.
    const navLinks = await page.$$eval('a, button', els => els
      .map(el => (el.innerText || '').trim())
      .filter(t => t && t.length < 60));
    fs.writeFileSync(`${OUT}/explore-02-navlinks.json`, JSON.stringify([...new Set(navLinks)], null, 2));
    console.log('NAV LINK COUNT:', navLinks.length);
    console.log('DONE');
  } catch (e) {
    console.error('FATAL', e.stack || e.message);
    await page.screenshot({ path: `${OUT}/explore-fatal.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
  }
})();
