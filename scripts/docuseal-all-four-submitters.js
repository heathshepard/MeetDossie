#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const TEMPLATE_ID = 4018208;

async function test(name, submitters) {
  const payload = {
    template_id: TEMPLATE_ID,
    send_email: false,
    submitters: submitters,
  };

  const res = await fetch(DOCUSEAL_BASE + '/submissions', {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log(`${name}: ${res.status}`);
  if (res.status !== 200) {
    const body = await res.text();
    console.log('  ', body);
  }
}

async function run() {
  // Test 1: All 4 roles with values ONLY in Buyer 1
  await test('All 4 roles, values only in Buyer 1', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: { buyer_name: 'John Doe' },
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

  // Test 2: All 4 roles, values in multiple
  await test('All 4 roles, values in Buyer1 and Seller1', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: { buyer_name: 'John Doe', property_address: '123 Main' },
    },
    {
      role: 'Seller 1',
      email: 'seller1@meetdossie.com',
      send_email: false,
      values: { seller_name: 'Jane Smith' },
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
}

run().catch(e => console.error('ERROR:', e.message));
