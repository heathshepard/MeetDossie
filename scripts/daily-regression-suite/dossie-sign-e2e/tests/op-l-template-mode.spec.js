#!/usr/bin/env node
/**
 * op-l-template-mode.spec.js — OP-L Lead-Based Paint Addendum via
 * "Use TREC template" mode.
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
    formKey: 'op-l',
    base,
    headless,
    templateLabelRe: /OP-L|Lead-Based Paint|Lead Based Paint/i,
    // OP-L (Lead-Based Paint): the property_address field is owned by
    // "Seller 1" on the DocuSeal template (verified via GET
    // /templates/4023469). Sellers discloses lead paint history.
    // Test as Seller 1 so we can verify property_address renders on their
    // side of the envelope.
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
