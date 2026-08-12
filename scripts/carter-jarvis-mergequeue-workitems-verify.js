'use strict';

// scripts/carter-jarvis-mergequeue-workitems-verify.js
//
// Carter, 2026-08-12 — Playwright verification for two jarvis-pwa.html fixes:
//   1. Merge Queue panel now only shows quinn_qa_status='pass' rows, with a
//      single clean MERGE button (no more permanent "Waiting on ..." / "MERGE
//      ANYWAY").
//   2. Work Items "Ask Detail"/"Details" buttons now render real pending
//      email content instead of doing nothing.
//
// Run: cmd.exe /c "cd /d C:\Users\Heath\Projects\MeetDossie && node scripts\carter-jarvis-mergequeue-workitems-verify.js"

const { launchQuinnContext, VIEWPORTS, assertSignedInAs } = require('./_lib/quinn-browser');

const STAGING_URL = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app/myjarvis';

(async () => {
  const context = await launchQuinnContext({ headless: true, viewport: VIEWPORTS.desktop, reason: 'carter-mergequeue-workitems-verify' });
  const page = await context.newPage();
  try {
    await page.goto(STAGING_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await assertSignedInAs(page, 'heath.shepard@kw.com', { label: 'carter-mergequeue-workitems-verify' });

    // Give the panels time to fetch + render (30s poll intervals, first load
    // fires immediately but async).
    await page.waitForTimeout(4000);

    // ===== FIX 1: MERGE QUEUE =====
    await page.waitForSelector('#merge-queue-list', { timeout: 15000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('merge-queue-list');
      return el && !el.innerText.includes('Loading');
    }, { timeout: 20000 });

    const mergeQueueHtml = await page.locator('#merge-queue-list').innerHTML();
    const mergeQueueText = await page.locator('#merge-queue-list').innerText();
    console.log('--- merge-queue-list text ---\n' + mergeQueueText.slice(0, 1500));

    const hasReadyTestRow = mergeQueueText.includes('Carter QA test: ready to merge');
    const hasNotRunTestRow = mergeQueueText.includes('Carter QA test: not yet verified');
    const hasWaitingOn = mergeQueueText.includes('Waiting on');
    const hasMergeAnyway = mergeQueueHtml.includes('MERGE ANYWAY') || mergeQueueHtml.includes('merge-anyway');
    const hasSignoffBadges = mergeQueueHtml.includes('signoff-badge');

    console.log('FIX1 T1 - ready(pass) test row visible:', hasReadyTestRow ? 'PASS' : 'FAIL');
    console.log('FIX1 T2 - not_run test row HIDDEN:', !hasNotRunTestRow ? 'PASS' : 'FAIL');
    console.log('FIX1 T3 - no "Waiting on" text anywhere in panel:', !hasWaitingOn ? 'PASS' : 'FAIL');
    console.log('FIX1 T4 - no "MERGE ANYWAY" / merge-anyway class anywhere:', !hasMergeAnyway ? 'PASS' : 'FAIL');
    console.log('FIX1 T5 - no signoff badges rendered:', !hasSignoffBadges ? 'PASS' : 'FAIL');

    // Confirm the visible test row has exactly one clean "MERGE" button.
    const readyRowLocator = page.locator('.merge-queue-item', { hasText: 'Carter QA test: ready to merge' });
    const readyRowCount = await readyRowLocator.count();
    console.log('FIX1 T6 - exactly one ready-row rendered:', readyRowCount === 1 ? 'PASS' : `FAIL (count=${readyRowCount})`);
    if (readyRowCount === 1) {
      const btnText = (await readyRowLocator.locator('.merge-btn').allInnerTexts()).map((t) => t.trim());
      console.log('FIX1 T7 - button label(s) on ready row:', JSON.stringify(btnText), btnText.length === 1 && btnText[0] === 'MERGE' ? 'PASS' : 'FAIL');
    }

    await page.screenshot({ path: 'scripts/atlas-runs/carter-mergequeue-panel-verify.png', fullPage: false });

    // ===== FIX 2: WORK ITEMS — ASK DETAIL / DETAILS =====
    await page.waitForSelector('#pending-list', { timeout: 15000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('pending-list');
      return el && !el.innerText.includes('Loading');
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const pendingText = await page.locator('#pending-list').innerText();
    console.log('\n--- pending-list text (first 800 chars) ---\n' + pendingText.slice(0, 800));

    // Find the real cold-email-followup card (subject "quick follow-up").
    const emailCard = page.locator('.pending-card', { hasText: 'quick follow-up' }).first();
    const emailCardCount = await emailCard.count();
    console.log('FIX2 T1 - real "quick follow-up" pending card found:', emailCardCount > 0 ? 'PASS' : 'FAIL');

    if (emailCardCount > 0) {
      const askBtn = emailCard.locator('[data-act="ask-detail"]');
      const askBtnCount = await askBtn.count();
      console.log('FIX2 T2 - Ask Detail button present on card:', askBtnCount > 0 ? 'PASS' : 'FAIL');

      if (askBtnCount > 0) {
        await askBtn.click();
        await page.waitForTimeout(800);
        const modalVisible = await page.locator('.pending-modal').count();
        console.log('FIX2 T3 - modal opened after Ask Detail click:', modalVisible > 0 ? 'PASS' : 'FAIL');

        if (modalVisible > 0) {
          const modalBody = await page.locator('.pending-modal-body').innerText();
          console.log('--- modal body (first 1000 chars) ---\n' + modalBody.slice(0, 1000));
          const hasRecipient = /To:\s*\S+@\S+/.test(modalBody);
          const hasSubject = modalBody.includes('Subject:');
          const hasRealBody = modalBody.includes('per file for TC work') || modalBody.includes('Dossie because I was tired');
          console.log('FIX2 T4 - modal shows recipient email:', hasRecipient ? 'PASS' : 'FAIL');
          console.log('FIX2 T5 - modal shows subject line:', hasSubject ? 'PASS' : 'FAIL');
          console.log('FIX2 T6 - modal shows real email body text:', hasRealBody ? 'PASS' : 'FAIL');

          await page.screenshot({ path: 'scripts/atlas-runs/carter-workitems-ask-detail-modal.png', fullPage: false });

          await page.locator('.pending-modal [data-act="close"]').click();
          await page.waitForTimeout(400);
        }
      }

      // Also verify the "Details" button independently opens the same content.
      const detailsBtn = emailCard.locator('[data-act="details"]');
      if (await detailsBtn.count() > 0) {
        await detailsBtn.click();
        await page.waitForTimeout(800);
        const modalBody2 = await page.locator('.pending-modal-body').innerText().catch(() => '');
        const hasRealBody2 = modalBody2.includes('per file for TC work');
        console.log('FIX2 T7 - "Details" button also shows real email body:', hasRealBody2 ? 'PASS' : 'FAIL');
        await page.screenshot({ path: 'scripts/atlas-runs/carter-workitems-details-modal.png', fullPage: false });
        const closeBtn = page.locator('.pending-modal [data-act="close"]');
        if (await closeBtn.count() > 0) await closeBtn.click();
      }
    }

    console.log('\nDONE');
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('VERIFY SCRIPT ERROR:', err && err.stack || err);
  process.exit(1);
});
