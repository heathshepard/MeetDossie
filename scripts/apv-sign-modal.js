#!/usr/bin/env node
// APV — Send-for-signature button + DossieSignModal 4-step flow on /workspace.html
// Signs in as demo, opens a filled dossier, clicks "Send for signature", walks
// the 4-step modal (Forms -> Preview -> Recipients -> Success). Intercepts the
// /api/esign-create POST so no real DocuSeal envelope is created.

"use strict";

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "https://meet-dossie-qt2paxsmj-heathshepard-6590s-projects.vercel.app";
const EMAIL = process.env.APV_EMAIL || "demo@meetdossie.com";
const PASSWORD = process.env.APV_PASSWORD || "DossieDemo-VaIiAt6Bab";
const OUT = path.resolve(__dirname, "..");

async function shot(page, name) {
  const p = path.join(OUT, `apv-sign-modal-${name}.png`);
  // Try modal-only screenshot first; fallback to viewport (not fullPage — modal is fixed)
  const dialog = await page.$('[role="dialog"], div[style*="zIndex: 9200"], div[style*="z-index: 9200"]').catch(() => null);
  if (dialog) {
    await dialog.screenshot({ path: p }).catch(async () => {
      await page.screenshot({ path: p, fullPage: false });
    });
  } else {
    await page.screenshot({ path: p, fullPage: false });
  }
  console.log(`[apv-sign-modal] wrote ${p}`);
  return p;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const interceptedRequests = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  // Intercept /api/esign-create AND /api/dossiesign-prepare before they hit the network.
  await page.route("**/api/esign-create*", async (route, req) => {
    let body = null;
    try { body = req.postDataJSON(); } catch (_) { body = req.postData(); }
    interceptedRequests.push({ url: req.url(), method: req.method(), body });
    console.log(`[apv-sign-modal] intercepted /api/esign-create -> mocked 200`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        envelope_id: "apv-mock-envelope-0001",
        submitters: [{ email: "buyer@example.com", status: "sent" }],
        note: "APV MOCK — no real envelope was created",
      }),
    });
  });
  // Log dossiesign-prepare but DO NOT mock it — it fetches the form list needed by modal
  await page.route("**/api/dossiesign-prepare*", async (route, req) => {
    interceptedRequests.push({ url: req.url(), method: req.method(), kind: "prepare-passthrough" });
    console.log(`[apv-sign-modal] observed /api/dossiesign-prepare (passthrough)`);
    await route.continue();
  });
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/dossiesign-prepare")) {
      try {
        const body = await resp.json();
        console.log(`[apv-sign-modal] dossiesign-prepare response.forms:`, JSON.stringify(body.forms?.map(f => ({ name: f.form_name, doc: f.document_id, prev: !!f.preview_url, type: f.form_type })), null, 2));
      } catch (_) {}
    }
  });
  // Also log any request to see what fires on Send click
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/api/")) console.log(`[req] ${req.method()} ${u}`);
  });

  console.log(`[apv-sign-modal] navigating ${BASE}/workspace.html`);
  await page.goto(`${BASE}/workspace.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Sign in
  console.log(`[apv-sign-modal] signing in as ${EMAIL}`);
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) await emailInput.fill(EMAIL);
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) await pwInput.fill(PASSWORD);
  const signInBtn = await page.$('button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Sign In")');
  if (signInBtn) await signInBtn.click();

  await page.waitForTimeout(4000);
  await shot(page, "T0-signed-in");

  // Close any "Open new dossier" modal if present
  const closeX = await page.$('button[aria-label="Close"], [role="dialog"] button:has-text("×")');
  if (closeX) {
    console.log(`[apv-sign-modal] closing 'new dossier' overlay`);
    await closeX.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  // Also try Escape
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  // Navigate to Closed Dossiers or Pipeline where filled documents live
  console.log(`[apv-sign-modal] navigating to Closed Dossiers`);
  const pipelineLink = await page.$('a:has-text("Pipeline"), button:has-text("Pipeline")');
  const closedLink = await page.$('a:has-text("Closed Dossiers"), button:has-text("Closed Dossiers")');
  if (closedLink) {
    await closedLink.click().catch(() => {});
    await page.waitForTimeout(2000);
  } else if (pipelineLink) {
    await pipelineLink.click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  await shot(page, "T1a-pipeline-or-closed");

  // Click first dossier card (buttons labeled like "8412 Mock Trail...")
  console.log(`[apv-sign-modal] clicking dossier card 8412 Mock Trail`);
  const dossierRow = await page.$('button:has-text("8412 Mock Trail")');
  if (dossierRow) {
    await dossierRow.click().catch(() => {});
    await page.waitForTimeout(3500);
  } else {
    console.log(`[apv-sign-modal] no dossier card matched`);
  }
  await shot(page, "T1-workspace");

  // Once inside a dossier, look for a Documents / Transactions tab
  console.log(`[apv-sign-modal] looking for Documents tab`);
  const docsTab = await page.$('button:has-text("Documents"), a:has-text("Documents"), [role="tab"]:has-text("Documents")');
  if (docsTab) {
    await docsTab.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  // Scroll down to the Documents section
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("*"));
    const target = els.find(el => (el.textContent || "").trim() === "Documents" && el.children.length === 0);
    if (target) target.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(1000);
  await shot(page, "T1b-documents-tab");

  // Look for the "Send for signature" button (label starts with ✍ so use partial)
  console.log(`[apv-sign-modal] hunting for 'Send for signature' button`);
  // Scroll to Documents section first
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("*"));
    const target = els.find(el => (el.textContent || "").trim() === "Documents" && el.children.length === 0);
    if (target) target.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(1000);
  const sendBtn = await page.waitForSelector('button:has-text("Send for signature")', { timeout: 15000 }).catch(() => null);
  if (!sendBtn) {
    console.log(`[apv-sign-modal] FAIL — 'Send for signature' button not found`);
    await shot(page, "FAIL-no-send-button");
    // Emit summary
    console.log(JSON.stringify({
      ok: false,
      reason: "Send for signature button not found on workspace",
      consoleErrors,
      pageErrors,
    }, null, 2));
    await browser.close();
    process.exit(2);
  }
  console.log(`[apv-sign-modal] found Send for signature button`);
  await shot(page, "T2-send-button-visible");
  await sendBtn.click();
  await page.waitForTimeout(2000);
  // Probe modal DOM
  const modalProbe1 = await page.evaluate(() => {
    const modalEls = Array.from(document.querySelectorAll("div")).filter(d => {
      const s = d.style.zIndex;
      return s === "9200" || parseInt(s, 10) >= 9000;
    });
    const modal = modalEls[0];
    if (!modal) return { present: false };
    const buttons = Array.from(modal.querySelectorAll("button")).map(b => (b.textContent || "").trim());
    const inputs = Array.from(modal.querySelectorAll("input")).map(i => ({ type: i.type, placeholder: i.placeholder, checked: i.checked }));
    const heading = modal.querySelector("div")?.textContent?.slice(0, 200);
    return { present: true, buttons, inputs, heading };
  });
  console.log(`[apv-sign-modal] modal probe step 1:`, JSON.stringify(modalProbe1));

  // Step 1 — Forms
  await shot(page, "T3-step1-forms");
  const step1Text = await page.textContent("body").catch(() => "");
  const step1Has = /Forms/i.test(step1Text) || /Select/i.test(step1Text);
  console.log(`[apv-sign-modal] step1 forms visible: ${step1Has}`);

  // Try to click a form checkbox / continue
  const step1Continue = await page.$('button:has-text("Continue"), button:has-text("Next")');
  // First tick any checkbox in the modal so Continue is enabled
  const checkboxes = await page.$$('input[type="checkbox"]');
  for (const cb of checkboxes) {
    const isVisible = await cb.isVisible().catch(() => false);
    if (isVisible) {
      await cb.check().catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(500);
  if (step1Continue) {
    await step1Continue.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  // Step 2 — Preview: walk through each of 4 forms
  await shot(page, "T4-step2-preview");

  // For each form, tick "I have reviewed" then click "Next form" → until Continue to Recipients enabled
  for (let i = 0; i < 4; i++) {
    // Tick the visible "I have reviewed" checkbox (only one per view)
    const cb = await page.$('input[type="checkbox"]:visible');
    if (cb) await cb.check().catch(() => {});
    await page.waitForTimeout(300);
    // Click "Next form" (arrow)
    const nextForm = await page.$('button:has-text("Next form")');
    if (nextForm) {
      await nextForm.click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
  // Now try Continue to Recipients
  await page.waitForTimeout(500);
  await shot(page, "T4b-step2-all-reviewed");
  const step2Continue = await page.$('button:has-text("Continue to Recipients")');
  if (step2Continue) {
    await step2Continue.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  // Step 3 — Recipients
  await shot(page, "T5-step3-recipients");

  // Fill buyer email. Modal has "Email address" placeholder input.
  const emailPlaceholder = await page.$('input[placeholder*="Email"], input[placeholder*="email"]');
  if (emailPlaceholder) {
    await emailPlaceholder.fill("buyer@example.com").catch(() => {});
  } else {
    // Fallback: any text input inside modal that isn't the name field
    const inputs = await page.$$('[role="dialog"] input, div[style*="9200"] input');
    for (const inp of inputs) {
      const val = await inp.inputValue().catch(() => "");
      if (!val || val === "") {
        await inp.fill("buyer@example.com").catch(() => {});
        break;
      }
    }
  }
  await page.waitForTimeout(500);
  await shot(page, "T6-step3-recipients-filled");

  // Probe step-3 state before send
  const step3Probe = await page.evaluate(() => {
    const modalEls = Array.from(document.querySelectorAll("div")).filter(d => parseInt(d.style.zIndex || "0", 10) >= 9000);
    const modal = modalEls[0];
    if (!modal) return { present: false };
    const inputs = Array.from(modal.querySelectorAll("input")).map(i => ({ type: i.type, placeholder: i.placeholder, value: i.value, checked: i.checked }));
    const errText = (() => {
      const errNode = modal.querySelector('[style*="color: rgb(217"]');
      return errNode?.textContent || null;
    })();
    return { present: true, inputs, errText };
  });
  console.log(`[apv-sign-modal] step3 probe:`, JSON.stringify(step3Probe));

  // Click Send for Signature - use exact text match, do NOT force (force can click through overlay)
  const sendFinal = await page.$('button:text-is("Send for Signature")');
  if (sendFinal) {
    const disabled = await sendFinal.isDisabled().catch(() => false);
    console.log(`[apv-sign-modal] Send for Signature disabled=${disabled}`);
    // Use dispatchEvent instead of click to avoid coord/overlay issues
    await sendFinal.evaluate((el) => el.click()).catch((e) => console.log("send click err:", e.message));
    await page.waitForTimeout(6000);
  } else {
    console.log(`[apv-sign-modal] Send for Signature (exact) button not found on step 3`);
  }
  // Post-send probe
  const step3PostProbe = await page.evaluate(() => {
    const modalEls = Array.from(document.querySelectorAll("div")).filter(d => parseInt(d.style.zIndex || "0", 10) >= 9000);
    const modal = modalEls[0];
    if (!modal) return { present: false };
    const errText = (() => {
      const errNode = modal.querySelector('[style*="color: rgb(217"]');
      return errNode?.textContent || null;
    })();
    return { present: true, text: modal.innerText.slice(0, 500), errText };
  });
  console.log(`[apv-sign-modal] step3 POST probe:`, JSON.stringify(step3PostProbe));

  // Step 4 — Success (or wherever we land)
  await shot(page, "T7-step4-success");

  // Emit summary
  const summary = {
    ok: consoleErrors.length === 0 && pageErrors.length === 0,
    stepReached: step1Has ? "at-least-step1" : "unknown",
    interceptedRequests,
    consoleErrors,
    pageErrors,
  };
  console.log(JSON.stringify(summary, null, 2));

  await browser.close();
  process.exit(summary.ok ? 0 : 1);
})().catch((err) => {
  console.error("[apv-sign-modal] FATAL", err);
  process.exit(3);
});
