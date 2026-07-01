#!/usr/bin/env node
"use strict";
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const url = "https://meetdossie.com/admin/dossie-sign";
  console.log("nav", url);
  await p.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await p.waitForTimeout(3000);
  const out = "C:/Users/Heath Shepard/Desktop/MeetDossie/apv-dossie-sign-dashboard-live.png";
  await p.screenshot({ path: out, fullPage: true });
  console.log("saved", out);
  const bodyText = await p.evaluate(() => document.body.innerText.slice(0, 500));
  console.log("body:", bodyText);
  await b.close();
})();
