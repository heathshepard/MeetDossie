#!/usr/bin/env node
/**
 * 49-1-template-mode.spec.js — TREC 49-1 Lender Appraisal Notice via
 * "Use TREC template" mode.
 *
 * NOTE: Template 4023472 has a data bug (2× "Seller 2" instead of
 * "Seller 1" + "Seller 2"). Test still passes because we only send a
 * Buyer 1.
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
    formKey: '49-1',
    base,
    headless,
    templateLabelRe: /49-1|Lender Appraisal|Termination Due to Lender/i,
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
