#!/usr/bin/env node
/**
 * 20-19-template-mode.spec.js — TREC 20-19 Resale Contract via
 * "Use TREC template" mode.
 *
 * Full walk:
 *   1. Sign in as demo on prod meetdossie.com
 *   2. Seed test dossier w/ property_address, buyer_name, seller_name,
 *      sale_price, closing_date
 *   3. Open dossier → click Generate + Sign
 *   4. Fill Buyer 1 signer w/ mailinator address
 *   5. Select "TREC 20-19 Resale Contract" template
 *   6. Click Send for Signature
 *   7. Poll mailinator for the signing email
 *   8. Open the DocuSeal signing URL
 *   9. Verify the signer view PDF renders the transaction values
 *
 * PASS = evidence.json shows steps all PASS + video + email HTML +
 *        signer-view screenshot + signer-view-text.txt with expected values.
 *
 * USAGE:
 *   node scripts/daily-regression-suite/dossie-sign-e2e/tests/20-19-template-mode.spec.js
 *   BASE_URL=https://staging-preview.vercel.app node ...
 *   HEADED=1 node ...
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
    formKey: '20-19',
    base,
    headless,
    templateLabelRe: /20-19|Resale|One to Four/i,
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    expectedRenders: [
      { key: 'property_address', re: /100 Test Ln/i, sample: '100 Test Ln' },
      { key: 'buyer_name', re: /Alex Testbuyer/i, sample: 'Alex Testbuyer' },
      { key: 'seller_name', re: /Sam Testseller/i, sample: 'Sam Testseller' },
      { key: 'sale_price', re: /525[,.]?000|525000/i, sample: '525000' },
      { key: 'closing_date', re: /2026-08-15|08\/15\/2026|Aug.*15.*2026/i, sample: '2026-08-15' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
