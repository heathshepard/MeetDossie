import { chromium } from 'playwright';

const STAGING_URL = 'https://meet-dossie-qcpnl7bs7-heathshepard-6590s-projects.vercel.app/today';
const EMAIL = 'heath.shepard@kw.com';
const PASSWORD = 'Jarvis2026!';

async function test() {
  const browser = await chromium.launch();

  try {
    console.log('=== Testing Hide button functionality ===');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    // Capture all console messages
    page.on('console', msg => {
      console.log(`[${msg.type().toUpperCase()}] ${msg.text()}`);
    });

    // Capture all network responses
    page.on('response', resp => {
      if (resp.url().includes('heath_todo')) {
        console.log(`[NETWORK] ${resp.request().method()} ${resp.url()} -> ${resp.status()}`);
      }
    });

    await page.goto(STAGING_URL);
    await page.waitForSelector('#signin-email', { timeout: 5000 });

    // Sign in
    console.log('Signing in...');
    await page.fill('#signin-email', EMAIL);
    await page.fill('#signin-password', PASSWORD);
    await page.click('#signin-btn');
    await page.waitForSelector('#app.visible', { timeout: 10000 });
    console.log('✓ Signed in');

    // Wait for todos
    await page.waitForSelector('#todo-list', { timeout: 5000 });
    const todoItems = await page.locator('.todo-item').count();
    console.log(`✓ Found ${todoItems} todo items`);

    if (todoItems > 0) {
      // Click Hide button
      console.log('Clicking Hide button...');
      const hideBtn = await page.locator('.todo-action-btn[data-action="hide"]').first();
      await hideBtn.click();

      // Wait and check toast
      await page.waitForTimeout(1000);
      const toastText = await page.locator('#toast').textContent();
      const toastClass = await page.locator('#toast').getAttribute('class');
      console.log(`Toast: "${toastText}" (class: ${toastClass})`);
    }

    await ctx.close();
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

test();
