#!/usr/bin/env node
/**
 * 24-20-template-mode.spec.js — TREC 24-20 New Home Complete Construction via
 * "Use TREC template" mode.
 *
 * Template ID 4111327. Roles: ONLY "First Party" per verify JSON.
 *
 * 2026-07-14 — KNOWN TEMPLATE DATA BUG (verified via DocuSeal API 2026-07-14):
 *   POST /submissions template_id=4111327 → 422 "Template does not contain fields"
 * The template has ZERO fields at all (no text widgets, no signature widgets)
 * AND only one submitter ("First Party"). DocuSeal refuses to create ANY
 * submission for a template with zero fields — this is core DocuSeal rules.
 *
 * REQUIRED ADMIN FIX (Heath):
 *   1. Open DocuSeal Studio at https://docuseal.com/templates/4111327
 *   2. Add signature/date widgets for each submitter role
 *   3. Split "First Party" into Buyer 1 / Buyer 2 / Seller 1 / Seller 2
 *   4. Add at minimum: property_address text field (page 1)
 *   5. Re-run this spec — 4-role prefill + roles will flow through
 *      (TEMPLATE_ROLES['4111327'] must be updated back to 4-role after fix).
 *
 * Test result: FAIL until the template is fixed. This is NOT a Dossie bug —
 * it's a DocuSeal template configuration bug. This spec exists so the
 * failure surfaces in every regression run + won't silently drift.
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
