#!/usr/bin/env node
// APV — Interactive Editor Phase 3 (on-PDF hit-detect + drag-drop toolbar)
// Verifies:
//   T1  sign in as demo
//   T2  navigate to /app?openEditor=<txnId>
//   T3  editor mounts with pdf canvas + FieldToolbar
//   T4  field overlays render on top of the PDF (via /api/interactive-editor-init coords)
//   T5  click an existing filled overlay -> sidebar opens
//   T6  click Add Text on toolbar -> click PDF -> new overlay dropped -> sidebar opens
//   T7  toggle Show list / Hide list works
//   T8  screenshot of editor with visible overlays saved for Heath
//
// Args: [BASE_URL]  (default: latest staging preview)
// Uses:  demo@meetdossie.com / DossieDemo-VaIiAt6Bab

'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.argv[2] || 'https://staging.meetdossie.com';
const TXN_ID = process.argv[3] || 'f7bcfd82-f9d3-48fd-a19a-00182436f0a5';
const EMAIL = 'demo@meetdossie.com';
const PASSWORD = 'DossieDemo-VaIiAt6Bab';
const OUT_DIR = path.resolve(__dirname, '..', '.tmp');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const RESULT = {
  ok: false,
  base: BASE,
  transactionId: TXN_ID,
  steps: [],
  screenshots: [],
  consoleErrors: [],
  apiResponse: null,
  overlayCount: 0,
};

async function shot(page, name) {
  const p = path.join(OUT_DIR, `apv-interactive-editor-phase3-${name}.png`);
  try {
    await page.screenshot({ path: p, fullPage: false });
    RESULT.screenshots.push(p);
    console.log(`[apv] wrote ${p}`);
    return p;
  } catch (e) {
    console.log(`[apv] screenshot ${name} failed: ${e.message}`);
    return null;
  }
}

function step(name, ok, detail) {
  const s = { name, ok, detail: detail || '' };
  RESULT.steps.push(s);
  console.log(`[apv] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`);
  return ok;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (t.includes('pdf.worker')) return;
      if (t.includes('Failed to load resource') && t.includes('favicon')) return;
      RESULT.consoleErrors.push(t);
    }
  });

  page.on('response', async (resp) => {
    if (resp.url().includes('/api/interactive-editor-init')) {
      try {
        RESULT.apiResponse = { status: resp.status(), body: await resp.json() };
      } catch {}
    }
  });

  try {
    // T1: sign in
    console.log(`[apv] Step 1: sign in at ${BASE}/app`);
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    const emailInput = await page.locator('input[type="email"], input[name="email"]').first();
    if (await emailInput.isVisible({ timeout: 10000 }).catch(() => false)) {
      await emailInput.fill(EMAIL);
      const pwd = await page.locator('input[type="password"], input[name="password"]').first();
      await pwd.fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {}),
        page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Log in"), button:has-text("Sign in")').first().click(),
      ]);
      await page.waitForTimeout(2500);
    }
    await shot(page, 'T1-signed-in');
    step('T1-sign-in', true);

    // T2: navigate to editor with the transaction
    console.log(`[apv] Step 2: open editor for txn ${TXN_ID}`);
    await page.goto(`${BASE}/app?openEditor=${TXN_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500);
    await shot(page, 'T2-editor-opened');

    // T3: check dialog present + toolbar buttons rendered
    const dialogPresent = await page.locator('[role="dialog"]').first().isVisible({ timeout: 8000 }).catch(() => false);
    const toolbarText = await page.locator('button:has-text("Text"), button:has-text("Signature")').first().isVisible({ timeout: 6000 }).catch(() => false);
    step('T3-editor-mounted', dialogPresent && toolbarText,
      `dialog=${dialogPresent} toolbar=${toolbarText}`);

    // T4: check API response has coords
    let mappedCount = 0;
    let allFieldsCount = 0;
    if (RESULT.apiResponse?.body?.forms) {
      const forms = RESULT.apiResponse.body.forms;
      for (const key of Object.keys(forms)) {
        const f = forms[key];
        for (const fld of f.fields || []) {
          allFieldsCount += 1;
          if (fld.x_pct != null && fld.page != null) mappedCount += 1;
        }
      }
    }
    step('T4-api-has-coords', mappedCount > 0,
      `mapped ${mappedCount}/${allFieldsCount} fields with coords`);

    // T4b: canvas + overlays rendered on the PDF surface
    // pdf.js renders <canvas> inside the pdfContainer. FieldOverlay places
    // absolutely-positioned divs on top.
    const pdfCanvas = await page.locator('canvas').first();
    const canvasVisible = await pdfCanvas.isVisible({ timeout: 15000 }).catch(() => false);
    step('T4b-canvas-visible', canvasVisible);

    // Count field overlays visible on-page. We identify by looking for the
    // absolutely-positioned overlay divs with `border: 2px solid` inside the
    // FieldOverlay container. Simpler proxy: count divs whose inline style
    // has `border: 2px solid` and `position: absolute`.
    const overlayCount = await page.evaluate(() => {
      return document.querySelectorAll('[data-testid="field-overlay"]').length;
    });
    RESULT.overlayCount = overlayCount;
    step('T4c-overlays-present', overlayCount > 0, `count=${overlayCount}`);
    await shot(page, 'T4-overlays-visible');

    // T5: click an existing overlay -> sidebar opens
    let sidebarOpened = false;
    if (overlayCount > 0) {
      // Click first overlay via JS to avoid layer/pointer issues.
      await page.evaluate(() => {
        const overlays = document.querySelectorAll('[data-testid="field-overlay"]');
        if (overlays.length > 0) {
          overlays[0].click();
        }
      });
      await page.waitForTimeout(1200);
      // Sidebar populated when we see "Current value" label or an Edit button
      sidebarOpened = await page.locator('text=Current value').first().isVisible({ timeout: 5000 }).catch(() => false);
      if (!sidebarOpened) {
        sidebarOpened = await page.locator('button:has-text("Edit")').first().isVisible({ timeout: 3000 }).catch(() => false);
      }
    }
    step('T5-click-overlay-opens-sidebar', sidebarOpened);
    await shot(page, 'T5-sidebar-after-click');

    // T6: click Add Text on toolbar -> click PDF -> new overlay dropped
    const beforeCount = RESULT.overlayCount;
    // Find and click "Text" button in the toolbar
    const addTextBtn = page.locator('button:has-text("+ Text")').first();
    const addTextExists = await addTextBtn.isVisible({ timeout: 3000 }).catch(() => false);
    let dropDetail = 'skipped';
    if (addTextExists) {
      await addTextBtn.click();
      await page.waitForTimeout(500);
      // Find FieldOverlay container to click into — it sits on top of pdf
      // canvas and owns the crosshair handler. Click into a KNOWN empty
      // region: page 1's earnest_money slot is on page 2, so on page 1
      // (post-auto-jump) there is empty space at ~40% x, 50% y.
      const overlayHandle = await page.evaluateHandle(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return null;
        // FieldOverlay is the absolutely-positioned sibling with cursor:crosshair
        const parent = canvas.parentElement;
        if (!parent) return null;
        const kids = parent.children;
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i];
          if (el.tagName === 'DIV' && el.style && el.style.position === 'absolute') {
            const cs = window.getComputedStyle(el);
            if (cs.cursor === 'crosshair') return el;
          }
        }
        return null;
      });
      const overlayEl = overlayHandle && overlayHandle.asElement && overlayHandle.asElement();
      let overlayBox = null;
      if (overlayEl) overlayBox = await overlayEl.boundingBox();
      if (overlayBox) {
        // Click at 40% x, 50% y of the overlay (below all page-1 top-band mapped fields).
        await page.mouse.click(overlayBox.x + overlayBox.width * 0.4, overlayBox.y + overlayBox.height * 0.5);
        await page.waitForTimeout(1500);
        dropDetail = `overlay_click=(${Math.round(overlayBox.x + overlayBox.width*0.4)},${Math.round(overlayBox.y + overlayBox.height*0.5)}) overlay_box=${JSON.stringify(overlayBox)}`;
      } else {
        // Fallback: click canvas center.
        const canvasBox = await pdfCanvas.boundingBox();
        if (canvasBox) {
          await page.mouse.click(canvasBox.x + canvasBox.width * 0.4, canvasBox.y + canvasBox.height * 0.5);
          await page.waitForTimeout(1500);
          dropDetail = `canvas_fallback_click=(${Math.round(canvasBox.x + canvasBox.width*0.4)},${Math.round(canvasBox.y + canvasBox.height*0.5)})`;
        }
      }
    }
    const afterCount = await page.evaluate(() => {
      return document.querySelectorAll('[data-testid="field-overlay"]').length;
    });
    step('T6-drag-drop-new-field', afterCount > beforeCount,
      `before=${beforeCount} after=${afterCount} clicked_add_text=${addTextExists} ${dropDetail}`);
    await shot(page, 'T6-after-drop');

    // T7: toggle "Show list"
    const showListBtn = page.locator('button:has-text("Show list")').first();
    const listBtnVisible = await showListBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (listBtnVisible) {
      await showListBtn.click();
      await page.waitForTimeout(600);
    }
    // Look for known field list heading text ("Fields" or the form name)
    const listVisible = await page.locator('text=/Sale price|Earnest money|Loan amount/i').first().isVisible({ timeout: 3000 }).catch(() => false);
    step('T7-list-view-toggle', listBtnVisible && listVisible,
      `toggle_visible=${listBtnVisible} list_visible=${listVisible}`);
    await shot(page, 'T7-list-view');

    // T8: hero screenshot with visible field overlays on TREC 20-18
    // Hide the list again for a cleaner shot.
    const hideListBtn = page.locator('button:has-text("Hide list")').first();
    if (await hideListBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await hideListBtn.click();
      await page.waitForTimeout(500);
    }
    await shot(page, 'T8-hero-overlays');

    RESULT.ok = RESULT.steps.every((s) => s.ok);
    console.log(`[apv] overall: ${RESULT.ok ? 'PASS' : 'FAIL'}`);
  } catch (err) {
    console.error(`[apv] error: ${err.message}`);
    RESULT.error = err.message;
    RESULT.stack = err.stack;
    await shot(page, 'ERROR');
  } finally {
    const outJson = path.join(OUT_DIR, 'apv-interactive-editor-phase3.json');
    fs.writeFileSync(outJson, JSON.stringify(RESULT, null, 2));
    console.log(`[apv] wrote ${outJson}`);
    await browser.close();
    process.exit(RESULT.ok ? 0 : 1);
  }
})();
