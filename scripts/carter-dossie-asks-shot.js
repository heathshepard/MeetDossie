'use strict';

// Screenshot-only pass over the delivered "Dossie asks" feed. Read-only:
// no clicks, no typing, no state change. Used to hand Heath a picture of the
// live surface.
//
// Usage: node scripts/carter-dossie-asks-shot.js [base-url]

const fs = require('fs');
const path = require('path');
const { launchQuinnContext, VIEWPORTS, assertSignedInAs } = require('./_lib/quinn-browser');

const DEFAULT_BASE = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app';
const EXPECTED_EMAIL = 'heath.shepard@kw.com';
const OUT_DIR = path.join(__dirname, 'atlas-runs', `carter-dossie-asks-shot-${Date.now()}`);

(async () => {
  const base = (process.argv[2] || DEFAULT_BASE).replace(/\/$/, '');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const context = await launchQuinnContext({
    headless: true,
    viewport: VIEWPORTS.laptop,
    reason: 'carter-dossie-asks-shot',
  });
  const page = await context.newPage();
  try {
    await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const btn = page.locator('button:has-text("Sign In")').first();
    if (await btn.isVisible().catch(() => false)) {
      const email = page.locator('input[type="email"]').first();
      if (await email.isVisible().catch(() => false)) {
        const v = await email.inputValue().catch(() => '');
        if (!v) await email.fill(EXPECTED_EMAIL);
      }
      await btn.click();
      await page.waitForTimeout(6000);
    }
    await assertSignedInAs(page, EXPECTED_EMAIL, { label: 'carter-dossie-asks-shot' });
    await page.waitForSelector('[data-testid="dossie-asks"]', { timeout: 30000 });
    await page.waitForTimeout(1200);

    await page.screenshot({ path: path.join(OUT_DIR, 'desktop.png') });
    const card = page.locator('[data-testid="dossie-ask-card"]').first();
    await card.screenshot({ path: path.join(OUT_DIR, 'card.png') });

    await page.setViewportSize(VIEWPORTS.mobile);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT_DIR, 'mobile.png') });

    console.log('screenshots:', OUT_DIR);
  } finally {
    await context.close();
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
