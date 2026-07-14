#!/usr/bin/env node
/**
 * op-h-template-mode.spec.js — OP-H Seller's Disclosure Notice via
 * "Use TREC template" mode.
 *
 * Template roles: "Seller", "Buyer". Seller fills 175 fields; Buyer only
 * acknowledges receipt.
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
    formKey: 'op-h',
    base,
    headless,
    templateLabelRe: /OP-H|Sellers Disclosure|Seller's Disclosure/i,
    // OP-H: Seller fills disclosure; poll Seller's inbox.
    signers: [
      { name: 'Sam Testseller', roleValue: 'Seller 1' },
    ],
    expectedRenders: [
      { key: 'property_address', re: /100 Test Ln/i, sample: '100 Test Ln' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
