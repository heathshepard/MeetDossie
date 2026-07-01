#!/usr/bin/env node
// APV — Blocker #1 verification: does /api/dossiesign-prepare return real document_id
// (uuid) or meaningful error string per form? Does /api/esign-create get POSTed with a
// real documentId? Mocks esign-create so no real DocuSeal envelope is created.

"use strict";

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "https://staging.meetdossie.com";
const EMAIL = process.env.APV_EMAIL || "demo@meetdossie.com";
const PASSWORD = process.env.APV_PASSWORD || "DossieDemo-VaIiAt6Bab";
const OUT = path.resolve(__dirname, "..");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function shot(page, name) {
  const p = path.join(OUT, `apv-blocker1-${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`[apv-blocker1] wrote ${p}`);
  return p;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const esignCreatePayloads = [];
  let prepareResponse = null;

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  // Intercept /api/esign-create — capture payloads, mock 200
  await page.route("**/api/esign-create*", async (route, req) => {
    let body = null;
    try { body = req.postDataJSON(); } catch (_) { body = req.postData(); }
    esignCreatePayloads.push({ url: req.url(), method: req.method(), body });
    console.log(`[apv-blocker1] intercepted /api/esign-create -> mocked 200`);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        envelope_id: "apv-mock-envelope-blocker1",
        submitters: [{ email: "buyer@example.com", status: "sent" }],
        note: "APV MOCK — no real envelope was created",
      }),
    });
  });

  // Capture the real dossiesign-prepare response
  page.on("response", async (resp) => {
    if (resp.url().includes("/api/dossiesign-prepare")) {
      try {
        const body = await resp.json();
        prepareResponse = body;
        console.log(`[apv-blocker1] /api/dossiesign-prepare response:`, JSON.stringify(body, null, 2).slice(0, 2000));
      } catch (e) {
        console.log(`[apv-blocker1] failed to parse prepare response:`, e.message);
      }
    }
  });

  console.log(`[apv-blocker1] navigating ${BASE}/workspace.html`);
  await page.goto(`${BASE}/workspace.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  console.log(`[apv-blocker1] signing in as ${EMAIL}`);
  const emailInput = await page.$('input[type="email"]');
  if (emailInput) await emailInput.fill(EMAIL);
  const pwInput = await page.$('input[type="password"]');
  if (pwInput) await pwInput.fill(PASSWORD);
  const signInBtn = await page.$('button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Sign In")');
  if (signInBtn) await signInBtn.click();

  await page.waitForTimeout(4000);
  await shot(page, "T0-signed-in");

  // Close any "Open new dossier" overlay
  const closeX = await page.$('button[aria-label="Close"], [role="dialog"] button:has-text("×")');
  if (closeX) await closeX.click().catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  // Navigate to Closed Dossiers
  const closedLink = await page.$('a:has-text("Closed Dossiers"), button:has-text("Closed Dossiers")');
  const pipelineLink = await page.$('a:has-text("Pipeline"), button:has-text("Pipeline")');
  if (closedLink) {
    await closedLink.click().catch(() => {});
    await page.waitForTimeout(2000);
  } else if (pipelineLink) {
    await pipelineLink.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Click 8412 Mock Trail dossier
  const dossierRow = await page.$('button:has-text("8412 Mock Trail")');
  if (dossierRow) {
    await dossierRow.click().catch(() => {});
    await page.waitForTimeout(3500);
  }
  await shot(page, "T1-workspace");

  // Documents tab
  const docsTab = await page.$('button:has-text("Documents"), a:has-text("Documents"), [role="tab"]:has-text("Documents")');
  if (docsTab) {
    await docsTab.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("*"));
    const target = els.find(el => (el.textContent || "").trim() === "Documents" && el.children.length === 0);
    if (target) target.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(1000);

  // Send for signature
  const sendBtn = await page.waitForSelector('button:has-text("Send for signature")', { timeout: 15000 }).catch(() => null);
  if (!sendBtn) {
    console.log(`[apv-blocker1] FAIL — 'Send for signature' button not found`);
    await shot(page, "FAIL-no-send-button");
    await browser.close();
    process.exit(2);
  }
  await shot(page, "T2-send-button");
  await sendBtn.click();
  await page.waitForTimeout(3000);
  await shot(page, "T3-step1-forms");

  // Analyze prepare response
  let blocker1_result = { pass: false, reason: null, forms_analysis: [] };
  if (!prepareResponse) {
    blocker1_result.reason = "No /api/dossiesign-prepare response captured";
  } else if (!prepareResponse.forms || !Array.isArray(prepareResponse.forms)) {
    blocker1_result.reason = "Response missing forms array";
  } else {
    const forms = prepareResponse.forms;
    forms.forEach((f) => {
      const has_uuid = f.document_id && UUID_RE.test(f.document_id);
      const has_error = typeof f.error === "string" && f.error.length > 0;
      const has_error_field_in_schema = "error" in f;
      blocker1_result.forms_analysis.push({
        form_name: f.form_name,
        form_type: f.form_type,
        document_id: f.document_id,
        has_valid_uuid: has_uuid,
        error: f.error,
        has_error_field_in_schema,
        status: has_uuid ? "GREEN — real document_id" : (has_error ? `RED-with-meaningful-error: ${f.error}` : "RED-silent-null (Blocker #1 STILL PRESENT)"),
      });
    });
    // PASS criteria: EITHER every form has a valid uuid OR every null-document form has a meaningful error string
    const allValid = blocker1_result.forms_analysis.every(
      (r) => r.has_valid_uuid || (r.error && r.error.length > 0)
    );
    // AND: the error field must be present in the response schema (Carter's fix)
    const schemaHasError = blocker1_result.forms_analysis.every((r) => r.has_error_field_in_schema);
    blocker1_result.pass = allValid && schemaHasError;
    if (!allValid) blocker1_result.reason = "One or more forms returned null document_id with no error explanation";
    else if (!schemaHasError) blocker1_result.reason = "Response missing 'error' field per form (Carter's fix not deployed)";
  }

  console.log(`[apv-blocker1] Blocker #1 analysis:`, JSON.stringify(blocker1_result, null, 2));

  // Continue the flow to trigger esign-create — check checkbox, click continue, walk previews, fill email, click Send for Signature
  try {
    const checkboxes = await page.$$('input[type="checkbox"]');
    for (const cb of checkboxes) {
      const isVisible = await cb.isVisible().catch(() => false);
      if (isVisible) { await cb.check().catch(() => {}); break; }
    }
    await page.waitForTimeout(400);
    const step1Continue = await page.$('button:has-text("Continue"), button:has-text("Next")');
    if (step1Continue) { await step1Continue.click().catch(() => {}); await page.waitForTimeout(1500); }
    await shot(page, "T4-step2-preview");

    for (let i = 0; i < 6; i++) {
      const cb = await page.$('input[type="checkbox"]:visible');
      if (cb) await cb.check().catch(() => {});
      await page.waitForTimeout(200);
      const nextForm = await page.$('button:has-text("Next form")');
      if (nextForm) {
        await nextForm.click().catch(() => {});
        await page.waitForTimeout(300);
      } else break;
    }
    const step2Continue = await page.$('button:has-text("Continue to Recipients")');
    if (step2Continue) { await step2Continue.click().catch(() => {}); await page.waitForTimeout(1500); }
    await shot(page, "T5-step3-recipients");

    const emailPh = await page.$('input[placeholder*="Email"], input[placeholder*="email"]');
    if (emailPh) await emailPh.fill("buyer@example.com").catch(() => {});
    await page.waitForTimeout(400);
    await shot(page, "T6-step3-filled");

    const sendFinal = await page.$('button:text-is("Send for Signature")');
    if (sendFinal) {
      await sendFinal.evaluate((el) => el.click()).catch(() => {});
      await page.waitForTimeout(6000);
    }
    await shot(page, "T7-step4-success");
  } catch (e) {
    console.log(`[apv-blocker1] flow completion error (non-fatal):`, e.message);
  }

  // Analyze esign-create payloads
  const esignAnalysis = esignCreatePayloads.map((p) => {
    const body = p.body || {};
    const docs = body.documents || body.documentIds || [];
    const docIds = Array.isArray(docs) ? docs.map((d) => (typeof d === "string" ? d : d.documentId || d.document_id)) : [];
    const validUuids = docIds.filter((id) => id && UUID_RE.test(id));
    return {
      documents_field: docs,
      valid_uuid_count: validUuids.length,
      total_docs: docIds.length,
    };
  });

  const summary = {
    ok: blocker1_result.pass && consoleErrors.length === 0,
    blocker_1: blocker1_result,
    esign_create_analysis: esignAnalysis,
    esign_create_intercepted: esignCreatePayloads.length,
    consoleErrors,
    pageErrors,
    prepare_response_full: prepareResponse,
  };
  console.log("\n===== APV BLOCKER-1 SUMMARY =====");
  console.log(JSON.stringify(summary, null, 2));

  fs.writeFileSync(path.join(OUT, "apv-blocker1-summary.json"), JSON.stringify(summary, null, 2));

  await browser.close();
  process.exit(summary.ok ? 0 : 1);
})().catch((err) => {
  console.error("[apv-blocker1] FATAL", err);
  process.exit(3);
});
