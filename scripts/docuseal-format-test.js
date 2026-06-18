#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const TEMPLATE_ID = 4018208;

async function testFormat(name, submitterObj) {
  const payload = {
    template_id: TEMPLATE_ID,
    send_email: false,
    submitters: [submitterObj],
  };

  const res = await fetch(DOCUSEAL_BASE + '/submissions', {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  console.log(`${name}: Status ${res.status}`);
  if (res.status !== 200) {
    console.log('  Response:', body);
  }
}

async function run() {
  // Current format (object)
  await testFormat('Format 1: values as object {}', {
    role: 'Buyer 1',
    email: 'test@meetdossie.com',
    send_email: false,
    values: { buyer_name: 'John Doe' },
  });

  // Array format
  await testFormat('Format 2: values as array [{ field: ..., value: ... }]', {
    role: 'Buyer 1',
    email: 'test@meetdossie.com',
    send_email: false,
    values: [{ field: 'buyer_name', value: 'John Doe' }],
  });

  // Flat values array
  await testFormat('Format 3: values as string array ["field:value"]', {
    role: 'Buyer 1',
    email: 'test@meetdossie.com',
    send_email: false,
    values: ['buyer_name:John Doe'],
  });

  // No values field
  await testFormat('Format 4: no values field', {
    role: 'Buyer 1',
    email: 'test@meetdossie.com',
    send_email: false,
  });
}

run().catch(e => console.error('ERROR:', e.message));
