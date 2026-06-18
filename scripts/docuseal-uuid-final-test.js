#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const TEMPLATE_ID = 4018208;

async function testCorrectFormat() {
  console.log('TEST: Submit using submitter_uuid with field values\n');

  const payload = {
    template_id: TEMPLATE_ID,
    send_email: false,
    submitters: [
      {
        submitter_uuid: '00f4ba7d-7814-4426-8612-9ef9dab0c810',  // The Shared/Buyer1 UUID
        email: 'buyer1@meetdossie.com',
        send_email: false,
        values: {
          buyer_name: 'John Doe',
          seller_name: 'Jane Smith',
          property_address: '123 Main St, Austin TX 78701',
          sales_price: '350000',
          earnest_money_amount: '10000',
        },
      },
    ],
  };

  console.log('PAYLOAD:');
  console.log(JSON.stringify(payload, null, 2));

  const res = await fetch(DOCUSEAL_BASE + '/submissions', {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('\nRESPONSE STATUS:', res.status);
  const body = await res.text();
  
  if (res.status === 200) {
    console.log('SUCCESS!');
    const parsed = JSON.parse(body);
    console.log('Response is array of', parsed.length, 'submitter(s)');
    console.log('First submitter email:', parsed[0].email);
    console.log('First submitter status:', parsed[0].status);
  } else {
    console.log('ERROR:', body);
  }
}

testCorrectFormat().catch(e => console.error('FATAL:', e.message));
