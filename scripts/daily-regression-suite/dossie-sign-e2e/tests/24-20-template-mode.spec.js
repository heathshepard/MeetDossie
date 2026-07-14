#!/usr/bin/env node
/**
 * 24-20-template-mode.spec.js — TREC 24-20 New Home Complete Construction via
 * "Use TREC template" mode.
 *
 * Template ID 4111327. Roles: ONLY "First Party" per verify JSON.
 *
 * 2026-07-14 — KNOWN TEMPLATE DATA BUG. This template has ZERO fields at all
 * (no text, no signature widgets) AND only one submitter ("First Party").
 * Heath must fix the template in DocuSeal Studio (re-import raw PDF + split
 * submitters into Buyer 1 / Seller 1 / Buyer 2 / Seller 2). Until then, the
 * routing collapses all roles to "First Party" (see TEMPLATE_ROLES['4111327']).
 *
 * PASS criteria (infrastructure only):
 *   - envelope sends without 500 error
 *   - Dossie signing email arrives in mailinator
 *   - signer link opens without error
 *
 * FAIL to note: property_address and everything else missing from signer view.
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
    formKey: '24-20',
    base,
    headless,
    templateLabelRe: /24-20|New Home Complete|Completed Construction/i,
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    expectedRenders: [
      { key: 'signer_page_loaded', re: /New Home|Sign|Docuseal|Signature|First Party/i, sample: 'signer page loaded' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
