#!/usr/bin/env node
"use strict";
// Run 2 — Seller Listing (Single-Family). Phase B depth.
//
// Prompt: "Create a listing dossier for 1247 Sample Way at $325,000, I represent the seller"
// Expected tool call: create_dossier with role="seller", listing_price=325000
// Expected DB row: transactions with transaction_type ~ seller_listing / listing
// Amendment: "Add commission adjustment $500"
// Underlying form: TREC 20-17 (Residential Listing Agreement, Exclusive Right)
//
// PDF field verification is delegated to Hadley per Phase B scope.

require("./_lib/env-preload").loadEnvLocal();
const { buildConfig } = require("./_lib/config");
const { runScenario } = require("./_lib/scenario-runner");

const cfg = buildConfig(2, process.argv);

const scenario = {
  name: "Seller Listing (Single-Family, TREC 20-17)",
  address: "4471 Bluebonnet Trace",
  create_prompt:
    "Create a listing dossier for 4471 Bluebonnet Trace at $325,000, I represent the seller",
  amendment_prompt: "Add commission adjustment $500",
  expected_transaction_type: "seller_listing|listing|seller_side|seller",
  expected_subsections: ["Listing", "Deal details", "Title", "Commission"],
  underlying_form: "TREC 20-17",
  modal_steps: [
    { type: "click_button", text: "Seller Listing" },
    { type: "click_button", text: "Under Contract" },
    { type: "click_button", text: "I represent the seller side" },
    { type: "fill_labeled", label: "City / State / ZIP", value: "San Antonio, TX 78247" },
    { type: "fill_labeled", label: "Seller full name", value: "John Sample" },
    { type: "fill_labeled", label: "Listing price", value: "325000" },
  ],
};

(async () => {
  const report = await runScenario(scenario, cfg);
  const anyFail = report.test_points.some((t) => t.verdict === "FAIL");
  process.exit(anyFail ? 1 : 0);
})().catch((err) => {
  console.error("[run2] TOP-LEVEL FATAL", err);
  process.exit(3);
});
