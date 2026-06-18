#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const TEMPLATE_ID = 4018208;
const SUBMITTER_UUID = '00f4ba7d-7814-4426-8612-9ef9dab0c810';

const FIELDS_TO_TEST = [
  { name: 'buyer_name', value: 'John Doe' },
  { name: 'seller_name', value: 'Jane Smith' },
  { name: 'property_address', value: '123 Main St, Austin TX' },
  { name: 'Buyer Signature', value: 'X' },  // signature field
  { name: 'as_is', value: 'on' },  // checkbox
];

async function testField(fieldName, fieldValue) {
  const payload = {
    template_id: TEMPLATE_ID,
    send_email: false,
    submitters: [
      {
        role: 'Buyer 1',
        email: 'test@meetdossie.com',
        send_email: false,
        values: {
          [fieldName]: fieldValue,
        },
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

  console.log(`Field: ${fieldName} = "${fieldValue}" -> Status ${res.status}`);
}

async function run() {
  for (const field of FIELDS_TO_TEST) {
    await testField(field.name, field.value);
  }
}

run().catch(e => console.error('ERROR:', e.message));
