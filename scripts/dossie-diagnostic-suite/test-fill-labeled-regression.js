#!/usr/bin/env node
"use strict";
// Regression test for the fill_labeled targeting bug found 2026-07-10.
//
// Bug: previously, `fill_labeled` used lbl.closest("div") on a <span> inside
// a <label>. Since Field renders as <label> (not <div>), closest() walked
// past the label to the outer form grid, then grabbed the FIRST input in
// the grid. Every fill_labeled step wrote to the SAME first input (which is
// the Property address input), so property_address in the DB ended up with
// whatever the LAST successful fill_labeled call wrote — usually the City,
// Buyer name, or Seller name value.
//
// This test:
//   1. Signs in as demo
//   2. Opens create-dossier modal
//   3. Fills each field via fill_labeled (using the FIXED targeting logic)
//   4. Submits
//   5. Queries DB and asserts each column matches the expected value
//
// Run: node scripts/dossie-diagnostic-suite/test-fill-labeled-regression.js
//   Env: BASE_URL, APV_EMAIL, APV_PASSWORD, SUPABASE_SERVICE_ROLE_KEY

require("./_lib/env-preload").loadEnvLocal();
const { buildConfig } = require("./_lib/config");
const { signIn } = require("./_lib/signin");

const SENTINEL = `REGRESSION-${Date.now()}`;
const TEST_ADDRESS = `1247 Regression Way ${SENTINEL}`;
const TEST_CITY = "San Antonio, TX 78247";
const TEST_BUYER = "Sarah Regression";
const TEST_SELLER = "John Regression";
const TEST_PRICE = "325000";

async function fillLabeled(page, label, value) {
  return page.evaluate(
    ({ label, value }) => {
      const want = label.trim().toLowerCase();
      const normalize = (s) =>
        (s || "")
          .replace(/[✓⚠!]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
      const labels = Array.from(document.querySelectorAll("label"));
      const match = labels.find((lbl) => {
        const span = lbl.querySelector("span");
        return (
          (span && normalize(span.textContent) === want) ||
          normalize(lbl.textContent) === want
        );
      });
      if (!match) return { ok: false, reason: "no label", label };
      const input = match.querySelector('input:not([type="hidden"]), textarea');
      if (!input) return { ok: false, reason: "no input", label };
      const proto =
        input.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        label,
        value: String(value),
        placeholder: input.getAttribute("placeholder"),
        autoComplete: input.getAttribute("autocomplete"),
      };
    },
    { label, value },
  );
}

async function queryFreshRow(cfg, sinceIso) {
  const url =
    `${cfg.supabaseUrl}/rest/v1/transactions?` +
    `user_id=eq.${cfg.demoUserId}&created_at=gte.${encodeURIComponent(sinceIso)}` +
    `&order=created_at.desc&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: cfg.supabaseServiceKey,
      Authorization: `Bearer ${cfg.supabaseServiceKey}`,
    },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows[0] || null;
}

(async () => {
  const cfg = buildConfig("fill-labeled-regression", process.argv);
  if (!cfg.supabaseServiceKey) {
    console.error("[test] SUPABASE_SERVICE_ROLE_KEY not set — cannot verify DB row");
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  console.log(`[test] starting fill_labeled regression against ${cfg.base}`);
  console.log(`[test] sentinel: ${SENTINEL}`);

  const session = await signIn(cfg);
  const { browser, page } = session;

  try {
    // Open the create dossier modal. Try Talk-to-Dossie first, fall back to
    // "Open New Dossier" button on the app page.
    await page.goto(`${cfg.base}/app`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.click('button:has-text("Open New Dossier")', { timeout: 5000 });
    await page.waitForTimeout(1500);

    // Fill each visible label. Some scenarios may show variants (Buyer name vs
    // Buyer full name); the test uses the labels present in the modal's
    // "Under Contract" full form by default.
    const results = [];
    results.push(await fillLabeled(page, "Property address", TEST_ADDRESS));
    results.push(await fillLabeled(page, "City / State / ZIP", TEST_CITY));
    results.push(await fillLabeled(page, "Buyer full name", TEST_BUYER));
    results.push(await fillLabeled(page, "Seller name", TEST_SELLER));
    results.push(await fillLabeled(page, "Sales price", TEST_PRICE));

    console.log("[test] fill results:");
    for (const r of results) console.log("  ", r);

    // Submit
    await page.click('button:has-text("Create dossier")', { timeout: 5000 });
    await page.waitForTimeout(5000);

    // Query DB
    let row = null;
    for (let i = 0; i < 8; i++) {
      row = await queryFreshRow(cfg, startedAt);
      if (row && (row.property_address || "").includes(SENTINEL)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!row) {
      console.error("[test] FAIL — no dossier row created");
      process.exit(1);
    }

    console.log("[test] fresh row:", {
      id: row.id,
      property_address: row.property_address,
      city_state_zip: row.city_state_zip,
      buyer_name: row.buyer_name,
      seller_name: row.seller_name,
      sale_price: row.sale_price,
    });

    // Assert
    const failures = [];
    if (row.property_address !== TEST_ADDRESS) {
      failures.push(
        `property_address expected ${JSON.stringify(TEST_ADDRESS)}, got ${JSON.stringify(row.property_address)}`,
      );
    }
    if (row.city_state_zip !== TEST_CITY) {
      failures.push(
        `city_state_zip expected ${JSON.stringify(TEST_CITY)}, got ${JSON.stringify(row.city_state_zip)}`,
      );
    }
    if (row.buyer_name !== TEST_BUYER) {
      failures.push(
        `buyer_name expected ${JSON.stringify(TEST_BUYER)}, got ${JSON.stringify(row.buyer_name)}`,
      );
    }
    if (row.seller_name !== TEST_SELLER) {
      failures.push(
        `seller_name expected ${JSON.stringify(TEST_SELLER)}, got ${JSON.stringify(row.seller_name)}`,
      );
    }
    if (String(row.sale_price) !== TEST_PRICE) {
      failures.push(
        `sale_price expected ${JSON.stringify(TEST_PRICE)}, got ${JSON.stringify(row.sale_price)}`,
      );
    }

    if (failures.length > 0) {
      console.error("[test] FAIL — field mismatches:");
      for (const f of failures) console.error("  •", f);
      process.exit(1);
    }

    console.log("[test] PASS — all 5 fields landed in correct DB columns");
    process.exit(0);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("[test] TOP-LEVEL FATAL", err);
  process.exit(3);
});
