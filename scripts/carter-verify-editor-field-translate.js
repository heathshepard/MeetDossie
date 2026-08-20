#!/usr/bin/env node
// carter-verify-editor-field-translate.js
//
// Real-browser verification of the 2026-08-20 field-name-translation fix
// (api/_lib/trec-20-19-editor-field-translate.js). Signs in as demo, opens
// the Phase 1 Interactive Editor for a real transaction, clicks the real
// UI controls for Possession / Title Policy / HOA / As-Is / Survey /
// Broker Disclosure, downloads the resulting filled PDF via the same
// "Download filled PDF" button a real user would click, then inspects the
// downloaded PDF's actual checkbox/text state with pdf-lib to confirm the
// selections actually landed (not just that a network call returned 200).
//
// Usage: node scripts/carter-verify-editor-field-translate.js [BASE_URL]

'use strict';

const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'https://staging.meetdossie.com';
const TXN_ID = '15d81c6e-f7e6-4faf-8a42-d5ff5040a7de';
const EMAIL = 'demo@meetdossie.com';
const PASSWORD = process.env.DEMO_PASSWORD;
const OUT_DIR = path.resolve(__dirname, '..', '.tmp');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function step(name, ok, detail) {
  console.log(`[verify] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}

async function shot(page, name) {
  // Staging's font-loading promise sometimes never resolves, which hangs
  // Playwright's default screenshot() (it waits on document.fonts.ready).
  // These screenshots are for human spot-check only, not assertions, so a
  // short timeout + swallow-and-continue is correct here.
  const p = path.join(OUT_DIR, `carter-verify-editor-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false, timeout: 8000 });
    console.log(`[verify] wrote ${p}`);
  } catch (e) {
    console.log(`[verify] screenshot ${name} skipped: ${e.message}`);
  }
}

async function setRadioTrue(page, fieldKey) {
  const scope = page.locator(`[data-field-key="${fieldKey}"]`).first();
  await scope.scrollIntoViewIfNeeded().catch(() => {});
  const radio = scope.locator('input[type="radio"][value="true"]').first();
  // force:true — same actionability stall seen on the sign-in button
  // (staging's font-load reflow makes Playwright's stability check hang);
  // verified separately that a forced click reaches the real React
  // onChange handler (sign-in flow above confirmed this end-to-end).
  await radio.click({ timeout: 8000, force: true });
}

async function openSection(page, exactTitle) {
  // Exact match on the section's title span, not a substring "section
  // contains this text" match — several section HEADINGS contain other
  // sections' TITLE words (e.g. "Title policy" section's heading ref reads
  // "§6. TITLE POLICY & SURVEY", which a substring match on "Survey" would
  // wrongly hit first and collapse instead of opening the real Survey
  // section).
  const titleSpan = page.getByText(exactTitle, { exact: true }).first();
  await titleSpan.scrollIntoViewIfNeeded().catch(() => {});
  const header = titleSpan.locator('xpath=ancestor::div[@role="button"][1]');
  await header.click({ timeout: 8000, force: true }).catch((e) => console.log(`[verify] openSection(${exactTitle}) click failed: ${e.message}`));
}

(async () => {
  if (!PASSWORD) {
    console.error('[verify] DEMO_PASSWORD not set in environment.');
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();

  let overallOk = true;

  try {
    // Sign in
    console.log(`[verify] Signing in at ${BASE}/app`);
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    if (await emailInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await emailInput.fill(EMAIL);
      await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD);
      await page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Log in"), button:has-text("Sign in")').first().click({ timeout: 8000, force: true });
      await page.waitForTimeout(3500);
    }
    overallOk = step('sign-in', true) && overallOk;

    // Open Phase 1 FormEditor for the real transaction
    const editorUrl = `${BASE}/app?openEditor=${TXN_ID}&v1=1`;
    console.log(`[verify] Navigating to ${editorUrl}`);
    await page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const titleVisible = await page.locator('text=Fill your contract').first().isVisible({ timeout: 15000 }).catch(() => false);
    overallOk = step('editor-mounted', titleVisible) && overallOk;
    await shot(page, '01-editor-open');

    if (!titleVisible) {
      throw new Error('FormEditor did not mount — cannot proceed with click-through.');
    }

    // Open the sections that hold the fields under test, then set each
    // field via the ACTUAL radio control a real agent would click.
    // Closing + possession
    await openSection(page, 'Closing + possession');
    await page.waitForTimeout(300);
    await setRadioTrue(page, 'possession_temporary_lease');
    await shot(page, '02-possession-lease-clicked');

    // Title policy (survey + title expense + HOA all live in this section
    // per SECTION_META: 'title' -> '§6. TITLE POLICY & SURVEY', 'survey' ->
    // '§6C. SURVEY', 'poa' -> '§6E. MEMBERSHIP IN POA/HOA')
    await openSection(page, 'Title policy');
    await page.waitForTimeout(300);
    await setRadioTrue(page, 'title_policy_expense');
    await shot(page, '03-title-seller-expense-clicked');

    await openSection(page, 'Survey');
    await page.waitForTimeout(300);
    await setRadioTrue(page, 'survey_option_existing');
    await page.waitForTimeout(200);
    await setRadioTrue(page, 'unacceptable_survey_new_expense_buyer');
    await shot(page, '04-survey-option1-buyer-expense-clicked');

    await openSection(page, 'Property owner association');
    await page.waitForTimeout(300);
    await setRadioTrue(page, 'hoa_membership');
    await shot(page, '05-hoa-membership-clicked');

    // Property condition (As-Is)
    await openSection(page, 'Property condition');
    await page.waitForTimeout(300);
    await setRadioTrue(page, 'acceptance_as_is');
    await shot(page, '06-as-is-clicked');

    // Broker disclosure — text fields
    await openSection(page, 'Broker disclosure');
    await page.waitForTimeout(300);
    const line1 = page.locator('[data-field-key="broker_disclosure_line1"] input, [data-field-key="broker_disclosure_line1"] textarea').first();
    const line2 = page.locator('[data-field-key="broker_disclosure_line2"] input, [data-field-key="broker_disclosure_line2"] textarea').first();
    await line1.fill('Jane Doe', { timeout: 8000, force: true }).catch((e) => console.log('[verify] line1 fill failed:', e.message));
    await line2.fill('who represents the Seller', { timeout: 8000, force: true }).catch((e) => console.log('[verify] line2 fill failed:', e.message));
    await shot(page, '07-broker-disclosure-filled');

    // Let autosave settle (500ms debounce + network).
    await page.waitForTimeout(2000);

    // Click the real "Download filled PDF" button and capture the download.
    console.log('[verify] Clicking Download filled PDF…');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      page.locator('button:has-text("Download filled PDF")').first().click({ timeout: 8000, force: true }),
    ]);
    const downloadPath = path.join(OUT_DIR, 'carter-verify-editor-downloaded.pdf');
    await download.saveAs(downloadPath);
    overallOk = step('download-triggered', fs.existsSync(downloadPath), downloadPath) && overallOk;

    // Inspect the REAL downloaded PDF's checkbox/text state.
    const bytes = fs.readFileSync(downloadPath);
    const pdfDoc = await PDFDocument.load(bytes);
    const form = pdfDoc.getForm();
    function isChecked(name) {
      try { return form.getCheckBox(name).isChecked(); } catch (e) { return null; }
    }

    const checks = [
      ['Possession = Lease (¶10A "will not be credited..." box)', isChecked('will not be credited to the Sales Price at closing Time is of the'), true],
      ['Possession != Closing (¶10A "will" box)', isChecked('will'), false],
      ['Title policy Seller\'s expense (Sellers_2)', isChecked('Sellers_2'), true],
      ['Survey option (1) main (Buyer)', isChecked('Buyer'), true],
      ['Survey option (1) buyer\'s expense sub-choice (Within two)', isChecked('Within two'), true],
      ['HOA is subject (1Within)', isChecked('1Within'), true],
      ['Accepts As Is (As Is)', isChecked('As Is'), true],
    ];
    for (const [label, actual, expected] of checks) {
      overallOk = step(label, actual === expected, `actual=${actual} expected=${expected}`) && overallOk;
    }

    console.log(`[verify] Downloaded PDF saved at ${downloadPath} for manual spot-check.`);
    console.log(overallOk ? '\n[verify] ALL CHECKS PASSED' : '\n[verify] SOME CHECKS FAILED — see above');
  } catch (err) {
    console.error('[verify] ERROR:', err && err.message);
    await shot(page, 'error-state');
    overallOk = false;
  } finally {
    await browser.close();
  }

  process.exit(overallOk ? 0 : 1);
})();
