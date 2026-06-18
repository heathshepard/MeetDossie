#!/usr/bin/env node
/**
 * Playwright test: verify scan-contract works via both base64 and signed-URL paths.
 * Requires: npx playwright install chromium
 * Run: node test-scan-signed-url.mjs
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = 'DossieDemo-VaIiAt6Bab';
const STAGING_URL = 'https://meetdossie-staging.vercel.app/app';

// Create test PDFs
function createSmallPdf() {
  // ~1MB minimal PDF
  const pdfHeader = '%PDF-1.4\n';
  const content = 'BT /F1 12 Tf 100 700 Td (Test Contract - Small) Tj ET\n';
  const xref = 'xref\n0 1\n0000000000 65535 f\n1 4\n';
  let size = pdfHeader.length + content.length + xref.length;

  // Pad to ~1.5MB
  const padding = Buffer.alloc(1.5 * 1024 * 1024 - size, ' ');
  return Buffer.concat([
    Buffer.from(pdfHeader),
    Buffer.from(content),
    Buffer.from(xref),
    padding,
    Buffer.from('trailer\n<</Size 5>>\nstartxref\n0\n%%EOF'),
  ]);
}

function createLargePdf() {
  // ~5MB minimal PDF with padding
  const pdfHeader = '%PDF-1.4\n';
  const content = 'BT /F1 12 Tf 100 700 Td (Test Contract - Large) Tj ET\n';
  const xref = 'xref\n0 1\n0000000000 65535 f\n1 4\n';
  let size = pdfHeader.length + content.length + xref.length;

  // Pad to ~5.5MB
  const padding = Buffer.alloc(5.5 * 1024 * 1024 - size, ' ');
  return Buffer.concat([
    Buffer.from(pdfHeader),
    Buffer.from(content),
    Buffer.from(xref),
    padding,
    Buffer.from('trailer\n<</Size 5>>\nstartxref\n0\n%%EOF'),
  ]);
}

async function main() {
  console.log('[TEST] Starting scan-contract signed-URL verification');
  console.log('[TEST] Target: ' + STAGING_URL);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to app
    console.log('[TEST] Navigating to ' + STAGING_URL);
    await page.goto(STAGING_URL, { waitUntil: 'networkidle' });

    // Check if already signed in
    const currentUrl = page.url();
    const isSignedIn = currentUrl.includes('/app');

    if (!isSignedIn) {
      console.log('[TEST] Not signed in, logging in as ' + DEMO_EMAIL);

      // Wait for login form
      await page.waitForSelector('input[type="email"]', { timeout: 5000 });

      // Fill login form
      await page.fill('input[type="email"]', DEMO_EMAIL);
      await page.fill('input[type="password"]', DEMO_PASSWORD);

      // Click sign in
      await page.click('button:has-text("Sign In")');

      // Wait for redirect to app
      await page.waitForURL(/\/app/, { waitUntil: 'networkidle', timeout: 10000 });
      console.log('[TEST] Signed in successfully');
    } else {
      console.log('[TEST] Already signed in');
    }

    // Take screenshot
    const screenshotPath = path.join(__dirname, 'apv-signed-in.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('[TEST] Signed-in screenshot saved: ' + screenshotPath);

    // Look for New Dossier button and click it
    console.log('[TEST] Looking for New Dossier button...');
    const newButton = await page.$('button:has-text("New Dossier"), button:has-text("+")');
    if (!newButton) {
      console.log('[TEST] Could not find New Dossier button');
      console.log('[TEST] Available buttons:');
      const buttons = await page.$$eval('button', bs => bs.map(b => b.textContent.trim()));
      buttons.forEach(b => console.log('  -', b));
    } else {
      await newButton.click();
      await page.waitForTimeout(1000);
      console.log('[TEST] Opened New Dossier modal');

      // Look for Scan Contract button
      const scanBtn = await page.$('button:has-text("Scan"), input[type="file"]');
      if (scanBtn) {
        console.log('[TEST] Found Scan Contract element');

        // TEST 1: Small file (base64 path)
        console.log('[TEST] TEST 1: Uploading small PDF (<3MB)...');
        const smallPdf = createSmallPdf();
        const smallPath = path.join(__dirname, 'test-small.pdf');
        fs.writeFileSync(smallPath, smallPdf);

        const fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(smallPath);
          await page.waitForTimeout(2000);

          // Check console for debug logs
          const logs = await page.evaluate(() => {
            return window.__scanDebugLogs || [];
          });
          console.log('[TEST] Small file scan logs:', logs);
        }

        // TEST 2: Large file (signed-URL path)
        console.log('[TEST] TEST 2: Uploading large PDF (>=3MB)...');
        const largePdf = createLargePdf();
        const largePath = path.join(__dirname, 'test-large.pdf');
        fs.writeFileSync(largePath, largePdf);

        if (fileInput) {
          await fileInput.setInputFiles(largePath);
          await page.waitForTimeout(5000);

          const logs2 = await page.evaluate(() => {
            return window.__scanDebugLogs || [];
          });
          console.log('[TEST] Large file scan logs:', logs2);
        }

        // Take final screenshot
        const finalScreenshot = path.join(__dirname, 'apv-scan-complete.png');
        await page.screenshot({ path: finalScreenshot, fullPage: true });
        console.log('[TEST] Final screenshot: ' + finalScreenshot);
      }
    }

    console.log('[TEST] Test completed. Check screenshots and console logs above.');
    console.log('[TEST] Console logs available in browser DevTools (F12 → Console)');

  } catch (error) {
    console.error('[TEST] Error:', error);
    const errorScreenshot = path.join(__dirname, 'apv-error.png');
    await page.screenshot({ path: errorScreenshot, fullPage: true });
    console.log('[TEST] Error screenshot saved: ' + errorScreenshot);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[TEST] Fatal error:', err);
  process.exit(1);
});
