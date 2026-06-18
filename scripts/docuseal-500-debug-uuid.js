#!/usr/bin/env node
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

const TEMPLATE_ID = 4018208;

// From previous investigation
const SUBMITTER_UUIDS = {
  'all_fields': '00f4ba7d-7814-4426-8612-9ef9dab0c810',
  'seller1': '6b4f8316-80bd-46f5-ac26-268a2d28ebb1',
  'buyer2': 'aa294ea5-848a-4202-aadb-539792c9a0cf',
  'seller2': '81fb81d2-8b0c-4fd7-8468-bd2a0e66dd7f',
};

async function submit(name, submitters) {
  const payload = {
    template_id: TEMPLATE_ID,
    send_email: false,
    submitters: submitters,
  };

  console.log(`\n${name}`);
  console.log('Submitters:', JSON.stringify(submitters, null, 2));

  const res = await fetch(DOCUSEAL_BASE + '/submissions', {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('Status:', res.status);
  const body = await res.text();
  if (res.status !== 200) {
    console.log('Error:', body);
  } else {
    console.log('Success (truncated):', body.substring(0, 200));
  }
}

async function run() {
  // Test 1: WITH submitter_uuid instead of role
  await submit('TEST 1: With submitter_uuid (00f4ba7d...)', [
    {
      submitter_uuid: SUBMITTER_UUIDS['all_fields'],
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: { buyer_name: 'John Doe' },
    },
  ]);

  // Test 2: Original approach (role name) for comparison
  await submit('TEST 2: With role name "Buyer 1"', [
    {
      role: 'Buyer 1',
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: { buyer_name: 'John Doe' },
    },
  ]);

  // Test 3: Multiple submitters with UUIDs
  await submit('TEST 3: All 4 submitters with UUIDs + empty values', [
    {
      submitter_uuid: SUBMITTER_UUIDS['all_fields'],
      email: 'buyer1@meetdossie.com',
      send_email: false,
      values: {},
    },
    {
      submitter_uuid: SUBMITTER_UUIDS['seller1'],
      email: 'seller1@meetdossie.com',
      send_email: false,
      values: {},
    },
    {
      submitter_uuid: SUBMITTER_UUIDS['buyer2'],
      email: 'buyer2@meetdossie.com',
      send_email: false,
      values: {},
    },
    {
      submitter_uuid: SUBMITTER_UUIDS['seller2'],
      email: 'seller2@meetdossie.com',
      send_email: false,
      values: {},
    },
  ]);
}

run().catch(e => console.error('FATAL:', e.message));
