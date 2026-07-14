#!/usr/bin/env node
/**
 * 39-11-place-fields.spec.js — TREC 39-11 Amendment to Contract via "Place fields" mode.
 *
 * Attaches form_template, clicks Send for sig., clicks Place fields tab,
 * verifies canvas render, fills signer, sends. Same backend path as Simple
 * Send when fields payload is empty. Real DnD field placement deferred.
 *
 * form_template row: d5d4cbc1-0c83-4e4f-8842-4d67bbfaf167
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runPlaceFieldsWalk } = require('../_lib/place-fields-walk');

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

  const evidence = await runPlaceFieldsWalk({
    formKey: '39-11',
    base,
    headless,
    formTemplateId: 'd5d4cbc1-0c83-4e4f-8842-4d67bbfaf167',
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    expectedRenders: [
      { key: 'signer_page_loaded', re: /Sign|DocuSeal|Signature|Contract|Addendum|Disclosure|Notice/i, sample: 'signer page loaded' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
