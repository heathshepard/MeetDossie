#!/usr/bin/env node
// Probe — enumerate all button labels + doc rows on staging

"use strict";

const { chromium } = require("playwright");

const BASE = process.argv[2] || "https://meet-dossie-qt2paxsmj-heathshepard-6590s-projects.vercel.app";
const EMAIL = process.env.APV_EMAIL || "demo@meetdossie.com";
const PASSWORD = process.env.APV_PASSWORD || "DossieDemo-VaIiAt6Bab";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/workspace.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) await emailInput.fill(EMAIL);
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) await pwInput.fill(PASSWORD);
  const signInBtn = await page.$('button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Sign In")');
  if (signInBtn) await signInBtn.click();
  await page.waitForTimeout(4000);

  // Close new-dossier modal
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  // Navigate to Closed Dossiers
  const closedLink = await page.$('a:has-text("Closed Dossiers"), button:has-text("Closed Dossiers")');
  if (closedLink) await closedLink.click().catch(() => {});
  await page.waitForTimeout(2000);

  // Click first dossier — button label pattern matched
  const firstDossier = await page.$('button:has-text("8412 Mock Trail")');
  console.log("firstDossier:", !!firstDossier);
  if (firstDossier) await firstDossier.click();
  await page.waitForTimeout(3500);

  // Enumerate all button labels + document-row indicators
  const info = await page.evaluate(() => {
    const buttonLabels = Array.from(document.querySelectorAll("button")).map(b => (b.textContent || "").trim()).filter(x => x);
    const documentSectionText = (() => {
      const els = Array.from(document.querySelectorAll("*"));
      const docsHeader = els.find(el => (el.textContent || "").trim() === "Documents" && el.children.length === 0);
      if (!docsHeader) return null;
      const container = docsHeader.closest("section, div");
      return container ? container.innerText.slice(0, 2000) : docsHeader.parentElement.innerText.slice(0, 2000);
    })();
    return {
      buttonLabels,
      documentSectionText,
    };
  });
  console.log(JSON.stringify(info, null, 2));

  await browser.close();
})();
