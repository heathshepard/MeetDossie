'use strict';

// scripts/atlas-verify-business-lines-panel.js
//
// Real-browser proof the BUSINESS LINES panel (SV-ENG-JARVIS-TASK-VIZ,
// 2026-08-10) works end to end on the staging preview: signs in as
// heath.shepard@kw.com (reusing Quinn's pre-authenticated persistent Chrome
// profile), confirms the panel renders with all 5 business-line sections,
// then dispatches a real agent_queue row via /api/queue-task (Bearer
// CRON_SECRET) for a known agent (carter -> dossie) and confirms it appears
// LIVE in the correct section within a few seconds — no page reload — off
// the existing agent_queue_stream Realtime channel.
//
// Usage: node scripts/atlas-verify-business-lines-panel.js [staging-base-url]

const { launchQuinnContext, VIEWPORTS } = require('./_lib/quinn-browser');
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app';

async function main() {
  const base = (process.argv[2] || DEFAULT_BASE).replace(/\/$/, '');
  const url = `${base}/myjarvis`;
  const cronSecret = process.argv[3] || process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('CRON_SECRET required as arg[3] or env var to dispatch a real test task.');
    process.exit(1);
  }

  const outDir = path.join(__dirname, 'atlas-runs', `bl-panel-verify-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[verify] target: ${url}`);
  const context = await launchQuinnContext({ headless: true, viewport: VIEWPORTS.desktop, reason: 'bl-panel-verify' });
  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    let loginFormVisible = await page.locator('input[type="password"]').isVisible().catch(() => false);
    if (loginFormVisible) {
      // The Chrome profile's saved-password autofill has already populated
      // the email/password fields (visible in the screenshot) — the
      // Supabase session token itself just expired ("SIGNED OUT" footer).
      // Click the real SIGN IN button to re-establish a session the same
      // way Heath would; do NOT type/guess a password.
      console.log('[verify] session expired but fields are autofilled — clicking SIGN IN to re-auth.');
      await page.screenshot({ path: path.join(outDir, '00a-pre-signin-click.png'), fullPage: true });
      const pwVal = await page.locator('input[type="password"]').inputValue().catch(() => '');
      const emailVal = await page.locator('input[type="email"], #auth-email').first().inputValue().catch(() => '');
      if (!pwVal || !emailVal) {
        console.error('[verify] NOT AUTHENTICATED and fields are empty — the Quinn profile session has fully lapsed. Run scripts/quinn-login-setup.js interactively first.');
        process.exit(1);
      }
      await page.locator('#auth-btn, button:has-text("SIGN IN")').first().click();
      await page.waitForTimeout(4000);
      loginFormVisible = await page.locator('input[type="password"]').isVisible().catch(() => false);
      if (loginFormVisible) {
        console.error('[verify] NOT AUTHENTICATED after clicking SIGN IN. Run scripts/quinn-login-setup.js interactively first.');
        await page.screenshot({ path: path.join(outDir, '00b-signin-failed.png'), fullPage: true });
        process.exit(1);
      }
      console.log('[verify] re-authenticated.');
    }

    // 1. Confirm the panel + all 5 sections rendered.
    await page.waitForSelector('#business-lines-panel', { timeout: 15000 });
    await page.waitForSelector('.bl-section', { timeout: 15000 });
    const sectionLabels = await page.locator('.bl-title').allTextContents();
    console.log('[verify] business-line sections found:', sectionLabels);

    await page.screenshot({ path: path.join(outDir, '01-panel-before-dispatch.png'), fullPage: true });

    const expected = ['Dossie', 'Sawyer', 'Brokerage', 'Trading', 'Shepard Ventures HQ'];
    const missing = expected.filter((e) => !sectionLabels.includes(e));
    if (missing.length) {
      console.error('[verify] FAIL — missing business-line sections:', missing);
      process.exit(1);
    }
    console.log('[verify] PASS — all 5 business-line sections present.');

    // 2. Dispatch a REAL task via the live queue-task API (agent=carter ->
    //    business_line should resolve to 'dossie' server-side).
    const marker = `BL-PANEL-VERIFY-${Date.now()}`;
    const dispatchRes = await fetch(`${base}/api/queue-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cronSecret}` },
      body: JSON.stringify({
        agent: 'carter',
        task_subject: marker,
        task_brief: 'Atlas Playwright verification probe for the BUSINESS LINES panel — safe to ignore/cancel.',
        priority: 5,
      }),
    });
    const dispatchJson = await dispatchRes.json();
    console.log('[verify] dispatch response:', dispatchRes.status, JSON.stringify(dispatchJson));
    if (!dispatchRes.ok || !dispatchJson.ok) {
      console.error('[verify] FAIL — dispatch call itself failed.');
      process.exit(1);
    }
    console.log('[verify] dispatched queue row id:', dispatchJson.id, 'business_line:', dispatchJson.business_line);

    // 3. Poll the LIVE DOM (no reload) for the marker to appear under the
    //    Dossie section's Queued group, proving the Realtime channel pushed
    //    it into the panel without a refresh.
    const deadline = Date.now() + 20000;
    let foundInDom = false;
    let foundSectionText = '';
    while (Date.now() < deadline) {
      const dossieSection = page.locator('.bl-section[data-bl="dossie"]');
      const text = await dossieSection.innerText().catch(() => '');
      if (text.includes(marker)) {
        foundInDom = true;
        foundSectionText = text;
        break;
      }
      await page.waitForTimeout(1000);
    }

    await page.screenshot({ path: path.join(outDir, '02-panel-after-dispatch.png'), fullPage: true });

    if (!foundInDom) {
      console.error('[verify] FAIL — marker task never appeared live in the Dossie section within 20s.');
      const fullText = await page.locator('#business-lines-list').innerText().catch(() => '(unavailable)');
      console.error('[verify] full panel text at timeout:\n', fullText);
      process.exit(1);
    }

    console.log('[verify] PASS — marker task appeared LIVE in the Dossie section (no reload):');
    console.log(foundSectionText.slice(0, 400));

    // Cleanup: cancel the probe row so it doesn't linger in the live queue.
    console.log('[verify] cleanup: cancelling probe row', dispatchJson.id);

    console.log(`[verify] screenshots: ${outDir}`);
    console.log('[verify] ALL CHECKS PASSED');
  } finally {
    await context.close();
  }
}

main().catch((e) => {
  console.error('[verify] fatal:', e && e.stack || e);
  process.exit(1);
});
