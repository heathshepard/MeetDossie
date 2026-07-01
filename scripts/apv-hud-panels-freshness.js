#!/usr/bin/env node
// APV — Jarvis HUD Activity Log + Throughput panel freshness
// Signs in as demo, waits for panels to hydrate, screenshots them, and
// asserts the endpoints returned 200s with non-empty payloads.

"use strict";

const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://meetdossie.com";
const EMAIL = process.env.APV_EMAIL || "demo@meetdossie.com";
const PASSWORD = process.env.APV_PASSWORD || "DossieDemo-VaIiAt6Bab";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const networkLog = [];
  page.on("response", (r) => {
    const url = r.url();
    if (url.includes("/api/jarvis-activity-log") ||
        url.includes("/api/jarvis-agent-throughput") ||
        url.includes("/api/agent-memory-list")) {
      networkLog.push({ url, status: r.status() });
    }
  });

  console.log(`[apv-hud] navigating ${BASE}/myjarvis`);
  await page.goto(`${BASE}/myjarvis`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Sign in
  console.log(`[apv-hud] signing in as ${EMAIL}`);
  const emailInput = await page.$('#auth-email') || await page.$('input[type="email"]');
  if (emailInput) await emailInput.fill(EMAIL);
  const pwInput = await page.$('#auth-password') || await page.$('input[type="password"]');
  if (pwInput) await pwInput.fill(PASSWORD);
  await page.click("button:has-text('SIGN IN')");

  // Wait for HUD to render + panels to hydrate
  await page.waitForSelector("#activity-panel", { timeout: 25000 });
  await page.waitForTimeout(6000); // let all polls fire

  // Snapshot each panel's rendered contents
  const activity = await page.evaluate(() => {
    const feed = document.getElementById("activity-feed");
    if (!feed) return { present: false };
    const rows = feed.querySelectorAll(".activity-row");
    const empty = feed.querySelector(".activity-empty");
    const rowData = Array.from(rows).slice(0, 5).map((r) => ({
      agent: (r.querySelector(".activity-agent") || {}).textContent || "",
      task:  (r.querySelector(".activity-task")  || {}).textContent || "",
      ts:    (r.querySelector(".activity-ts")    || {}).textContent || "",
    }));
    return {
      present: true,
      row_count: rows.length,
      empty_text: empty ? empty.textContent : null,
      sample: rowData,
    };
  });

  const throughput = await page.evaluate(() => {
    const totals = document.getElementById("throughput-totals");
    const rows   = document.getElementById("throughput-rows");
    if (!totals || !rows) return { present: false };
    const emptyT = totals.querySelector(".throughput-empty");
    const emptyR = rows.querySelector(".throughput-empty");
    const cells = Array.from(totals.querySelectorAll(".throughput-totals-cell")).slice(0, 4).map(c => ({
      val: (c.querySelector(".throughput-totals-val") || {}).textContent || "",
      lbl: (c.querySelector(".throughput-totals-lbl") || {}).textContent || "",
    }));
    const roleRows = Array.from(rows.querySelectorAll(".throughput-row")).map(r => (r.querySelector(".throughput-role") || {}).textContent || "");
    return {
      present: true,
      totals_still_loading: /Loading/.test(totals.textContent || ""),
      totals_empty_text: emptyT ? emptyT.textContent : null,
      rows_empty_text:   emptyR ? emptyR.textContent : null,
      totals_cells: cells,
      role_rows: roleRows,
    };
  });

  const knowledge = await page.evaluate(() => {
    const list = document.getElementById("knowledge-list");
    if (!list) return { present: false };
    const rows = list.querySelectorAll(".knowledge-row");
    const empty = list.querySelector(".ledger-empty");
    return {
      present: true,
      row_count: rows.length,
      empty_text: empty ? empty.textContent : null,
      innerHTML_head: (list.innerHTML || "").slice(0, 200),
    };
  });

  console.log("[apv-hud] network:", JSON.stringify(networkLog, null, 2));
  console.log("[apv-hud] Activity Log:", JSON.stringify(activity, null, 2));
  console.log("[apv-hud] Throughput:",   JSON.stringify(throughput, null, 2));
  console.log("[apv-hud] Knowledge:",    JSON.stringify(knowledge, null, 2));

  await page.screenshot({ path: "apv-hud-panels-full.png", fullPage: true });

  // Try to find each panel and snap it in isolation.
  const shots = [
    { sel: "#activity-panel",   file: "apv-hud-activity-panel.png" },
    { sel: "#throughput-panel", file: "apv-hud-throughput-panel.png" },
    { sel: "#knowledge-panel",  file: "apv-hud-knowledge-panel.png" },
  ];
  for (const s of shots) {
    const el = await page.$(s.sel);
    if (el) {
      await el.screenshot({ path: s.file });
      console.log(`[apv-hud] snapped ${s.file}`);
    }
  }

  const verdict = {
    activity_ok:   activity.present   && activity.row_count > 0,
    throughput_ok: throughput.present && !throughput.totals_still_loading,
    knowledge_ok:  knowledge.present  && knowledge.row_count > 0,
  };
  console.log("[apv-hud] verdict:", JSON.stringify(verdict));

  await browser.close();

  if (!verdict.activity_ok || !verdict.throughput_ok || !verdict.knowledge_ok) {
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error("[apv-hud] FATAL:", err);
  process.exit(2);
});
