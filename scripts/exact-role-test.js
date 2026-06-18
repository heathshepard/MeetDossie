#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

async function test(name, payload) {
  const res = await fetch(DOCUSEAL_BASE + '/submissions', {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  console.log(`\n${name}`);
  console.log(`Status: ${res.status}`);
  console.log(`Body: ${body}`);
}

async function run() {
  await test('Test 1: Exact role "Buyer 1", no values', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      {
        role: 'Buyer 1',
        email: 'test@meetdossie.com',
        send_email: false,
        values: {},
      },
    ],
  });

  await test('Test 2: Exact role "Buyer 1", with buyer_name', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      {
        role: 'Buyer 1',
        email: 'test@meetdossie.com',
        send_email: false,
        values: { buyer_name: 'John Doe' },
      },
    ],
  });

  await test('Test 3: All 4 exact roles, no values', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer 1', email: 'b1@test.com', send_email: false, values: {} },
      { role: 'Seller 1', email: 's1@test.com', send_email: false, values: {} },
      { role: 'Buyer 2', email: 'b2@test.com', send_email: false, values: {} },
      { role: 'Seller 2', email: 's2@test.com', send_email: false, values: {} },
    ],
  });

  await test('Test 4: All 4 exact roles, values in Buyer 1 only', {
    template_id: 4018208,
    send_email: false,
    submitters: [
      { role: 'Buyer 1', email: 'b1@test.com', send_email: false, values: { buyer_name: 'John Doe' } },
      { role: 'Seller 1', email: 's1@test.com', send_email: false, values: {} },
      { role: 'Buyer 2', email: 'b2@test.com', send_email: false, values: {} },
      { role: 'Seller 2', email: 's2@test.com', send_email: false, values: {} },
    ],
  });
}

run().catch(e => console.error('ERROR:', e.message));
