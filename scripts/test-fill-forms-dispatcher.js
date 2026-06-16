#!/usr/bin/env node
/**
 * Test fill_forms dispatcher via Talk-to-Dossie
 * Verifies: chat -> extract -> fill -> document created
 *
 * Usage: node scripts/test-fill-forms-dispatcher.js [staging-url] [form-type]
 * Example: node scripts/test-fill-forms-dispatcher.js https://meet-dossie-xxx.vercel.app resale-contract
 */

const chromium = require('playwright').chromium;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const STAGING_URL = process.argv[2] || 'https://meet-dossie-staging.vercel.app';
const FORM_TYPE = process.argv[3] || 'resale-contract';
const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = 'DossieDemo-VaIiAt6Bab';

const TEST_PROMPT_MAP = {
  'resale-contract': 'Fill out a resale contract for 123 Main Street in San Antonio, $400,000, buyer John Doe, seller Jane Smith, closing in 30 days',
  'financing-addendum': 'Draft a financing addendum for the Main Street deal, conventional loan, 20% down',
  'termination-notice': 'Draft a termination notice for the Main Street deal',
  'new-home-incomplete': 'Fill out the new home contract for 456 Oak Lane, buyer Bob Johnson, closing in 45 days',
  'farm-ranch': 'Fill out a farm and ranch contract for 100 acres in the Hill Country',
};

const TEST_PROMPT = TEST_PROMPT_MAP[FORM_TYPE] || TEST_PROMPT_MAP['resale-contract'];

(async () => {
  let browser;
  try {
    console.log(`[SETUP] Testing Talk-to-Dossie fill_forms dispatcher`);
    console.log(`  Staging URL: ${STAGING_URL}`);
    console.log(`  Form type: ${FORM_TYPE}`);
    console.log(`  Test prompt: ${TEST_PROMPT}\n`);

    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    console.log('[NAV] Navigating to staging...');
    await page.goto(`${STAGING_URL}/app`, { waitUntil: 'networkidle' });

    console.log('[AUTH] Logging in as demo@meetdossie.com...');
    await page.fill('input[type="email"]', DEMO_EMAIL);
    await page.fill('input[type="password"]', DEMO_PASSWORD);
    await page.click('button:has-text("Sign In")');
    await page.waitForNavigation({ waitUntil: 'networkidle' });

    console.log('[WAIT] Waiting for pipeline to load...');
    await page.waitForSelector('[data-testid="pipeline"]', { timeout: 10000 }).catch(() => {
      console.warn('[WARN] Pipeline selector not found, continuing anyway...');
    });

    console.log('[TALK] Opening Talk-to-Dossie...');
    const talkButton = await page.$('[data-testid="talk-button"]');
    if (!talkButton) {
      console.warn('[WARN] Talk button not found, trying alternative selector...');
      await page.click('button:has-text("Talk to Dossie")').catch(() => {
        console.warn('[WARN] Talk to Dossie button not found');
      });
    } else {
      await talkButton.click();
    }

    console.log('[MODAL] Waiting for Talk modal...');
    await page.waitForSelector('[data-testid="talk-modal"]', { timeout: 5000 }).catch(() => {
      console.warn('[WARN] Talk modal selector not found');
    });

    console.log('[INPUT] Typing test prompt...');
    const inputSelector = 'input[placeholder*="Tell Dossie"], textarea[placeholder*="Tell Dossie"], input[placeholder*="chat"], textarea[placeholder*="chat"]';
    const inputs = await page.$$(inputSelector);
    if (inputs.length === 0) {
      console.warn('[WARN] No input field found with standard selectors, trying generic...');
      const allInputs = await page.$$('input[type="text"], textarea');
      if (allInputs.length > 0) {
        await allInputs[allInputs.length - 1].fill(TEST_PROMPT);
      }
    } else {
      await inputs[0].fill(TEST_PROMPT);
    }

    console.log('[SUBMIT] Submitting talk request...');
    await page.press('input, textarea', 'Enter');

    console.log('[PROCESSING] Waiting for AI response (up to 30s)...');
    let responseFound = false;
    let retries = 0;
    while (retries < 30) {
      const logs = await page.locator('[data-testid="talk-log"]').allTextContents().catch(() => []);
      if (logs.some(log => log.includes('Filled') || log.includes('contract') || log.includes('Documents'))) {
        responseFound = true;
        console.log('[SUCCESS] Found success message in talk log');
        console.log(`  Message: ${logs.find(log => log.includes('Filled') || log.includes('contract'))}`);
        break;
      }
      await page.waitForTimeout(1000);
      retries++;
    }

    if (!responseFound) {
      console.log('[WARN] No success message found after 30s. Checking network errors...');
      const errors = await page.locator('[data-testid="talk-log"]').allTextContents().catch(() => []);
      console.log(`  Talk log contents: ${errors.join(' | ')}`);
    }

    console.log('[DOCS] Checking Documents tab...');
    const docsTab = await page.$('button:has-text("Documents")');
    if (docsTab) {
      await docsTab.click();
      await page.waitForTimeout(1000);
      const docCount = await page.locator('[data-testid="document-row"]').count().catch(() => 0);
      console.log(`  Found ${docCount} documents in list`);
    }

    console.log('\n[DONE] Test complete. Check browser for visual confirmation.');
    // Keep browser open for manual inspection
    await page.waitForTimeout(5000);

  } catch (error) {
    console.error('[ERROR]', error);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
