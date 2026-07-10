"use strict";
// Playwright sign-in helper — signs in as demo user + closes any welcome overlay.
// Returns a { page, ctx, browser, consoleErrors, pageErrors } handle.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function shot(page, outDir, name) {
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  return p;
}

async function signIn(cfg) {
  const browser = await chromium.launch({ headless: cfg.headless });
  // Viewport must be >=1440 wide — the Talk to Dossie panel is a fixed side rail
  // that renders at x~1371 in production layout. 1280 clips it entirely and
  // Playwright refuses to click "outside viewport" elements.
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const requestLog = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/")) requestLog.push({ method: req.method(), url: u, ts: Date.now() });
  });

  const startUrl = `${cfg.base}/workspace.html`;
  console.log(`[signin] navigating ${startUrl}`);
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Fill sign-in form
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) await emailInput.fill(cfg.email);
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) await pwInput.fill(cfg.password);
  const signInBtn = await page.$('button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Sign In")');
  if (signInBtn) await signInBtn.click();
  await page.waitForTimeout(4500);

  // Dismiss any "New Dossier" welcome modal
  const closeX = await page.$('button[aria-label="Close"], [role="dialog"] button:has-text("×")');
  if (closeX) {
    await closeX.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  const shotPath = await shot(page, cfg.outDir, "T1-signed-in");
  return { browser, ctx, page, consoleErrors, pageErrors, requestLog, shotPath };
}

module.exports = { signIn, shot };
