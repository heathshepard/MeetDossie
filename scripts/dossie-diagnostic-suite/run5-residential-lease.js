#!/usr/bin/env node
"use strict";
// Run 5 — Residential Lease. Phase B depth.
//
// Prompt: "Create a lease dossier for 8934 Oakview Dr, landlord tenant lease $2,400/mo"
// Expected tool call: create_dossier with transaction_type=lease
// Expected DB row: lease_monthly_rent, lease-specific fields populated
// Amendment: "Add pet fee $500"
// Underlying form: TAR 2001 (Residential Lease)

require("./_lib/env-preload").loadEnvLocal();
const { buildConfig } = require("./_lib/config");
const { runScenario } = require("./_lib/scenario-runner");

const cfg = buildConfig(5, process.argv);

const scenario = {
  name: "Residential Lease (TAR 2001)",
  address: "6152 Live Oak Manor",
  create_prompt:
    "Create a lease dossier for 6152 Live Oak Manor, landlord side, rent $2,400/mo",
  amendment_prompt: "Add pet fee $500",
  expected_transaction_type: "lease|residential_lease|rental",
  expected_subsections: ["Lease", "Tenant", "Landlord", "Rent"],
  underlying_form: "TAR 2001",
  modal_steps: [
    { type: "click_button", text: "Residential Lease" },
    { type: "click_button", text: "Under Contract" },
    { type: "click_button", text: "I represent the landlord side" },
    { type: "fill_labeled", label: "City / State / ZIP", value: "San Antonio, TX 78247" },
    { type: "fill_labeled", label: "Tenant full name", value: "Jane Renter" },
    { type: "fill_labeled", label: "Landlord name", value: "John Sample" },
    { type: "fill_labeled", label: "Monthly rent", value: "2400" },
  ],
};

(async () => {
  const report = await runScenario(scenario, cfg);
  const anyFail = report.test_points.some((t) => t.verdict === "FAIL");
  process.exit(anyFail ? 1 : 0);
})().catch((err) => {
  console.error("[run5] TOP-LEVEL FATAL", err);
  process.exit(3);
});
