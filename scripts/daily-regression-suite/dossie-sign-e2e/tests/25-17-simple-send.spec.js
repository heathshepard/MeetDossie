#!/usr/bin/env node
/**
 * 25-17-simple-send.spec.js — TREC 25-17 Farm & Ranch Contract via "Simple send" mode.
 *
 * Simple send: attach form_template row, click Send for sig. on the doc,
 * fill signer, click Send. Backend uses /api/esign-create.
 *
 * form_template row: 75004bb8-bac9-419c-8b25-bf4e356dc164
 *
 * Simple send DOES NOT prefill (uses /templates/pdf on raw PDF). Test asserts
 * envelope creation + email delivery + signer link opens.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runSimpleSendWalk } = require('../_lib/simple-send-walk');

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

  const evidence = await runSimpleSendWalk({
    formKey: '25-17',
    base,
    headless,
    formTemplateId: '75004bb8-bac9-419c-8b25-bf4e356dc164',
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
