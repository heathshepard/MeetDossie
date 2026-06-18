#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const payload = {
  template_id: 4018208,
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

fetch(DOCUSEAL_BASE + '/submissions', {
  method: 'POST',
  headers: {
    'X-Auth-Token': DOCUSEAL_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
})
.then(r => r.text().then(text => ({ status: r.status, body: text })))
.then(({ status, body }) => {
  console.log('Status:', status);
  console.log('Body:', body);
})
.catch(e => console.error('ERROR:', e.message));
