#!/usr/bin/env node
/**
 * 11-8-template-mode.spec.js — TREC 11-8 Backup Contract via
 * "Use TREC template" mode.
 *
 * Template ID 4023578, roles Buyer 1 / Seller 1 / Buyer 2 / Seller 2.
 * Field names verified from .tmp/docuseal-15-verify/tmpl_4023578.json.
 *
 * PASS = signer view renders property_address on the backup contract.
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
    formKey: '11-8',
    base,
    headless,
    // Match the exact label "TREC 11-8 Backup Contract" while avoiding
    // "TREC 11-9 Backup Contract" — anchor on hyphen.
    templateLabelRe: /11-8\s+Backup|Backup Contract.*11-8/i,
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
