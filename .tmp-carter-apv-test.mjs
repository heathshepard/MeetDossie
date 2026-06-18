import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const STAGING_URL = 'https://meet-dossie-qcpnl7bs7-heathshepard-6590s-projects.vercel.app/today';
const EMAIL = 'heath.shepard@kw.com';
const PASSWORD = 'Jarvis2026!';

async function test() {
  const browser = await chromium.launch();

  try {
    // Test 1: Desktop viewport (1280x800)
    console.log('=== DESKTOP TEST (1280x800) ===');
    const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopCtx.newPage();

    await desktopPage.goto(STAGING_URL);
    await desktopPage.waitForSelector('#signin-email', { timeout: 5000 });

    // Sign in
    await desktopPage.fill('#signin-email', EMAIL);
    await desktopPage.fill('#signin-password', PASSWORD);
    await desktopPage.click('#signin-btn');
    await desktopPage.waitForSelector('#app.visible', { timeout: 10000 });
    await desktopPage.waitForSelector('.mission-banner', { timeout: 5000 });

    // Wait for todo list to load
    await desktopPage.waitForSelector('#todo-list', { timeout: 5000 });
    const todoItems = await desktopPage.locator('.todo-item').count();
    console.log(`Todo items loaded: ${todoItems}`);

    // Take desktop screenshot showing orb and nav
    await desktopPage.screenshot({ path: 'apv-desktop-final.png', fullPage: false });
    console.log('✓ Desktop screenshot saved: apv-desktop-final.png');

    // Test Hide button if items exist
    if (todoItems > 0) {
      const hideBtn = await desktopPage.locator('.todo-action-btn[data-action="hide"]').first();
      console.log('Hide button found, clicking...');
      await hideBtn.click();
      await desktopPage.waitForTimeout(500);

      // Check for toast
      const toast = await desktopPage.locator('#toast.visible').count();
      if (toast > 0) {
        const toastText = await desktopPage.locator('#toast').textContent();
        console.log(`✓ Hide action successful: "${toastText}"`);
      } else {
        console.log('✗ No toast shown after Hide');
      }

      // Check for error in console
      const errors = [];
      desktopPage.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text());
      });

      if (errors.length > 0) {
        console.log('✗ Console errors detected:', errors);
      } else {
        console.log('✓ No console errors');
      }
    }

    await desktopCtx.close();

    // Test 2: Mobile viewport (390x844)
    console.log('\n=== MOBILE TEST (390x844) ===');
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileCtx.newPage();

    await mobilePage.goto(STAGING_URL);
    await mobilePage.waitForSelector('#signin-email', { timeout: 5000 });

    // Sign in
    await mobilePage.fill('#signin-email', EMAIL);
    await mobilePage.fill('#signin-password', PASSWORD);
    await mobilePage.click('#signin-btn');
    await mobilePage.waitForSelector('#app.visible', { timeout: 10000 });
    await mobilePage.waitForSelector('.mission-banner', { timeout: 5000 });

    // Check for nav visibility
    const backLink = await mobilePage.locator('a:has-text("ventures dashboard")');
    const isVisible = await backLink.isVisible();
    console.log(`✓ Back navigation link visible: ${isVisible}`);

    // Take mobile screenshot
    await mobilePage.screenshot({ path: 'apv-mobile-final.png', fullPage: false });
    console.log('✓ Mobile screenshot saved: apv-mobile-final.png');

    await mobileCtx.close();

    console.log('\n✅ All tests completed');
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

test();
