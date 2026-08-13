'use strict';

// scripts/carter-jarvis-outbound-reject-verify.js
//
// Carter, 2026-08-13 — re-verifies the Reject fix after the first pass found
// the 'cancelled' status value violates outbound_email_queue's CHECK
// constraint (23514). Now writes 'skipped' instead. Uses the same synthetic
// [TEST] Jarvis Reject verification row (addressed to Heath's own inbox,
// never a real prospect).

const { launchQuinnContext, VIEWPORTS, assertSignedInAs } = require('./_lib/quinn-browser');

const STAGING_URL = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app/myjarvis';

(async () => {
  const context = await launchQuinnContext({ headless: true, viewport: VIEWPORTS.desktop, reason: 'carter-outbound-reject-verify' });
  const page = await context.newPage();
  try {
    await page.goto(STAGING_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await assertSignedInAs(page, 'heath.shepard@kw.com', { label: 'carter-outbound-reject-verify' });

    await page.waitForSelector('#pending-list', { timeout: 15000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('pending-list');
      return el && !el.innerText.includes('Loading');
    }, { timeout: 20000 });
    await page.waitForTimeout(1000);

    const rejectCard = page.locator('.pending-card', { hasText: '[TEST] Jarvis Reject verification' }).first();
    const rejectCardCount = await rejectCard.count();
    console.log('T1 - Reject test card found in panel:', rejectCardCount > 0 ? 'PASS' : 'FAIL');
    if (rejectCardCount === 0) {
      console.log((await page.locator('#pending-list').innerText()).slice(0, 2000));
      throw new Error('reject test card not found, aborting');
    }

    const rejectBtn = rejectCard.locator('[data-act="reject"]');
    console.log('T2 - Reject button present:', (await rejectBtn.count()) > 0 ? 'PASS' : 'FAIL');
    await rejectBtn.click();
    await page.waitForTimeout(500);

    const submitBtn = rejectCard.locator('[data-reply-submit]');
    const textarea = rejectCard.locator('[data-reply-input]');
    if (await textarea.count() > 0) await textarea.fill('Carter verification — not a real send, safe to cancel.');
    await submitBtn.click();
    await page.waitForTimeout(1500);

    const toastText = await page.locator('#toast').innerText().catch(() => '');
    console.log('Toast after Reject submit:', JSON.stringify(toastText));
    console.log('T3 - toast shows success (not "failed"):', /rejected/i.test(toastText) && !/failed/i.test(toastText) ? 'PASS' : 'FAIL');

    const stillThereOptimistic = await page.locator('.pending-card', { hasText: '[TEST] Jarvis Reject verification' }).count();
    console.log('T4 - card optimistically removed from DOM:', stillThereOptimistic === 0 ? 'PASS' : 'FAIL');

    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: 'networkidle' });
    await assertSignedInAs(page, 'heath.shepard@kw.com', { label: 'carter-outbound-reject-verify-reload' });
    await page.waitForSelector('#pending-list', { timeout: 15000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('pending-list');
      return el && !el.innerText.includes('Loading');
    }, { timeout: 20000 });
    await page.waitForTimeout(1000);
    const stillThereAfterReload = await page.locator('.pending-card', { hasText: '[TEST] Jarvis Reject verification' }).count();
    console.log('T5 - card STAYS gone after full page reload (real DB state changed):', stillThereAfterReload === 0 ? 'PASS' : 'FAIL');

    await page.screenshot({ path: 'scripts/atlas-runs/carter-outbound-reject-after.png', fullPage: false });
    console.log('\nDONE');
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('VERIFY SCRIPT ERROR:', err && err.stack || err);
  process.exit(1);
});
