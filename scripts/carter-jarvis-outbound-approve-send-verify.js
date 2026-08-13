'use strict';

// scripts/carter-jarvis-outbound-approve-send-verify.js
//
// Carter, 2026-08-13 — Playwright verification that the Jarvis Work Items
// "Content Approvals" Approve/Reject buttons for outbound_email items now
// actually work: Approve sends the row via Resend and clears it from the
// panel; Reject cancels it and clears it too. Neither used to do anything
// real (see api/jarvis-approve.js comment + commit e72c62e9).
//
// Uses two synthetic outbound_email_queue rows addressed to Heath's own
// inbox (heath.shepard@kw.com), backdated so they sort ahead of the 25 real
// cold-email-followup rows within the panel's top-25 fetch window. Does NOT
// touch any real prospect row.
//
// Run: cmd.exe /c "cd /d C:\Users\Heath\Projects\MeetDossie && node scripts\carter-jarvis-outbound-approve-send-verify.js"

const { launchQuinnContext, VIEWPORTS, assertSignedInAs } = require('./_lib/quinn-browser');

const STAGING_URL = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app/myjarvis';

(async () => {
  const context = await launchQuinnContext({ headless: true, viewport: VIEWPORTS.desktop, reason: 'carter-outbound-approve-send-verify' });
  const page = await context.newPage();
  try {
    await page.goto(STAGING_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await assertSignedInAs(page, 'heath.shepard@kw.com', { label: 'carter-outbound-approve-send-verify' });

    await page.waitForSelector('#pending-list', { timeout: 15000 });
    await page.waitForFunction(() => {
      const el = document.getElementById('pending-list');
      return el && !el.innerText.includes('Loading');
    }, { timeout: 20000 });
    await page.waitForTimeout(1000);

    // ===== TEST 1: APPROVE -> should actually send + disappear =====
    const approveCard = page.locator('.pending-card', { hasText: '[TEST] Jarvis Approve-Send verification' }).first();
    const approveCardCount = await approveCard.count();
    console.log('T1 - Approve test card found in panel:', approveCardCount > 0 ? 'PASS' : 'FAIL');
    if (approveCardCount === 0) {
      console.log('Full pending-list text:\n' + (await page.locator('#pending-list').innerText()).slice(0, 3000));
    }

    if (approveCardCount > 0) {
      const approveBtn = approveCard.locator('[data-act="approve"]');
      console.log('T2 - Approve button present:', (await approveBtn.count()) > 0 ? 'PASS' : 'FAIL');
      await approveBtn.click();
      await page.waitForTimeout(1500);

      // Toast should say "Approved" (not "Approve failed").
      const toastText = await page.locator('#toast').innerText().catch(() => '');
      console.log('Toast after Approve click:', JSON.stringify(toastText));
      console.log('T3 - toast shows success (not "failed"):', toastText.includes('Approved') && !toastText.toLowerCase().includes('failed') ? 'PASS' : 'FAIL');

      // Optimistic removal from DOM.
      const stillThereOptimistic = await page.locator('.pending-card', { hasText: '[TEST] Jarvis Approve-Send verification' }).count();
      console.log('T4 - card optimistically removed from DOM:', stillThereOptimistic === 0 ? 'PASS' : 'FAIL');

      // Wait for the background re-sync (setTimeout 1500ms) + a real full
      // reload — the actual bug was items REAPPEARING after a fresh fetch
      // because status never changed server-side. This is the real test.
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'networkidle' });
      await assertSignedInAs(page, 'heath.shepard@kw.com', { label: 'carter-outbound-approve-send-verify-reload1' });
      await page.waitForSelector('#pending-list', { timeout: 15000 });
      await page.waitForFunction(() => {
        const el = document.getElementById('pending-list');
        return el && !el.innerText.includes('Loading');
      }, { timeout: 20000 });
      await page.waitForTimeout(1000);
      const stillThereAfterReload = await page.locator('.pending-card', { hasText: '[TEST] Jarvis Approve-Send verification' }).count();
      console.log('T5 - card STAYS gone after full page reload (real DB state changed):', stillThereAfterReload === 0 ? 'PASS' : 'FAIL');
    }

    await page.screenshot({ path: 'scripts/atlas-runs/carter-outbound-approve-after.png', fullPage: false });

    // ===== TEST 2: REJECT -> should cancel + disappear, stay gone =====
    const rejectCard = page.locator('.pending-card', { hasText: '[TEST] Jarvis Reject verification' }).first();
    const rejectCardCount = await rejectCard.count();
    console.log('T6 - Reject test card found in panel:', rejectCardCount > 0 ? 'PASS' : 'FAIL');

    if (rejectCardCount > 0) {
      const rejectBtn = rejectCard.locator('[data-act="reject"]');
      console.log('T7 - Reject button present:', (await rejectBtn.count()) > 0 ? 'PASS' : 'FAIL');
      await rejectBtn.click();
      await page.waitForTimeout(500);
      // Reject opens a reply/reason panel per renderPending — submit it.
      const submitBtn = rejectCard.locator('[data-reply-submit]');
      if (await submitBtn.count() > 0) {
        const textarea = rejectCard.locator('[data-reply-input]');
        if (await textarea.count() > 0) await textarea.fill('Carter verification — not a real send, safe to cancel.');
        await submitBtn.click();
      }
      await page.waitForTimeout(1500);
      const toastText2 = await page.locator('#toast').innerText().catch(() => '');
      console.log('Toast after Reject click:', JSON.stringify(toastText2));

      await page.waitForTimeout(2000);
      await page.reload({ waitUntil: 'networkidle' });
      await assertSignedInAs(page, 'heath.shepard@kw.com', { label: 'carter-outbound-approve-send-verify-reload2' });
      await page.waitForSelector('#pending-list', { timeout: 15000 });
      await page.waitForFunction(() => {
        const el = document.getElementById('pending-list');
        return el && !el.innerText.includes('Loading');
      }, { timeout: 20000 });
      await page.waitForTimeout(1000);
      const stillThereAfterReload2 = await page.locator('.pending-card', { hasText: '[TEST] Jarvis Reject verification' }).count();
      console.log('T8 - reject card STAYS gone after full page reload:', stillThereAfterReload2 === 0 ? 'PASS' : 'FAIL');
    }

    await page.screenshot({ path: 'scripts/atlas-runs/carter-outbound-reject-after.png', fullPage: false });

    console.log('\nDONE');
  } finally {
    await context.close();
  }
})().catch((err) => {
  console.error('VERIFY SCRIPT ERROR:', err && err.stack || err);
  process.exit(1);
});
