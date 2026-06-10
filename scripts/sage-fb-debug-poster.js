'use strict';
// One-off debug: launch DossieBot-Sage profile, visit a group, screenshot + dump post-box candidates.

const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_PROFILE_PATH = path.join(os.homedir(), 'AppData', 'Local', 'DossieBot-Sage');
const PROFILE_NAME = 'Default';
const GROUP_URL = process.argv[2] || 'https://www.facebook.com/groups/texasusarealestateagents/';
const OUT_DIR = path.join(__dirname, '..', '.tmp-fb-debug');
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });
  const page = await context.newPage();
  console.log('[debug] Navigating to:', GROUP_URL);
  await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(6000);
  const url = page.url();
  console.log('[debug] Final URL:', url);

  // Logged in?
  const loggedIn = !/login|checkpoint/i.test(url);
  console.log('[debug] Logged in:', loggedIn);

  // Find membership signal
  const joinBtn = await page.$('div[role="button"][aria-label*="Join"], div[role="button"][aria-label*="Cancel request"]');
  console.log('[debug] Join button present (not member or pending):', !!joinBtn);

  // Try multiple selectors
  const selectors = [
    '[aria-label*="Write something"]',
    '[aria-label*="What\'s on your mind"]',
    '[aria-label*="Anonymous post"]',
    '[aria-label*="Create a public post"]',
    'div[role="button"][tabindex="0"]',
    '[data-pagelet="GroupInlineComposer"]',
    '[contenteditable="true"]',
  ];
  for (const sel of selectors) {
    const els = await page.$$(sel);
    console.log(`[debug] ${sel}: ${els.length} matches`);
  }

  // Look for any element containing the prompt text
  const textCandidates = ['Write something', "What's on your mind", 'Share something with this group', 'Anonymous post'];
  for (const t of textCandidates) {
    const count = await page.locator(`text=${t}`).count();
    console.log(`[debug] text="${t}": ${count} matches`);
  }

  // Screenshot
  const shot = path.join(OUT_DIR, 'screen.png');
  await page.screenshot({ path: shot, fullPage: false });
  console.log('[debug] Screenshot saved:', shot);

  // Dump page title
  const title = await page.title();
  console.log('[debug] Page title:', title);

  // Dump first 500 chars of visible text
  const bodyText = await page.locator('body').innerText().catch(() => '');
  console.log('[debug] Body preview:');
  console.log(bodyText.slice(0, 800).replace(/\n+/g, ' | '));

  await page.waitForTimeout(2000);
  await context.close();
})().catch((e) => {
  console.error('[debug] FATAL:', e.message);
  process.exit(1);
});
