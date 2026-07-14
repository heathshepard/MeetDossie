#!/usr/bin/env node
/**
 * 61-0-template-mode.spec.js — TREC 61-0 Groundwater Notice via
 * "Use TREC template" mode.
 *
 * Template ID 4111328, roles Buyer 1 / Seller 1 / Buyer 2 / Seller 2.
 * Field names verified from .tmp/docuseal-15-verify/tmpl_4111328.json.
 *
 * PASS = signer view renders property_address on the notice.
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
    formKey: '61-0',
    base,
    headless,
    templateLabelRe: /61-0|Groundwater/i,
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    expectedRenders: [
      { key: 'property_address', re: /100 Test Ln/i, sample: '100 Test Ln' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
