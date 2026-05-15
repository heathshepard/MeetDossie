// Test Zernio API with empty mediaItems and omitted mediaItems

const ZERNIO_API_KEY = 'sk_c86c494854af4e4403f681982cc0150c902b2f48affafcb8c2a2859f8785eaa3';

async function testEmptyArray() {
  console.log('\n=== Test 1: Empty array mediaItems: [] ===');

  const payload = {
    content: 'Test - empty mediaItems array',
    platforms: [{ platform: 'facebook', accountId: '69f253c3985e734bf3d8f9bc' }],
    publishNow: false,
    mediaItems: [],
  };

  const response = await fetch('https://zernio.com/api/v1/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('Status:', response.status);
  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2).slice(0, 300));

  return response.ok;
}

async function testOmitted() {
  console.log('\n=== Test 2: Omitted mediaItems (no field at all) ===');

  const payload = {
    content: 'Test - no mediaItems field',
    platforms: [{ platform: 'facebook', accountId: '69f253c3985e734bf3d8f9bc' }],
    publishNow: false,
    // mediaItems intentionally omitted
  };

  const response = await fetch('https://zernio.com/api/v1/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('Status:', response.status);
  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2).slice(0, 300));

  return response.ok;
}

async function runTests() {
  const emptyOk = await testEmptyArray();
  const omittedOk = await testOmitted();

  console.log('\n=== Summary ===');
  console.log('Empty array []:', emptyOk ? '✅' : '❌');
  console.log('Omitted field:', omittedOk ? '✅' : '❌');
}

runTests();
