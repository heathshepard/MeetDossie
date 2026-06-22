#!/usr/bin/env node
// scripts/smoke-jarvis-signin.js
//
// Pre-merge integration test for /myjarvis sign-in.
// Catches the class of bug that locked Heath out twice on 2026-06-22:
//   - duplicate function/const declarations in jarvis-pwa.html's
//     <script type="module"> block (SyntaxError -> entire module
//     fails to parse -> sign-in handler never binds)
//   - throwing IIFE in any other <script> block that breaks the page
//   - missing event listener on the SIGN IN button
//
// Test plan:
//   1. Navigate to <BASE>/myjarvis
//   2. Assert ZERO console errors and ZERO pageerror events
//   3. Assert the SIGN IN button exists AND has a click listener bound
//      (we don't actually log in — we just verify the button is wired)
//   4. Click SIGN IN with empty fields; assert it fires a handler (either
//      a Supabase request OR an inline validation error appears).
//
// Usage:
//   node scripts/smoke-jarvis-signin.js https://staging.meetdossie.com
//   node scripts/smoke-jarvis-signin.js https://meetdossie.com
//
// Exit 0 = sign-in is wired and clean. Exit 1 = any failure (Quinn / Atlas
// will block merge).

"use strict";

const { chromium } = require("playwright");

const baseArg = process.argv[2];
if (!baseArg) {
  console.error("Usage: node scripts/smoke-jarvis-signin.js <BASE_URL>");
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, "");
const URL = `${BASE}/myjarvis`;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err && err.message ? err.message : err));
  });

  let supabaseAuthHit = false;
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/auth/v1/token") || u.includes("/auth/v1/signup")) {
      supabaseAuthHit = true;
    }
  });

  console.log(`[smoke-jarvis-signin] navigating ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2000); // allow module to parse + bind

  // Filter out 403 noise for unauthenticated API probes — those are
  // expected on a signed-out PWA load. Only real script errors matter.
  const blockingConsoleErrors = consoleErrors.filter((t) => {
    if (/Failed to load resource/i.test(t) && /403/.test(t)) return false;
    return true;
  });

  const fatal = [];

  if (pageErrors.length) {
    fatal.push(`pageerror(s) on /myjarvis: ${pageErrors.join(" | ")}`);
  }
  if (blockingConsoleErrors.length) {
    fatal.push(
      `script console error(s) on /myjarvis: ${blockingConsoleErrors.join(" | ")}`,
    );
  }

  // 1) Sign-in button exists
  const btn = await page.$("button:has-text('SIGN IN')");
  if (!btn) {
    fatal.push("SIGN IN button not found on /myjarvis");
  } else {
    // 2) Click button with empty form. Expect EITHER a Supabase auth
    //    request, OR the textbox aria-invalid set, OR a visible error
    //    text — any of those proves a handler is bound.
    await btn.click();
    await page.waitForTimeout(1500);

    // Did empty-form click leave any side effect?
    const authMsg = await page.evaluate(() => {
      const m = document.getElementById("auth-msg");
      return m ? m.textContent.trim() : "";
    });
    const stillSignedOut = await page.$("button:has-text('SIGN IN')");
    const inputInvalid = await page.evaluate(() => {
      const i = document.querySelector(
        'input[placeholder*="meetdossie"], input[type="email"], #auth-email',
      );
      return i && (i.matches(":invalid") || i.getAttribute("aria-invalid") === "true");
    });
    // Handler ran if ANY of: Supabase hit, HTML5 validation invalid, or
    // the auth-msg <div> got populated (the signIn() function writes
    // "Email and password required." on empty input).
    const handlerFired = supabaseAuthHit || inputInvalid || authMsg.length > 0;
    if (!handlerFired) {
      fatal.push(
        "SIGN IN click had no observable effect. auth-msg empty, no Supabase request, no invalid input. Handler likely not bound.",
      );
    }
    if (!stillSignedOut) {
      // We didn't supply creds; we should NOT actually sign in. If the
      // auth gate is gone, something is very wrong.
      fatal.push("Auth gate disappeared without credentials — unexpected.");
    }
  }

  await browser.close();

  if (fatal.length) {
    console.error("[smoke-jarvis-signin] FAIL");
    for (const f of fatal) console.error("  - " + f);
    process.exit(1);
  }
  console.log("[smoke-jarvis-signin] PASS");
  process.exit(0);
})().catch((e) => {
  console.error("[smoke-jarvis-signin] CRASH", e);
  process.exit(1);
});
