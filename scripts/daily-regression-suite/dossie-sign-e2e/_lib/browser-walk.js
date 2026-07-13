/**
 * browser-walk.js — Playwright helpers for the Dossie Sign customer flow.
 *
 * Signs in as demo@meetdossie.com on the target base URL. Returns a
 * { browser, ctx, page, dispose } object. All navigation methods use the
 * live browser session — never direct API calls. That is the whole point of
 * this test suite (feedback_screen_recording_real_email_required_no_shortcuts).
 *
 * Environment:
 *   DEMO_EMAIL     — defaults to demo@meetdossie.com
 *   DEMO_PASSWORD  — required; falls back to hard-coded staging password
 *                    (DossieDemo-VaIiAt6Bab) if unset
 *   BASE_URL       — defaults to https://meetdossie.com
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const DEFAULT_EMAIL = process.env.DEMO_EMAIL || 'demo@meetdossie.com';
const DEFAULT_PASSWORD = process.env.DEMO_PASSWORD
  || process.env.APV_PASSWORD
  || 'DossieDemo-VaIiAt6Bab';
const DEFAULT_BASE = process.env.BASE_URL || 'https://meetdossie.com';

/**
 * Launch a fresh browser session, sign in as demo, and return the page.
 * If videoDir is provided, the browser context records video to that dir.
 */
async function makeSignedInSession({
  base = DEFAULT_BASE,
  email = DEFAULT_EMAIL,
  password = DEFAULT_PASSWORD,
  headless = true,
  videoDir = null,
  consoleErrors = null,
} = {}) {
  const browser = await chromium.launch({ headless });
  const contextOpts = {
    viewport: { width: 1600, height: 950 },
  };
  if (videoDir) {
    fs.mkdirSync(videoDir, { recursive: true });
    contextOpts.recordVideo = { dir: videoDir, size: { width: 1600, height: 950 } };
  }
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();

  if (consoleErrors) {
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (/favicon|google-analytics|gtag|chrome-extension|sourcemap|\.well-known/i.test(t)) return;
      consoleErrors.push({ t: Date.now(), text: t });
    });
    page.on('pageerror', (err) => {
      const t = String(err && err.message ? err.message : err);
      if (/favicon|google-analytics|gtag|chrome-extension|sourcemap|\.well-known/i.test(t)) return;
      consoleErrors.push({ t: Date.now(), text: t });
    });
  }

  // Sign in via the workspace login form.
  await page.goto(`${base}/workspace.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);

  const emailInput = await page.$('input[type="email"]');
  if (emailInput) await emailInput.fill(email);
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) await pwInput.fill(password);

  const signInBtn = await page.$('button[type="submit"], button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Sign In")');
  if (signInBtn) {
    await signInBtn.click();
  }
  // Wait for post-signin navigation. Workspace redirects to /workspace or
  // renders the main dashboard.
  await page.waitForTimeout(6000);

  // Dismiss any welcome overlay.
  await page.keyboard.press('Escape').catch(() => {});
  const closeX = await page.$('button[aria-label="Close"], [role="dialog"] button:has-text("×")');
  if (closeX) {
    await closeX.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  return {
    browser,
    ctx,
    page,
    async dispose() {
      try { await ctx.close(); } catch {}
      try { await browser.close(); } catch {}
    },
  };
}

/**
 * Ensure the demo user has a dossier with known test-data values that the
 * Interactive Editor + template flow can render. This does NOT create a new
 * row (transactions table has many NOT NULL columns with defaults + FK
 * dependencies). Instead we pick the FIRST existing dossier for the demo
 * user and PATCH it with our known test values, then return its id.
 *
 * That approach:
 *   - Doesn't collide with the seed script that already populated demo data
 *   - Doesn't leak sentinel rows that need cleanup
 *   - Guarantees the transaction has valid FKs for status/stage/checklist
 *
 * Values patched:
 *   property_address, buyer_name, seller_name, sale_price, closing_date,
 *   city_state_zip, county
 *
 * Returns { transactionId, propertyAddress, sentinel }.
 */
async function ensureTestTransaction({
  demoUserId = 'c29ce34c-1434-44e5-a260-8d1a45213ec3',
  supabaseUrl = process.env.SUPABASE_URL,
  serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  sentinel = `E2E-${Date.now()}`,
} = {}) {
  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to ensure a test transaction.');
  }
  // Fetch the first dossier for the demo user.
  const listRes = await fetch(
    `${supabaseUrl}/rest/v1/transactions?user_id=eq.${demoUserId}&select=id&order=created_at.asc&limit=1`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    }
  );
  if (!listRes.ok) {
    const text = await listRes.text().catch(() => '');
    throw new Error(`ensureTestTransaction list failed (${listRes.status}): ${text.slice(0, 300)}`);
  }
  const listRows = await listRes.json();
  if (!Array.isArray(listRows) || listRows.length === 0) {
    throw new Error(`No dossier exists for demo user ${demoUserId} — seed one first via seed-demo-docs.py.`);
  }
  const transactionId = listRows[0].id;
  const propertyAddress = `${sentinel} 100 Test Ln, San Antonio, TX 78209`;
  const patch = {
    property_address: propertyAddress,
    buyer_name: 'Alex Testbuyer',
    seller_name: 'Sam Testseller',
    sale_price: 525000,
    closing_date: '2026-08-15',
    city_state_zip: 'San Antonio, TX 78209',
    county: 'Bexar',
    // Financing data for 40-11 tests.
    loan_amount: 420000,
    down_payment: 105000,
  };
  const patchRes = await fetch(
    `${supabaseUrl}/rest/v1/transactions?id=eq.${transactionId}`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(patch),
    }
  );
  if (!patchRes.ok) {
    const text = await patchRes.text().catch(() => '');
    throw new Error(`ensureTestTransaction patch failed (${patchRes.status}): ${text.slice(0, 300)}`);
  }
  return { transactionId, propertyAddress, sentinel };
}

/**
 * Take a screenshot to the given path.
 */
async function screenshot(page, filePath, opts = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: filePath, fullPage: opts.fullPage || false }).catch(() => {});
  return filePath;
}

module.exports = {
  makeSignedInSession,
  ensureTestTransaction,
  screenshot,
  DEFAULT_BASE,
  DEFAULT_EMAIL,
  DEFAULT_PASSWORD,
};
