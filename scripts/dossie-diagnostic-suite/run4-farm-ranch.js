#!/usr/bin/env node
"use strict";
// Run 4 — Land Purchase (Farm & Ranch). Phase B depth.
//
// Prompt: "Create a land purchase dossier for Tract 5 County Rd 402, buyer purchase at $180,000, farm and ranch"
// Expected tool call: create_dossier with transaction_type=land / farm_ranch
// Expected DB row: land_acreage / land_legal_description populated
// Amendment: "Add water rights disclosure"
// Underlying form: TREC 25-15 (Farm & Ranch)

require("./_lib/env-preload").loadEnvLocal();
const { buildConfig } = require("./_lib/config");
const { runScenario } = require("./_lib/scenario-runner");

const cfg = buildConfig(4, process.argv);

const scenario = {
  name: "Land Purchase — Farm & Ranch (TREC 25-15)",
  address: "Tract 12 Ranch Rd 1863",
  create_prompt:
    "Create a farm and ranch dossier for Tract 12 Ranch Rd 1863, buyer purchase at $180,000",
  amendment_prompt: "Add water rights disclosure",
  expected_transaction_type: "farm_ranch|land|farm|ranch",
  expected_subsections: ["Land", "Acreage", "Deal details", "Survey"],
  underlying_form: "TREC 25-15",
  modal_steps: [
    { type: "click_button", text: "Farm" },
    { type: "click_button", text: "Under Contract" },
    { type: "click_button", text: "I represent the buyer side" },
    { type: "fill_labeled", label: "City / State / ZIP", value: "Boerne, TX 78006" },
    { type: "fill_labeled", label: "Buyer full name", value: "Sarah Whitley" },
    { type: "fill_labeled", label: "Seller name", value: "John Sample" },
    { type: "fill_labeled", label: "Sales price", value: "180000" },
    { type: "fill_labeled", label: "Acreage", value: "25" },
  ],
};

(async () => {
  const report = await runScenario(scenario, cfg);
  const anyFail = report.test_points.some((t) => t.verdict === "FAIL");
  process.exit(anyFail ? 1 : 0);
})().catch((err) => {
  console.error("[run4] TOP-LEVEL FATAL", err);
  process.exit(3);
});
