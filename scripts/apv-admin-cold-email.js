#!/usr/bin/env node
// scripts/apv-admin-cold-email.js
//
// Re-APV for Carter's fixes (commit 06320d46):
//   Bug 1: admin-cold-email.html line 477 — getAuthToken reads
//          'supabase.auth.token' (correct) instead of sb-...-auth-token.
//   Bug 2: api/resend-webhook.js — now fail-closed (503 missing secret,
//          401 bad signature, 200 only after verified insert).
//
// Test plan:
//   PART A (bug 1): sign in as demo on staging, navigate to
//     /admin-cold-email.html, confirm dashboard loads (no redirect loop
//     to /app.html), aggregate/campaign/recipient sections render,
//     capture screenshot.
//
//   PART B (bug 2): POST /api/resend-webhook with no signature header
//     and expect 503 (RESEND_WEBHOOK_SECRET not set on staging). If 503
//     is observed -> webhook is fail-closed as required. Capture
//     response JSON.
//
// Usage:
//   node scripts/apv-admin-cold-email.js https://meet-dossie-phjiudgw7-...vercel.app
//
// Exit 0 = PASS. Exit 1 = FAIL.

"use strict";

const { chromium } = require("playwright");
const fs = require("fs");

const baseArg = process.argv[2];
if (!baseArg) {
  console.error("Usage: node scripts/apv-admin-cold-email.js <BASE_URL>");
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, "");

const DEMO_EMAIL = "demo@meetdossie.com";
const DEMO_PASSWORD = "DossieDemo-VaIiAt6Bab";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err && err.message ? err.message : err));
  });

  const results = { bug1: { pass: false, notes: [] }, bug2: { pass: false, notes: [] } };

  try {
    // ========== PART A — BUG 1 ==========
    console.log(`[APV] Part A: sign in as demo`);
    await page.goto(`${BASE}/app.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);

    // Try to fill sign-in form
    const emailSel = 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    const passSel = 'input[type="password"], input[name="password"]';

    await page.waitForSelector(emailSel, { timeout: 15000 });
    await page.fill(emailSel, DEMO_EMAIL);
    await page.fill(passSel, DEMO_PASSWORD);

    // Find and click Sign In button
    const signInBtn = page.locator('button:has-text("Sign in"), button:has-text("Sign In"), button:has-text("SIGN IN"), button[type="submit"]').first();
    await signInBtn.click();

    // Wait for navigation/auth to settle
    await page.waitForTimeout(6000);

    // Verify auth token is in localStorage under expected key
    const tokenCheck = await page.evaluate(() => {
      const tok = window.localStorage.getItem("supabase.auth.token");
      return { hasToken: !!tok, len: tok ? tok.length : 0 };
    });
    console.log(`[APV] Token in localStorage: ${JSON.stringify(tokenCheck)}`);
    if (!tokenCheck.hasToken) {
      results.bug1.notes.push(`sign-in did not set supabase.auth.token in localStorage`);
    }

    // Navigate to admin-cold-email
    console.log(`[APV] Navigating to /admin-cold-email.html`);
    await page.goto(`${BASE}/admin-cold-email.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    console.log(`[APV] After nav, URL = ${finalUrl}`);

    if (finalUrl.includes("app.html")) {
      results.bug1.notes.push(`REDIRECTED back to ${finalUrl} — auth token not detected`);
    } else {
      results.bug1.notes.push(`Stayed on admin page: ${finalUrl}`);
    }

    // Check what's visible: loading state vs dashboard vs error
    const visibility = await page.evaluate(() => {
      const get = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const style = window.getComputedStyle(el);
        return { display: style.display, visible: style.display !== "none" };
      };
      return {
        loading: get("loading"),
        dashboard: get("dashboard"),
        error: get("error"),
        errorText: document.getElementById("error")?.innerText || null,
        totalSent: document.getElementById("total-sent")?.innerText || null,
        url: window.location.href,
      };
    });
    console.log(`[APV] Visibility: ${JSON.stringify(visibility, null, 2)}`);
    results.bug1.notes.push(`Dashboard state: ${JSON.stringify(visibility)}`);

    // Capture screenshot regardless
    const shot1 = "apv-bug1-admin-cold-email-load.png";
    await page.screenshot({ path: shot1, fullPage: true });
    console.log(`[APV] Screenshot: ${shot1}`);

    // PASS criteria: did not redirect to app.html AND dashboard is visible (no error)
    if (!finalUrl.includes("app.html") && visibility.dashboard?.visible) {
      results.bug1.pass = true;
    }
  } catch (err) {
    results.bug1.notes.push(`EXCEPTION: ${err.message}`);
    console.error(`[APV] Part A exception:`, err);
  }

  // ========== PART B — BUG 2 ==========
  try {
    console.log(`[APV] Part B: POST /api/resend-webhook with NO signature`);
    const webhookRes = await page.evaluate(async (base) => {
      try {
        const res = await fetch(`${base}/api/resend-webhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "email.delivered", data: { id: "test", to: "test@example.com", created_at: new Date().toISOString() } }),
        });
        const text = await res.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        return { status: res.status, body };
      } catch (err) {
        return { error: err.message };
      }
    }, BASE);

    console.log(`[APV] Webhook (no sig) response: ${JSON.stringify(webhookRes)}`);
    results.bug2.notes.push(`No-signature POST: ${JSON.stringify(webhookRes)}`);

    // Save response for evidence
    fs.writeFileSync("apv-bug2-webhook-no-sig.json", JSON.stringify(webhookRes, null, 2));

    // Expected: 503 (RESEND_WEBHOOK_SECRET missing) OR 401 (secret set but no header)
    if (webhookRes.status === 503) {
      results.bug2.pass = true;
      results.bug2.notes.push(`PASS: 503 returned — fail-closed when secret missing`);
    } else if (webhookRes.status === 401) {
      results.bug2.pass = true;
      results.bug2.notes.push(`PASS: 401 returned — fail-closed when signature missing (secret IS set in env)`);
    } else if (webhookRes.status === 200) {
      results.bug2.pass = false;
      results.bug2.notes.push(`FAIL: 200 returned — webhook is NOT fail-closed (still bug 2)`);
    } else {
      results.bug2.notes.push(`Unexpected status ${webhookRes.status}`);
    }
  } catch (err) {
    results.bug2.notes.push(`EXCEPTION: ${err.message}`);
    console.error(`[APV] Part B exception:`, err);
  }

  await browser.close();

  // ========== REPORT ==========
  console.log("\n========== APV RESULTS ==========");
  console.log(`Bug 1 (admin-cold-email auth): ${results.bug1.pass ? "PASS" : "FAIL"}`);
  results.bug1.notes.forEach(n => console.log(`  - ${n}`));
  console.log(`\nBug 2 (resend-webhook fail-closed): ${results.bug2.pass ? "PASS" : "FAIL"}`);
  results.bug2.notes.forEach(n => console.log(`  - ${n}`));
  console.log(`\nConsole errors during run: ${consoleErrors.length}`);
  consoleErrors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
  console.log(`Page errors during run: ${pageErrors.length}`);
  pageErrors.slice(0, 10).forEach(e => console.log(`  - ${e}`));

  const overall = results.bug1.pass && results.bug2.pass;
  console.log(`\nOVERALL: ${overall ? "PASS" : "FAIL"}`);

  fs.writeFileSync("apv-recold-email-results.json", JSON.stringify({ results, consoleErrors, pageErrors, overall }, null, 2));

  process.exit(overall ? 0 : 1);
})().catch(err => {
  console.error("[APV] Fatal:", err);
  process.exit(1);
});
