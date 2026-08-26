'use strict';

// scripts/rust-playconsole-login-setup.js
//
// ONE-TIME (or re-run whenever the session lapses) interactive login pass
// into a dedicated Chrome profile (C:\Users\Heath\.rust-playconsole-browser-profile)
// for Google Play Console, scoped to the Rust app (developer account
// 6719074801771127302, app 4972720077147610907).
//
// Opens the Play Console store-listing edit URL in a VISIBLE window and
// waits for Heath to complete Google sign-in (including 2FA) BY HAND. This
// script deliberately does NOT attempt to type an email/password or touch
// any 2FA prompt — Google auth with 2FA is a human-only action, same rule
// as scripts/brokerage-login-setup.js (connectMLS SSO+MFA) and
// scripts/quinn-login-setup.js (myjarvis sign-in).
//
// Because this uses launchPersistentContext against a stable profile dir,
// login persists on disk. Future Play Console automation (headless, via
// scripts/_lib/rust-playconsole-browser.js) starts pre-authenticated until
// the underlying Google session cookie itself expires.
//
// *** GOOGLE-SPECIFIC CAVEAT — read before assuming this behaves like
// connectMLS ***
// connectMLS/SABOR has no MFA and its session is a plain, long-lived cookie
// — Heath's own words: "I literally never have to enter my password... it
// logs me in automatically," and that has held for a long time. Google is
// NOT the same shape:
//   - Google actively runs device/behavior risk scoring on top of the
//     session cookie. A profile that suddenly automates form-fills, submits
//     from a datacenter-adjacent WSL/Chromium stack, or is inactive for a
//     long stretch can trigger a "verify it's you" / "new sign-in detected"
//     challenge even with a technically-valid cookie still on disk.
//   - 2FA-backed Google accounts periodically force re-auth on their own
//     schedule (session max-age, security-sensitive-action re-prompts,
//     Play Console specifically re-prompting for account changes), whether
//     or not the cookie itself expired.
//   - This is NOT a "log in once, forget about it forever" guarantee like
//     connectMLS. Treat it as: durable for a while, but if any future
//     headless run lands back on accounts.google.com instead of the real
//     Play Console page, that's the expected failure mode — re-run this
//     script by hand, it is not a bug in the automation.
//
// Usage: node scripts/rust-playconsole-login-setup.js

const {
  launchRustPlayConsoleContext,
  RUST_PLAYCONSOLE_PROFILE_DIR,
  storeListingUrl,
} = require('./_lib/rust-playconsole-browser');

const TARGET_URL = storeListingUrl();

// Positive signal the real Play Console app shell has rendered — NOT just
// the absence of a sign-in form (which can false-positive during the brief
// pre-hydration paint of a redirect page, same failure mode flagged in
// quinn-login-setup.js). Play Console's authenticated shell renders a
// persistent left-nav; the "Store listing" edit surface itself always has a
// visible page heading. We check both a URL shape AND a DOM signal.
function isAuthedUrl(url) {
  if (!url) return false;
  if (/accounts\.google\.com/i.test(url)) return false;
  if (/\/signin|\/ServiceLogin|\/o\/oauth2/i.test(url)) return false;
  return /play\.google\.com\/console\/.*\/app\//i.test(url);
}

async function isAuthedPage(page) {
  try {
    const url = page.url();
    if (!isAuthedUrl(url)) return false;
    // Google's sign-in page always renders an <input type="password"> (or,
    // for the identifier step, type="email"). The authenticated Play
    // Console shell never does. This catches the case where the URL looks
    // console-shaped mid-redirect but the DOM is still the login form.
    const hasLoginInput = await page.evaluate(() => {
      return !!document.querySelector('input[type="password"], input[type="email"]');
    }).catch(() => true); // fail closed — treat evaluate errors as "not authed yet"
    return !hasLoginInput;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`[rust-playconsole-login] dedicated profile dir: ${RUST_PLAYCONSOLE_PROFILE_DIR}`);
  console.log(`[rust-playconsole-login] target: ${TARGET_URL}`);

  const context = await launchRustPlayConsoleContext({
    headless: false,
    reason: 'rust-playconsole-login-setup',
  });

  const page = await context.newPage();
  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.warn(`[rust-playconsole-login] nav warning: ${e.message}`);
  }

  console.log('');
  console.log('[rust-playconsole-login] A real, visible Chrome window is open on your desktop.');
  console.log('[rust-playconsole-login] Sign into Google by hand, once (including any 2FA prompt).');
  console.log('[rust-playconsole-login] This is a ONE-TIME pass for this dedicated profile. Polling for up to 10 minutes...');
  console.log('');

  const deadline = Date.now() + 10 * 60 * 1000;
  let authed = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    authed = await isAuthedPage(page);
    if (authed) {
      console.log(`[rust-playconsole-login] authenticated — landed on ${page.url().slice(0, 100)}`);
      break;
    }
  }

  const path = require('path');
  const fs = require('fs');
  const screenshotDir = path.join(__dirname, 'atlas-runs', `rust-playconsole-login-${Date.now()}`);
  fs.mkdirSync(screenshotDir, { recursive: true });
  const shot = path.join(screenshotDir, 'after-login.png');
  try {
    await page.screenshot({ path: shot });
    console.log(`[rust-playconsole-login] screenshot saved: ${shot}`);
  } catch {}

  if (authed) {
    console.log('[rust-playconsole-login] DONE — profile is ready for headless Play Console runs.');
    console.log('[rust-playconsole-login] Verify with: node scripts/rust-playconsole-verify-session.js');
    await context.close();
  } else {
    console.log('[rust-playconsole-login] Still not signed in after 10 minutes.');
    console.log('[rust-playconsole-login] The window stays open below — finish logging in whenever, then close the');
    console.log('[rust-playconsole-login] window yourself (or Ctrl+C this process). The profile is persistent, so a');
    console.log('[rust-playconsole-login] login completed after this script exits still sticks for next time.');
    // Deliberately do NOT context.close() — leave the window open, same as
    // brokerage-login-setup.js / quinn-login-setup.js.
  }
}

main().catch((e) => {
  console.error('[rust-playconsole-login] fatal:', e && e.stack || e);
  process.exit(1);
});
