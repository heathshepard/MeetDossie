// Test exact Zernio format that worked for Facebook, then add mediaItems for Instagram

const ZERNIO_API_KEY = 'sk_c86c494854af4e4403f681982cc0150c902b2f48affafcb8c2a2859f8785eaa3';

// First, test the exact Facebook format (no mediaItems, text only)
async function testFacebookFormat() {
  console.log('\n=== Testing Facebook format (no mediaItems) ===');

  const payload = {
    content: 'Test post from direct API call - Facebook format',
    platforms: [{ platform: 'facebook', accountId: '69f253c3985e734bf3d8f9bc' }],
    publishNow: false, // Draft only
  };

  console.log('Request body:', JSON.stringify(payload, null, 2));

  const response = await fetch('https://zernio.com/api/v1/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('Status:', response.status, response.statusText);
  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2).slice(0, 500));

  return response.ok;
}

// Then test Instagram with mediaItems added
async function testInstagramFormat() {
  console.log('\n=== Testing Instagram format (with mediaItems) ===');

  const payload = {
    content: 'Test post from direct API call - Instagram format with media',
    platforms: [{ platform: 'instagram', accountId: '69f25431985e734bf3d8fcbe' }],
    publishNow: false, // Draft only
    mediaItems: [{
      url: 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/social-cards/instagram/2026-05-14-patricia-instagram-3.png',
      type: 'image'
    }],
  };

  console.log('Request body:', JSON.stringify(payload, null, 2));

  const response = await fetch('https://zernio.com/api/v1/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('Status:', response.status, response.statusText);
  const data = await response.json();
  console.log('Response:', JSON.stringify(data, null, 2));

  return response.ok;
}

async function runTests() {
  const fbOk = await testFacebookFormat();
  const igOk = await testInstagramFormat();

  console.log('\n=== Summary ===');
  console.log('Facebook format:', fbOk ? '✅ SUCCESS' : '❌ FAILED');
  console.log('Instagram format:', igOk ? '✅ SUCCESS' : '❌ FAILED');
}

runTests();
