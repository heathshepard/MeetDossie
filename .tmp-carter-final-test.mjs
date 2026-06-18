import { chromium } from 'playwright';
import fs from 'fs';

const STAGING_URL = 'https://meet-dossie-n9l1rf5ev-heathshepard-6590s-projects.vercel.app/today';
const EMAIL = 'heath.shepard@kw.com';
const PASSWORD = 'Jarvis2026!';

async function test() {
  const browser = await chromium.launch();
  const results = {
    hideButtonWorks: false,
    desktopNavClear: false,
    mobileNavVisible: false,
    atmosphereShellRendered: false,
  };

  try {
    // Test 1: Desktop (1280x800) - Hide button + orb positioning
    console.log('=== DESKTOP TEST (1280x800) ===');
    const desktopCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const desktopPage = await desktopCtx.newPage();

    desktopPage.on('console', msg => {
      if (msg.type() === 'error') {
        console.log(`[CONSOLE ERROR] ${msg.text()}`);
      }
    });

    await desktopPage.goto(STAGING_URL);
    await desktopPage.waitForSelector('#signin-email', { timeout: 5000 });

    await desktopPage.fill('#signin-email', EMAIL);
    await desktopPage.fill('#signin-password', PASSWORD);
    await desktopPage.click('#signin-btn');
    await desktopPage.waitForSelector('#app.visible', { timeout: 10000 });
    await desktopPage.waitForSelector('#todo-list', { timeout: 5000 });

    const todoItems = await desktopPage.locator('.todo-item').count();
    console.log(`✓ Loaded ${todoItems} todo items`);

    if (todoItems > 0) {
      const hideBtn = await desktopPage.locator('.todo-action-btn[data-action="hide"]').first();
      console.log('Testing Hide button...');
      await hideBtn.click();
      await desktopPage.waitForTimeout(500);

      const toastText = await desktopPage.locator('#toast').textContent();
      console.log(`Toast: "${toastText}"`);

      if (toastText === 'Hidden') {
        results.hideButtonWorks = true;
        console.log('✓ Hide button works (status now skipped)');
      } else {
        console.log('✗ Hide returned error (check database constraint)');
      }
    }

    // Check if nav is visible and not covered by orb
    const backLinkBox = await desktopPage.locator('a:has-text("ventures dashboard")').boundingBox();
    const orbContainer = await desktopPage.locator('canvas').boundingBox();
    if (backLinkBox && orbContainer) {
      const navY = backLinkBox.y;
      const orbBottomY = orbContainer.y + orbContainer.height * 0.3;  // Orb at top ~30% of viewport
      results.desktopNavClear = (navY > orbBottomY + 20);
      console.log(`Nav at Y:${Math.round(navY)}, Orb bottom ~Y:${Math.round(orbBottomY)}, Clear: ${results.desktopNavClear}`);
    }

    await desktopPage.screenshot({ path: 'apv-desktop-final.png', fullPage: false });
    console.log('✓ Desktop screenshot saved');

    await desktopCtx.close();

    // Test 2: Mobile (390x844) - Nav visibility
    console.log('\n=== MOBILE TEST (390x844) ===');
    const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileCtx.newPage();

    await mobilePage.goto(STAGING_URL);
    await mobilePage.waitForSelector('#signin-email', { timeout: 5000 });

    await mobilePage.fill('#signin-email', EMAIL);
    await mobilePage.fill('#signin-password', PASSWORD);
    await mobilePage.click('#signin-btn');
    await mobilePage.waitForSelector('#app.visible', { timeout: 10000 });
    await mobilePage.waitForSelector('.mission-banner', { timeout: 5000 });

    // Check if nav link is visible (not hidden under orb)
    const navVisible = await mobilePage.locator('a:has-text("ventures dashboard")').isVisible();
    results.mobileNavVisible = navVisible;
    console.log(`✓ Nav visible on mobile: ${navVisible}`);

    await mobilePage.screenshot({ path: 'apv-mobile-final.png', fullPage: false });
    console.log('✓ Mobile screenshot saved');

    await mobileCtx.close();

    // Summary
    console.log('\n=== TEST SUMMARY ===');
    console.log(`Hide button works: ${results.hideButtonWorks ? '✓' : '✗'}`);
    console.log(`Desktop nav clear: ${results.desktopNavClear ? '✓' : '✗'}`);
    console.log(`Mobile nav visible: ${results.mobileNavVisible ? '✓' : '✗'}`);

    if (results.hideButtonWorks && results.desktopNavClear && results.mobileNavVisible) {
      console.log('\n✅ All blockers resolved!');
      process.exit(0);
    } else {
      console.log('\n⚠️  Some issues remain');
      process.exit(1);
    }
  } catch (err) {
    console.error('Test failed:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

test();
