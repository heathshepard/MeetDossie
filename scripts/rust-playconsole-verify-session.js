'use strict';

// scripts/rust-playconsole-verify-session.js
//
// Loads the persistent Rust Play Console Chrome profile HEADLESS (no login
// attempt, no form-fill) and checks whether it lands on the real,
// authenticated store-listing page or gets bounced to Google sign-in.
//
// Run this any time to confirm the saved session (from
// scripts/rust-playconsole-login-setup.js) is still good, BEFORE building
// or dispatching any real Play Console automation on top of it — same
// "prove the capability before building on it" rule as every other MLS/
// Gmail/zipForm session check in this repo.
//
// Usage: node scripts/rust-playconsole-verify-session.js
//
// Exit code 0 = session good (authenticated, real page loaded).
// Exit code 1 = session bad/missing (bounced to Google sign-in, or the
//   profile has never been through rust-playconsole-login-setup.js).

const path = require('path');
const fs = require('fs');
const {
  launchRustPlayConsoleContext,
  RUST_PLAYCONSOLE_PROFILE_DIR,
  storeListingUrl,
} = require('./_lib/rust-playconsole-browser');

const TARGET_URL = storeListingUrl();

async function main() {
  const profileExists = fs.existsSync(RUST_PLAYCONSOLE_PROFILE_DIR);
  console.log(`[verify] profile dir: ${RUST_PLAYCONSOLE_PROFILE_DIR} (exists: ${profileExists})`);
  if (!profileExists) {
    console.log('[verify] FAIL — profile has never been created. Run rust-playconsole-login-setup.js first.');
    process.exit(1);
  }

  console.log(`[verify] target: ${TARGET_URL}`);
  const context = await launchRustPlayConsoleContext({ headless: true, reason: 'rust-playconsole-verify' });
  const page = await context.newPage();

  let finalUrl = '';
  let navError = null;
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Give any client-side redirect (console shell -> Google sign-in, or
    // vice versa) a moment to settle before reading the final URL.
    await page.waitForTimeout(3000);
    finalUrl = page.url();
  } catch (e) {
    navError = e.message;
  }

  const bouncedToLogin = /accounts\.google\.com|\/signin|\/ServiceLogin|\/o\/oauth2/i.test(finalUrl);
  const looksLikeConsole = /play\.google\.com\/console\/.*\/app\//i.test(finalUrl);

  let hasLoginInput = true;
  if (!navError) {
    hasLoginInput = await page.evaluate(() => {
      return !!document.querySelector('input[type="password"], input[type="email"]');
    }).catch(() => true);
  }

  const screenshotDir = path.join(__dirname, 'atlas-runs', `rust-playconsole-verify-${Date.now()}`);
  fs.mkdirSync(screenshotDir, { recursive: true });
  const shot = path.join(screenshotDir, 'verify-result.png');
  try { await page.screenshot({ path: shot }); } catch {}

  await context.close();

  console.log(`[verify] final URL: ${finalUrl || '(none — nav error)'}`);
  console.log(`[verify] screenshot: ${shot}`);
  if (navError) console.log(`[verify] nav error: ${navError}`);

  const authed = !navError && !bouncedToLogin && looksLikeConsole && !hasLoginInput;

  if (authed) {
    console.log('[verify] PASS — landed on the real, authenticated Play Console store-listing page. Session is good.');
    process.exit(0);
  } else {
    console.log('[verify] FAIL — did not land on an authenticated Play Console page.');
    if (bouncedToLogin) console.log('[verify]   reason: bounced to Google sign-in.');
    if (!looksLikeConsole && !bouncedToLogin) console.log('[verify]   reason: URL did not match the expected console/app shape.');
    if (hasLoginInput) console.log('[verify]   reason: page still shows a login input.');
    console.log('[verify] Fix: run `node scripts/rust-playconsole-login-setup.js` and complete sign-in by hand.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[verify] fatal:', e && e.stack || e);
  process.exit(1);
});
