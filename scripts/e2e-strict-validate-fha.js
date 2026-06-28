/**
 * scripts/e2e-strict-validate-fha.js
 *
 * End-to-end staging APV for the strict_validate wire-in:
 *   1. Signs into Supabase as demo@meetdossie.com
 *   2. POSTs the v3-FHA master prompt to /api/extract-form-fields
 *   3. POSTs the extracted field_values to /api/fill-form with
 *      strict_validate:true, form_type:'resale-contract'
 *   4. Asserts response.ok===true AND validation.pass===true
 *   5. Downloads the signed-URL PDF and renders page 1 to PNG so Atlas
 *      can visually confirm the §3 sales-price tri-split landed correctly.
 *
 * Usage:
 *   node scripts/e2e-strict-validate-fha.js
 *   node scripts/e2e-strict-validate-fha.js --base https://<preview>.vercel.app
 *
 * Exit codes:
 *   0  success (PDF rendered, validation passed)
 *   1  validation failed or any pipeline error
 *   2  auth / network / setup failure
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
// Pull the public anon key from .env.local or the SUPABASE_ANON_KEY env var.
// Atlas docs note: this is the public anon key (browser-safe by design), but
// we keep it out of git per the pre-commit secret scanner pattern.
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || readDotEnvAnonKey();

function readDotEnvAnonKey() {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '.env.local'),
      'utf8'
    );
    const m =
      raw.match(/^SUPABASE_ANON_KEY=("?)(.+?)\1\s*$/m) ||
      raw.match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=("?)(.+?)\1\s*$/m) ||
      raw.match(/^VITE_SUPABASE_ANON_KEY=("?)(.+?)\1\s*$/m);
    return m ? m[2] : '';
  } catch (e) {
    return '';
  }
}

const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab';
const DEMO_TX_ID = '807dd591-d589-4019-89cf-3a805e14d421';

function argFlag(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
}
const BASE_URL = argFlag('base') || process.env.E2E_BASE_URL || 'https://meetdossie.com';

const V3_FHA_PROMPT = `Write a resale contract for 104 Wild Cherry Ln, Boerne TX 78006.
Sellers: Robert James Calloway. Buyers: Maria Elena Vasquez.
Lot 12 Block 3 Cordillera Ranch, Kendall County.
Sales price $400,000. FHA loan, $14,000 down ($386,000 financed).
Earnest money $5,000. Option fee $200, 7-day option period.
Closing 2026-08-15. Title at Texas National Title, 1100 NE Loop 410 San Antonio TX 78209.
Buyer email maria.vasquez@example.com, phone 210-555-1234.
Seller email rcalloway@example.com, phone 830-555-5678.
Buyer mailing address: 12 Buyer Way, San Antonio, TX 78258.
Listing brokerage: Keller Williams City-View. As-is condition.
Listing agent represents seller only.`;

async function signIn() {
  const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error('signIn failed ' + r.status + ': ' + text.slice(0, 300));
  }
  const j = await r.json();
  if (!j.access_token) throw new Error('signIn no access_token');
  return j.access_token;
}

async function extract(token) {
  const r = await fetch(BASE_URL + '/api/extract-form-fields', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Origin: 'https://meetdossie.com',
    },
    body: JSON.stringify({
      form_type: 'resale-contract',
      message: V3_FHA_PROMPT,
      transaction: { agent_role: 'buyer' },
    }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.ok) {
    throw new Error('extract failed ' + r.status + ': ' + JSON.stringify(j).slice(0, 400));
  }
  return j.field_values;
}

async function fillStrict(token, fieldValues) {
  const intake = {
    financing_type: 'fha',
    has_second_buyer: false,
    has_second_seller: false,
    hoa_is_subject: false,
    add_other_text: null,
  };
  const r = await fetch(BASE_URL + '/api/fill-form', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Origin: 'https://meetdossie.com',
    },
    body: JSON.stringify({
      transaction_id: DEMO_TX_ID,
      form_type: 'resale-contract',
      field_values: fieldValues,
      intake,
      source_message: V3_FHA_PROMPT,
      strict_validate: true,
    }),
  });
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j };
}

async function downloadPdf(signedUrl, outPath) {
  const r = await fetch(signedUrl);
  if (!r.ok) throw new Error('pdf download failed: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return outPath;
}

async function main() {
  console.log('[e2e] base:', BASE_URL);

  let token;
  try {
    token = await signIn();
    console.log('[e2e] signed in');
  } catch (e) {
    console.error('FATAL: signIn', e.message);
    process.exit(2);
  }

  let fieldValues;
  try {
    fieldValues = await extract(token);
    console.log(
      '[e2e] extracted field_values:',
      Object.keys(fieldValues).length,
      'fields'
    );
    console.log(JSON.stringify(fieldValues, null, 2));
  } catch (e) {
    console.error('FATAL: extract', e.message);
    process.exit(2);
  }

  const fillRes = await fillStrict(token, fieldValues);
  console.log('[e2e] fill-form status:', fillRes.status);
  console.log('[e2e] fill-form body:', JSON.stringify(fillRes.body, null, 2));

  if (fillRes.status === 200 && fillRes.body && fillRes.body.ok) {
    const v = fillRes.body.validation;
    console.log('[e2e] validation:', JSON.stringify(v, null, 2));
    if (!v || v.pass !== true) {
      console.error('FAIL: response 200 but validation did not pass');
      process.exit(1);
    }
    const url = fillRes.body.signedUrl;
    if (url) {
      const outDir = path.join(process.cwd(), '.tmp', 'e2e-strict-validate-fha');
      fs.mkdirSync(outDir, { recursive: true });
      const pdfPath = path.join(outDir, 'contract.pdf');
      await downloadPdf(url, pdfPath);
      console.log('[e2e] PDF downloaded to', pdfPath);
      console.log('SUCCESS — validation passed, PDF available for inspection');
      process.exit(0);
    }
    console.log('SUCCESS — validation passed (no signedUrl)');
    process.exit(0);
  }

  if (fillRes.status === 422 && fillRes.body && fillRes.body.validation) {
    console.error('VALIDATION FAILED:');
    console.error(JSON.stringify(fillRes.body.validation, null, 2));
    process.exit(1);
  }

  console.error('FAIL: unexpected response');
  process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
