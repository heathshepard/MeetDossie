#!/usr/bin/env node
"use strict";
// Run 3 — New Construction Buyer. Phase B depth.
//
// Prompt: "Create a new construction dossier for 512 Maple Bend, buyer purchase at $450,000"
// Expected tool call: create_dossier with transaction_type=new_construction
// Expected DB row: transactions with transaction_type ~ new_construction, new_home_details populated
// Amendment: "Add builder concession $3,000"
// Underlying form: TREC 23-15 (New Home Contract)

require("./_lib/env-preload").loadEnvLocal();
const { buildConfig } = require("./_lib/config");
const { runScenario } = require("./_lib/scenario-runner");

const cfg = buildConfig(3, process.argv);

const scenario = {
  name: "New Construction Buyer (TREC 23-15)",
  address: "2837 Cypress Point Ln",
  create_prompt:
    "Create a new construction dossier for 2837 Cypress Point Ln, buyer purchase at $450,000",
  amendment_prompt: "Add builder concession $3,000",
  expected_transaction_type: "new_construction|new_home|construction",
  expected_subsections: ["Builder", "Deal details", "Construction", "New home"],
  underlying_form: "TREC 23-15",
  modal_steps: [
    { type: "click_button", text: "New Construction" },
    { type: "click_button", text: "Under Contract" },
    { type: "click_button", text: "I represent the buyer side" },
    { type: "fill_labeled", label: "City / State / ZIP", value: "San Antonio, TX 78247" },
    { type: "fill_labeled", label: "Buyer full name", value: "Sarah Whitley" },
    { type: "fill_labeled", label: "Builder name", value: "Sample Builders LLC" },
    { type: "fill_labeled", label: "Sales price", value: "450000" },
  ],
};

(async () => {
  const report = await runScenario(scenario, cfg);
  const anyFail = report.test_points.some((t) => t.verdict === "FAIL");
  process.exit(anyFail ? 1 : 0);
})().catch((err) => {
  console.error("[run3] TOP-LEVEL FATAL", err);
  process.exit(3);
});
