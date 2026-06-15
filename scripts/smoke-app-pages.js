#!/usr/bin/env node
// scripts/smoke-app-pages.js
//
// Pre-merge "does the app load cleanly?" gate.
//
// Loads the 5 customer-visible Dossie pages in sequence:
//   /  /app  /founding  /faq  /coordinators
//
// For each page:
//   - waitUntil: domcontentloaded (10s timeout)
//   - captures console errors (level=error) — both page.on('console') and
//     page.on('pageerror') for uncaught exceptions
//   - checks that at least one role=main|banner|heading|button is present
//     (i.e., not a blank/whitescreen page)
//   - takes a PNG screenshot to .tmp-smoke/run-<timestamp>/<slug>.png
//
// Exit 0 = all pages pass. Exit 1 = ANY page has a console error or no
// visible interactive content.
//
// Built 2026-06-14 (Atlas) to catch the class of bug that shipped a
// broken `const wv` duplicate-declaration bundle to prod for ~48h with
// Ridge's customer-view digest detecting (not blocking) the break.
//
// Usage:
//   node scripts/smoke-app-pages.js https://staging.meetdossie.com
//   node scripts/smoke-app-pages.js https://meetdossie.com
//   node scripts/smoke-app-pages.js https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app
//
// Wired into Quinn's pre-merge gate via .claude/agents/quinn.md.

"use strict";

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const baseArg = process.argv[2];
if (!baseArg) {
  console.error("Usage: node scripts/smoke-app-pages.js <BASE_URL>");
  console.error(
    "Example: node scripts/smoke-app-pages.js https://staging.meetdossie.com"
  );
  process.exit(2);
}

// Normalize base — strip trailing slash
const BASE = baseArg.replace(/\/+$/, "");

// Pages to check. slug is used for screenshot filename + log label.
const PAGES = [
  { slug: "home", path: "/" },
  { slug: "app", path: "/app" },
  { slug: "founding", path: "/founding" },
  { slug: "faq", path: "/faq" },
  { slug: "coordinators", path: "/coordinators" },
];

const NAV_TIMEOUT_MS = 10000; // 10s domcontentloaded budget
const POST_LOAD_WAIT_MS = 1500; // give SPA hydration a moment to throw
const RUN_DIR = path.join(
  process.cwd(),
  ".tmp-smoke",
  `run-${new Date().toISOString().replace(/[:.]/g, "-")}`
);

// Known-noise console errors to ignore (3rd-party / expected).
const IGNORE_CONSOLE_PATTERNS = [
  /favicon\.ico/i,
  /google-analytics/i,
  /googletagmanager/i,
  /gtag/i,
  /chrome-extension:/i,
  /Failed to load resource:.*sourcemap/i,
  /\.well-known\/appspecific\/com\.chrome/i,
];

function isIgnorable(text) {
  return IGNORE_CONSOLE_PATTERNS.some((re) => re.test(text));
}

async function checkPage(browser, page) {
  const url = `${BASE}${page.path}`;
  const consoleErrors = [];
  const pageErrors = [];

  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 SmokeBot/1.0",
  });
  const tab = await ctx.newPage();

  tab.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (isIgnorable(text)) return;
    consoleErrors.push(text);
  });
  tab.on("pageerror", (err) => {
    const text = err && err.message ? err.message : String(err);
    if (isIgnorable(text)) return;
    pageErrors.push(text);
  });

  let navStatus = null;
  let navError = null;
  try {
    const resp = await tab.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    navStatus = resp ? resp.status() : null;
  } catch (e) {
    navError = e.message || String(e);
  }

  // Give SPA + scripts a moment to actually execute / throw before we
  // judge "visible content"
  await tab.waitForTimeout(POST_LOAD_WAIT_MS);

  // Check for at least one role=main|banner|heading|button OR a visible
  // <h1>/<h2>/<button>. Using getByRole would throw if zero — use locator
  // counts directly so we can report a number.
  let interactiveCount = 0;
  let interactiveDetail = "";
  try {
    interactiveCount = await tab.evaluate(() => {
      const sels = [
        '[role="main"]',
        '[role="banner"]',
        '[role="heading"]',
        '[role="button"]',
        "main",
        "h1",
        "h2",
        "button",
        "a[href]",
      ];
      let total = 0;
      const counts = {};
      for (const s of sels) {
        const c = document.querySelectorAll(s).length;
        counts[s] = c;
        total += c;
      }
      return { total, counts };
    });
    if (typeof interactiveCount === "object" && interactiveCount !== null) {
      interactiveDetail = JSON.stringify(interactiveCount.counts);
      interactiveCount = interactiveCount.total;
    }
  } catch (e) {
    interactiveCount = 0;
    interactiveDetail = `evaluate-failed: ${e.message}`;
  }

  // Screenshot regardless of pass/fail (helpful for debugging)
  const shotPath = path.join(RUN_DIR, `${page.slug}.png`);
  try {
    await tab.screenshot({ path: shotPath, fullPage: false });
  } catch (e) {
    // non-fatal — log it but continue
    console.log(`  [warn] screenshot failed for ${page.slug}: ${e.message}`);
  }

  await ctx.close();

  const hasConsoleError = consoleErrors.length > 0 || pageErrors.length > 0;
  const hasContent = interactiveCount > 0;
  const pass = !hasConsoleError && hasContent && !navError;

  return {
    slug: page.slug,
    url,
    pass,
    navStatus,
    navError,
    consoleErrors,
    pageErrors,
    interactiveCount,
    interactiveDetail,
    screenshot: shotPath,
  };
}

(async () => {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  console.log(`[smoke] base: ${BASE}`);
  console.log(`[smoke] run dir: ${RUN_DIR}`);
  console.log(`[smoke] pages: ${PAGES.map((p) => p.path).join(" ")}`);

  const browser = await chromium.launch({ headless: true });
  const results = [];
  for (const page of PAGES) {
    process.stdout.write(`[smoke] ${page.path.padEnd(16)} `);
    let r;
    try {
      r = await checkPage(browser, page);
    } catch (e) {
      r = {
        slug: page.slug,
        url: `${BASE}${page.path}`,
        pass: false,
        navError: `unhandled: ${e.message}`,
        consoleErrors: [],
        pageErrors: [],
        interactiveCount: 0,
        interactiveDetail: "",
        screenshot: null,
      };
    }
    results.push(r);
    const verdict = r.pass ? "PASS" : "FAIL";
    const detail = r.pass
      ? `(${r.navStatus || "?"}, ${r.interactiveCount} elements)`
      : (() => {
          const bits = [];
          if (r.navError) bits.push(`nav: ${r.navError}`);
          if (r.consoleErrors.length)
            bits.push(`console: ${r.consoleErrors.length} err`);
          if (r.pageErrors.length)
            bits.push(`pageerror: ${r.pageErrors.length}`);
          if (!r.consoleErrors.length && !r.pageErrors.length && !r.navError)
            bits.push(`no interactive content`);
          return `(${bits.join(", ")})`;
        })();
    console.log(`${verdict} ${detail}`);
  }
  await browser.close();

  // Write a JSON summary alongside the screenshots
  const summary = {
    base: BASE,
    timestamp: new Date().toISOString(),
    pageCount: results.length,
    passCount: results.filter((r) => r.pass).length,
    failCount: results.filter((r) => !r.pass).length,
    results,
  };
  fs.writeFileSync(
    path.join(RUN_DIR, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  // Detail dump for any failure
  const failures = results.filter((r) => !r.pass);
  if (failures.length) {
    console.log("");
    console.log("[smoke] FAILURE DETAIL:");
    for (const f of failures) {
      console.log(`  ${f.url}`);
      if (f.navError) console.log(`    nav-error: ${f.navError}`);
      if (f.navStatus && f.navStatus >= 400)
        console.log(`    nav-status: ${f.navStatus}`);
      if (!f.interactiveCount)
        console.log(
          `    no interactive content (detail: ${f.interactiveDetail || "n/a"})`
        );
      for (const e of f.consoleErrors)
        console.log(`    console.error: ${e.slice(0, 240)}`);
      for (const e of f.pageErrors)
        console.log(`    pageerror:     ${e.slice(0, 240)}`);
      if (f.screenshot) console.log(`    screenshot: ${f.screenshot}`);
    }
  }

  console.log("");
  console.log(
    `[smoke] ${summary.passCount}/${summary.pageCount} pages passed (run dir: ${RUN_DIR})`
  );

  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error("[smoke] fatal:", e.stack || e.message);
  process.exit(2);
});
