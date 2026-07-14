#!/usr/bin/env node
/**
 * 40-11-template-mode.spec.js — TREC 40-11 Third Party Financing Addendum
 * via "Use TREC template" mode.
 *
 * Template roles: "Buyer", "Seller" (BUYER_SELLER_1).
 * Prefill: property_address, loan_amount, down_payment.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runTemplateWalk } = require('../_lib/template-walk');

function loadDotenv() {
  const envPath = path.resolve(__dirname, '..', '..', '..', '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadDotenv();
  const base = process.env.BASE_URL || 'https://meetdossie.com';
  const headless = process.env.HEADED === '1' ? false : true;

  const evidence = await runTemplateWalk({
    formKey: '40-11',
    base,
    headless,
    templateLabelRe: /40-11|Third Party Financing/i,
    // 40-11 template uses "Buyer" / "Seller" roles, but Dossie UI dropdown
    // only exposes "Buyer 1"/"Buyer 2"/"Seller 1"/"Seller 2". The backend
    // normalizes "Buyer 1" -> "Buyer" via normalizeRoleForTemplate for 40-11.
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    expectedRenders: [
      { key: 'property_address', re: /100 Test Ln/i, sample: '100 Test Ln' },
      // 40-11 mapper is more complex; at minimum property_address should
      // render in the header. Loan/down-payment slots are template-specific.
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
