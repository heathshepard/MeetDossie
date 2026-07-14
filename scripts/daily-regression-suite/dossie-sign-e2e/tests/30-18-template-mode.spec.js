#!/usr/bin/env node
/**
 * 30-18-template-mode.spec.js — TREC 30-18 Condominium Contract via
 * "Use TREC template" mode.
 *
 * Template ID 4111324, roles Buyer 1 / Seller 1 / Buyer 2 / Seller 2.
 * Field names verified from .tmp/docuseal-15-verify/tmpl_4111324.json (228 fields).
 * Has buyer_name, seller_name, property_address + header_property_address_p2.
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
    formKey: '30-18',
    base,
    headless,
    templateLabelRe: /30-18|Condominium|Condo/i,
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    expectedRenders: [
      // Signer is Buyer 1; property_address and buyer_name are owned by
      // Buyer 1 so they render in that signer's interactive view. seller_name
      // is owned by Seller 1 so Buyer 1 does not see it in DocuSeal's
      // per-role field visibility.
      { key: 'property_address', re: /100 Test Ln/i, sample: '100 Test Ln' },
      { key: 'buyer_name', re: /Alex Testbuyer/i, sample: 'Alex Testbuyer' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
