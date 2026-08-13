'use strict';
// One-off verification: does the DocuSeal signing URL produced by the new
// Wire Fraud Warning one-click send actually open a real signer page with
// the TAR 2517 PDF and a signature widget? Usage: node scripts/carter-verify-wire-fraud-signing-url.js <signingUrl>
const { chromium } = require('playwright');
const url = process.argv[2];
if (!url) { console.error('Usage: node scripts/carter-verify-wire-fraud-signing-url.js <signingUrl>'); process.exit(1); }
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: '/tmp/wf-docuseal-signing.png', fullPage: true });
  console.log('title:', await page.title());
  console.log((await page.textContent('body').catch(() => '')).slice(0, 500));
  await browser.close();
})();
