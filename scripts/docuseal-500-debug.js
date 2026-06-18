#!/usr/bin/env node
/**
 * DocuSeal 500 Error Debugging
 * Runs 5 controlled experiments to isolate the HTTP 500 cause
 * Usage: node scripts/docuseal-500-debug.js
 */

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

if (!DOCUSEAL_API_KEY) {
  console.error('ERROR: DOCUSEAL_API_KEY not set');
  process.exit(1);
}

// Template 4018208 is resale contract with roles: Buyer 1, Seller 1, Buyer 2, Seller 2
const TEMPLATE_ID = 4018208;

// Sample field values (from TREC 20-19)
const SAMPLE_FIELDS = {
  buyer_name: 'John Doe',
  seller_name: 'Jane Smith',
  property_address: '123 Main St, Austin TX 78701',
  sales_price: '350000',
  closing_date: '2026-06-30',
  earnest_money_amount: '10000',
  option_period_days: '10',
  option_fee: '500',
  title_company_name: 'ABC Title Co',
};

async function submitToDocuSeal(name, submitters) {
  const payload = {
    template_id: TEMPLATE_ID,
    send_email: false,
    submitters: submitters,
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`EXPERIMENT: ${name}`);
  console.log(`${'='.repeat(60)}`);
  console.log('\nPAYLOAD SENT:');
  console.log(JSON.stringify(payload, null, 2));

  let res;
  let responseBody;
  let responseHeaders;

  try {
    res = await fetch(DOCUSEAL_BASE + '/submissions', {
      method: 'POST',
      headers: {
        'X-Auth-Token': DOCUSEAL_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeout: 30000,
    });

    responseHeaders = Object.fromEntries(res.headers.entries());
    responseBody = await res.text();

    console.log('\nRESPONSE STATUS:', res.status);
    console.log('RESPONSE HEADERS:', JSON.stringify(responseHeaders, null, 2));
    console.log('RESPONSE BODY:');
    console.log(responseBody);

    if (res.ok) {
      console.log('\n✓ SUCCESS');
      try {
        const json = JSON.parse(responseBody);
        console.log('Parsed JSON submission ID:', json.id);
        console.log('Documents count:', json.documents ? json.documents.length : 0);
      } catch (e) {
        // Body is not JSON
      }
    } else {
      console.log('\n✗ FAILED (HTTP ' + res.status + ')');
    }
  } catch (err) {
    console.log('\n✗ NETWORK ERROR:', err.message);
  }

  return { status: res.status, body: responseBody };
}

async function run() {
  console.log('DocuSeal 500 Debug — Template ID:', TEMPLATE_ID);

  // Experiment 1: Only Buyer 1 (skip others), empty values
  await submitToDocuSeal('Experiment 1: Buyer 1 only, EMPTY values{}', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: {},
    },
  ]);

  // Experiment 2: Buyer 1 with 1 field
  await submitToDocuSeal('Experiment 2: Buyer 1 only, 1 field (buyer_name)', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: { buyer_name: 'John Doe' },
    },
  ]);

  // Experiment 3: Buyer 1 with 5 fields
  await submitToDocuSeal('Experiment 3: Buyer 1 only, 5 fields', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: {
        buyer_name: SAMPLE_FIELDS.buyer_name,
        property_address: SAMPLE_FIELDS.property_address,
        sales_price: SAMPLE_FIELDS.sales_price,
        earnest_money_amount: SAMPLE_FIELDS.earnest_money_amount,
        option_period_days: SAMPLE_FIELDS.option_period_days,
      },
    },
  ]);

  // Experiment 4: Buyer 1 with all 9 sample fields
  await submitToDocuSeal('Experiment 4: Buyer 1 only, all 9 sample fields', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: SAMPLE_FIELDS,
    },
  ]);

  // Experiment 5: All 4 submitters with empty values
  await submitToDocuSeal('Experiment 5: All 4 submitters (Buyer 1, Seller 1, Buyer 2, Seller 2), EMPTY values{}', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: {},
    },
    {
      role: 'Seller 1',
      email: 'seller1@meetdossie.com',
      send_email: false,
      values: {},
    },
    {
      role: 'Buyer 2',
      email: 'buyer2@meetdossie.com',
      send_email: false,
      values: {},
    },
    {
      role: 'Seller 2',
      email: 'seller2@meetdossie.com',
      send_email: false,
      values: {},
    },
  ]);

  console.log('\n' + '='.repeat(60));
  console.log('EXPERIMENTS COMPLETE');
  console.log('='.repeat(60));
}

run().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
