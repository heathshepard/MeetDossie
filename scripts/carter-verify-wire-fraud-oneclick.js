'use strict';

// scripts/carter-verify-wire-fraud-oneclick.js
//
// Real-browser verification of the new one-click "Send for sig." action for
// the Wire Fraud Warning banner (dossie-app.jsx DealDetailPanel). Signs into
// the demo account for real, opens a real deal with no wire_fraud_deliveries
// row, clicks the real button, and confirms the badge flips to "sent" —
// not just that a network call returned 200.
//
// Usage: node scripts/carter-verify-wire-fraud-oneclick.js <preview-url>

const { chromium } = require('playwright');

const PREVIEW_URL = process.argv[2];
if (!PREVIEW_URL) {
  console.error('Usage: node scripts/carter-verify-wire-fraud-oneclick.js <preview-url>');
  process.exit(1);
}

const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const TARGET_TX_ID = '71041124-a3d5-45f8-bb5c-d17a0b7bd3f6'; // 4501 Broadway Ave — under-contract, buyer_email = heath.shepard@kw.com, no wire_fraud_deliveries row

if (!DEMO_PASSWORD) {
  console.error('DEMO_PASSWORD not set in environment.');
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser console error]', msg.text());
  });

  try {
    console.log('Navigating to', `${PREVIEW_URL}/app`);
    await page.goto(`${PREVIEW_URL}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);

    // Sign in
    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ timeout: 15000 });
    await emailInput.fill(DEMO_EMAIL);
    const pwInput = page.locator('input[type="password"]').first();
    if (await pwInput.count() === 0) {
      // Might be on magic-link mode by default — look for a toggle to password mode.
      const pwToggle = page.getByText(/password/i).first();
      if (await pwToggle.count() > 0) await pwToggle.click();
    }
    await page.locator('input[type="password"]').first().fill(DEMO_PASSWORD);
    await page.screenshot({ path: '/tmp/wf-before-signin-click.png', fullPage: true });
    await page.getByRole('button', { name: /sign in|log in/i }).first().click({ force: true, timeout: 10000 }).catch(async (e) => {
      console.log('normal click failed, trying keyboard submit:', e.message);
      await page.locator('input[type="password"]').first().press('Enter');
    });
    await page.waitForTimeout(3000);

    await page.screenshot({ path: '/tmp/wf-after-signin-click.png', fullPage: true });
    console.log('URL after sign-in click:', page.url());

    // Verify signed in as the demo account.
    const debug = await page.evaluate(() => {
      const keys = [];
      let email = null;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          keys.push(k);
          if (k && (k.includes('-auth-token') || k.includes('supabase.auth.token'))) {
            const v = JSON.parse(localStorage.getItem(k));
            email = v?.user?.email || v?.currentSession?.user?.email || v?.currentUser?.email || null;
          }
        }
      } catch (_) {}
      return { keys, email };
    });
    console.log('localStorage keys:', debug.keys);
    const sessionEmail = debug.email;
    console.log('Signed in as:', sessionEmail);
    if (!sessionEmail || sessionEmail.toLowerCase() !== DEMO_EMAIL) {
      throw new Error(`Not signed in as demo account — got "${sessionEmail}"`);
    }

    // Click the deal directly from the Morning Brief list.
    const dealCard = page.getByText(/4501 Broadway Ave/i).first();
    await dealCard.waitFor({ timeout: 15000 });
    await dealCard.click();
    await page.waitForTimeout(2500);

    await page.screenshot({ path: '/tmp/wf-before.png', fullPage: true });

    // Locate the wire fraud banner + button.
    const banner = page.getByText(/Wire Fraud Warning not sent/i).first();
    await banner.waitFor({ timeout: 15000 });
    console.log('Found "Wire Fraud Warning not sent" banner.');

    const sendBtn = page.getByRole('button', { name: /Send for sig\./i }).first();
    await sendBtn.waitFor({ timeout: 10000 });
    console.log('Clicking "Send for sig." ...');
    await sendBtn.click();

    // Wait for the button to show "Sending..." then resolve.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: '/tmp/wf-sending.png', fullPage: true });

    // Wait up to 30s for the badge to flip to "sent - awaiting acknowledgment"
    // or for an inline error message to appear.
    const result = await Promise.race([
      page.getByText(/Wire Fraud Warning sent/i).first().waitFor({ timeout: 30000 }).then(() => 'sent'),
      page.locator('text=/Could not send|not on file|Sign in first/i').first().waitFor({ timeout: 30000 }).then(() => 'error'),
    ]).catch(() => 'timeout');

    await page.screenshot({ path: '/tmp/wf-after.png', fullPage: true });

    if (result === 'sent') {
      console.log('RESULT: PASS — banner flipped to "sent - awaiting acknowledgment" after a real click.');
    } else if (result === 'error') {
      const errText = await page.locator('text=/Could not send|not on file|Sign in first/i').first().textContent().catch(() => '(unreadable)');
      console.log('RESULT: FAIL — inline error shown:', errText);
    } else {
      console.log('RESULT: FAIL — timed out waiting for a sent/error state.');
    }
  } catch (err) {
    console.error('SCRIPT ERROR:', err && err.message);
    await page.screenshot({ path: '/tmp/wf-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
})();
