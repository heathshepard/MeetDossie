'use strict';

// scripts/test-stealth-realtor.js
//
// Tier 1 stealth test against realtor.com SA agent directory.
// Tests if playwright-extra + puppeteer-extra-plugin-stealth can bypass
// basic fingerprint detection on realtor.com.
//
// Run:
//   node scripts/test-stealth-realtor.js
//
// Output:
//   .tmp/stealth-realtor-test.png        (screenshot proof)
//   Console: PASS/FAIL + agent count

const path = require('path');
const fs = require('fs');
const { chromium } = require('./_lib/stealth-browser');

const TMP_DIR = path.join(__dirname, '..', '.tmp');
const SCREENSHOT_PATH = path.join(TMP_DIR, 'stealth-realtor-test.png');

// Ensure .tmp exists
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

async function testStealth() {
  let browser, context, page;

  try {
    console.log('[TEST] Launching stealth chromium (headed)...');
    browser = await chromium.launch({
      headless: false,  // Show the browser so we can see what's happening
      args: ['--no-sandbox']
    });

    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    page = await context.newPage();

    console.log('[TEST] Navigating to realtor.com SA agent directory...');
    await page.goto('https://www.realtor.com/realestateagents/san-antonio_tx', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for agent cards to render
    console.log('[TEST] Waiting for agent cards...');
    await page.waitForSelector('[data-testid="agent-card"]', { timeout: 15000 }).catch(() => {
      console.warn('[TEST] Could not find agent-card selector, trying alternative...');
    });

    // Give it a moment to render
    await page.waitForTimeout(2000);

    // Take screenshot
    console.log('[TEST] Capturing screenshot...');
    await page.screenshot({ path: SCREENSHOT_PATH });
    console.log(`[TEST] Screenshot saved: ${SCREENSHOT_PATH}`);

    // Try to extract agent names
    console.log('[TEST] Attempting to extract agent data...');
    const agents = await page.evaluate(() => {
      const agentCards = document.querySelectorAll('[data-testid="agent-card"]');
      const results = [];
      agentCards.forEach((card, idx) => {
        if (idx < 10) {  // First 10 only
          const nameEl = card.querySelector('[data-testid="agent-name"]');
          const brokerageEl = card.querySelector('[data-testid="agent-brokerage"]');
          if (nameEl || brokerageEl) {
            results.push({
              name: nameEl?.textContent?.trim() || 'N/A',
              brokerage: brokerageEl?.textContent?.trim() || 'N/A'
            });
          }
        }
      });
      return results;
    });

    if (agents.length > 0) {
      console.log('\n[TEST] PASS — Extracted agent data:');
      agents.forEach((a, idx) => {
        console.log(`  ${idx + 1}. ${a.name} @ ${a.brokerage}`);
      });
      console.log('\nTier 1 stealth: PASS. Realtor.com not blocking.');
      process.exit(0);
    } else {
      console.log('[TEST] WARNING: No agent cards found, but page loaded. Possible blocking or layout change.');
      console.log('[TEST] Check screenshot at:', SCREENSHOT_PATH);
      console.log('\nTier 1 stealth: UNKNOWN (page loaded but no data extracted).');
      process.exit(1);
    }

  } catch (err) {
    console.error('[TEST] ERROR:', err.message);
    if (err.name === 'TimeoutError') {
      console.error('[TEST] Timeout — likely blocked by bot detection.');
    }
    console.log('\nTier 1 stealth: FAIL. Realtor.com blocking.');
    process.exit(1);
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

testStealth();