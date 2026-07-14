#!/usr/bin/env node
/**
 * 20-19-place-fields.spec.js — TREC 20-19 Resale Contract via "Place fields" mode.
 *
 * Place Fields mode: agent attaches doc, opens EsignModal, clicks "Place fields"
 * tab, drags signature/date fields onto PDF canvas, sends.
 *
 * This walk exercises the tab + canvas render + send path. Full DnD field
 * placement via Playwright is deferred — the underlying /api/esign-create
 * code path is identical to Simple Send when fields array is empty, and
 * this walk asserts the tab + canvas UI loads without crashing so agents
 * can use it. Real DnD coverage is a future extension.
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
    formKey: '20-19',
    base,
    headless,
    formTemplateId: 'a6114e4e-35b7-42af-8a90-375ae7ff608f',
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    expectedRenders: [
      { key: 'signer_page_loaded', re: /Sign|DocuSeal|Signature|Contract/i, sample: 'signer page loaded' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
