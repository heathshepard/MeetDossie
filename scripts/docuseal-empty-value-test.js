#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const TEMPLATE_ID = 4018208;

async function test(name, values) {
  const payload = {
    template_id: TEMPLATE_ID,
    send_email: false,
    submitters: [
      {
        role: 'Buyer 1',
        email: 'test@meetdossie.com',
        send_email: false,
        values: values,
      },
    ],
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
    console.log('  Error:', body);
  }
}

async function run() {
  await test('Empty string value', { buyer_name: '' });
  await test('Null value', { buyer_name: null });
  await test('Zero', { earnest_money_amount: 0 });
  await test('Boolean true', { as_is: true });
  await test('Boolean false', { as_is: false });
  await test('String "true"', { as_is: 'true' });
  await test('String "X"', { as_is: 'X' });
  await test('Whitespace only', { buyer_name: '   ' });
  await test('Very long string', { buyer_name: 'A'.repeat(1000) });
}

run().catch(e => console.error('ERROR:', e.message));
