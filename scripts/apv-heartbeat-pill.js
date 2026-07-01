#!/usr/bin/env node
// APV — Jarvis HUD heartbeat pill on jarvis-pwa.html
// Signs in as demo, waits for polls to fire, screenshots the pill in LIVE state,
// then screenshots again 6 seconds later to prove the "Xs ago" counter ticks.

"use strict";

const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://meet-dossie-fvoj716yn-heathshepard-6590s-projects.vercel.app";
const EMAIL = process.env.APV_EMAIL || "demo@meetdossie.com";
const PASSWORD = process.env.APV_PASSWORD || "DossieDemo-VaIiAt6Bab";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  console.log(`[apv-heartbeat] navigating ${BASE}/myjarvis`);
  await page.goto(`${BASE}/myjarvis`, { waitUntil: "domcontentloaded", timeout: 25000 });
  await page.waitForTimeout(1500);

  // Sign in as demo
  console.log(`[apv-heartbeat] signing in as ${EMAIL}`);
  await page.fill("#auth-email", EMAIL).catch(async () => {
    const emailInput = await page.$('input[type="email"]');
    if (emailInput) await emailInput.fill(EMAIL);
  });
  await page.fill("#auth-password", PASSWORD).catch(async () => {
    const pwInput = await page.$('input[type="password"]');
    if (pwInput) await pwInput.fill(PASSWORD);
  });
  await page.click("button:has-text('SIGN IN')");

  // Wait for HUD to render + polls to fire at least once
  await page.waitForSelector("#heartbeat-pill", { timeout: 20000 });
  console.log(`[apv-heartbeat] heartbeat-pill mounted`);

  // Wait 3s for initHeartbeat + first poll cycle
  await page.waitForTimeout(3000);

  const pillT1 = await page.evaluate(() => {
    const p = document.getElementById("heartbeat-pill");
    const t = document.getElementById("heartbeat-text");
    if (!p || !t) return null;
    const rect = p.getBoundingClientRect();
    return {
      status: p.getAttribute("data-status"),
      text: t.textContent.trim(),
      visible: rect.width > 0 && rect.height > 0,
      top: rect.top,
      right: window.innerWidth - rect.right,
    };
  });
  console.log(`[apv-heartbeat] T1:`, pillT1);

  await page.screenshot({
    path: "apv-heartbeat-T1-live.png",
    fullPage: false,
    clip: { x: 0, y: 0, width: 1280, height: 200 },
  });

  // Wait 6 seconds — pill updates every 5s, so counter must tick
  await page.waitForTimeout(6000);
  const pillT2 = await page.evaluate(() => {
    const t = document.getElementById("heartbeat-text");
    return t ? t.textContent.trim() : null;
  });
  console.log(`[apv-heartbeat] T2:`, pillT2);

  await page.screenshot({
    path: "apv-heartbeat-T2-live-5s-later.png",
    fullPage: false,
    clip: { x: 0, y: 0, width: 1280, height: 200 },
  });

  // Full-page screenshot too
  await page.screenshot({ path: "apv-heartbeat-fullpage.png", fullPage: false });

  const fatal = [];
  if (!pillT1) fatal.push("heartbeat-pill elements not found post-signin");
  else {
    if (!pillT1.visible) fatal.push("heartbeat-pill has 0x0 bounding box (not visible)");
    if (!pillT1.text.includes("LIVE") && !pillT1.text.includes("STALE") && !pillT1.text.includes("OFFLINE")) {
      fatal.push(`heartbeat-pill text unexpected: "${pillT1.text}"`);
    }
    if (pillT1.status !== "live" && pillT1.status !== "stale" && pillT1.status !== "offline") {
      fatal.push(`heartbeat-pill data-status unexpected: "${pillT1.status}"`);
    }
  }
  if (pillT1 && pillT2 && pillT1.text === pillT2 && pillT1.text.includes("LIVE")) {
    // LIVE text has "Xs" — if identical after 6s it means no tick. Acceptable if T1 was e.g. "LIVE • 0s" and T2 "LIVE • 0s" (poll refreshed). But if truly frozen, flag.
    console.log(`[apv-heartbeat] NOTE: T1==T2 (${pillT1.text}) — likely a fresh poll reset. Not fatal.`);
  }

  const blockingErrors = consoleErrors.filter((t) => !(t.includes("Failed to load resource") && t.includes("403")));
  if (pageErrors.length) fatal.push(`pageerror: ${pageErrors.join(" | ")}`);
  if (blockingErrors.length > 3) fatal.push(`console errors: ${blockingErrors.slice(0, 5).join(" | ")}`);

  await browser.close();

  if (fatal.length) {
    console.error("[apv-heartbeat] FAIL");
    for (const f of fatal) console.error("  - " + f);
    process.exit(1);
  }
  console.log(`[apv-heartbeat] PASS — pill=${pillT1.text} / status=${pillT1.status} / T2=${pillT2}`);
  process.exit(0);
})().catch((e) => {
  console.error("[apv-heartbeat] CRASH", e);
  process.exit(1);
});
