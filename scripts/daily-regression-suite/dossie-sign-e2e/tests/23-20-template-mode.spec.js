#!/usr/bin/env node
/**
 * 23-20-template-mode.spec.js — TREC 23-20 New Home Incomplete Construction via
 * "Use TREC template" mode.
 *
 * Template ID 4111326. Roles Buyer 1 / Seller 1 / Buyer 2 / Seller 2.
 *
 * 2026-07-14 — KNOWN TEMPLATE DATA BUG. The DocuSeal template has ONLY 9
 * unnamed checkbox fields — no text fields for property_address / buyer_name /
 * etc. Heath must fix the template in DocuSeal Studio (re-import the raw PDF
 * with AcroForm text widgets preserved). Until then this spec exercises the
 * send + email + signer-link infrastructure but expects a blank PDF at the
 * signer view.
 *
 * PASS criteria (infrastructure only):
 *   - envelope sends
 *   - Dossie signing email arrives in mailinator
 *   - signer link opens without error
 *
 * FAIL to note: property_address does NOT appear on the signer view (template
 * data problem — separate from Dossie code).
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
    formKey: '23-20',
    base,
    headless,
    templateLabelRe: /23-20|New Home Incomplete|Incomplete Construction/i,
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    // No text field on this template (data bug documented above).
    // Assert only that the signer page loads (title text is stable).
    expectedRenders: [
      { key: 'signer_page_loaded', re: /New Home|Sign|Docuseal|Signature/i, sample: 'signer page loaded' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
