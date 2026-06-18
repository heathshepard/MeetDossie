#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

async function test(templateId, name) {
  const payload = {
    template_id: templateId,
    send_email: false,
    submitters: [
      {
        role: 'Buyer',
        email: 'test@meetdossie.com',
        send_email: false,
        values: { property_address: '123 Main St' },
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

  console.log(`${name} (ID ${templateId}): ${res.status}`);
}

async function run() {
  await test(4018208, 'Resale');
  await test(4023463, 'Financing');
  await test(4023470, 'Sellers Disclosure');
}

run().catch(e => console.error('ERROR:', e.message));
