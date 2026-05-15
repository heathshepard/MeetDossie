// Test different mediaItems formats with Zernio API
const ZERNIO_API_KEY = 'sk_c86c494854af4e4403f681982cc0150c902b2f48affafcb8c2a2859f8785eaa3';
const ZERNIO_ACCOUNT_ID = '69f25431985e734bf3d8fcbe'; // Instagram
const TEST_MEDIA_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/social-cards/instagram/2026-05-14-patricia-instagram-3.png';
const TEST_CONTENT = 'Test post from Zernio API';

const formats = [
  {
    name: 'Format 1: Array of URL strings',
    payload: {
      content: TEST_CONTENT + ' - Format 1',
      mediaItems: [TEST_MEDIA_URL],
      platforms: [{ platform: 'instagram', accountId: ZERNIO_ACCOUNT_ID }],
      publishNow: false, // Don't actually publish
    },
  },
  {
    name: 'Format 2: Array of objects without type',
    payload: {
      content: TEST_CONTENT + ' - Format 2',
      mediaItems: [{ url: TEST_MEDIA_URL }],
      platforms: [{ platform: 'instagram', accountId: ZERNIO_ACCOUNT_ID }],
      publishNow: false,
    },
  },
  {
    name: 'Format 3: Array of objects with type',
    payload: {
      content: TEST_CONTENT + ' - Format 3',
      mediaItems: [{ url: TEST_MEDIA_URL, type: 'image' }],
      platforms: [{ platform: 'instagram', accountId: ZERNIO_ACCOUNT_ID }],
      publishNow: false,
    },
  },
  {
    name: 'Format 4: Single object not array',
    payload: {
      content: TEST_CONTENT + ' - Format 4',
      mediaItems: { url: TEST_MEDIA_URL, type: 'image' },
      platforms: [{ platform: 'instagram', accountId: ZERNIO_ACCOUNT_ID }],
      publishNow: false,
    },
  },
];

async function testFormats() {
  for (const format of formats) {
    console.log(`\n=== Testing ${format.name} ===`);
    console.log('Payload:', JSON.stringify(format.payload, null, 2));

    try {
      const response = await fetch('https://zernio.com/api/v1/posts', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ZERNIO_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(format.payload),
      });

      console.log('Status:', response.status, response.statusText);

      const data = await response.json();
      console.log('Response:', JSON.stringify(data, null, 2).slice(0, 500));

      if (response.ok) {
        console.log('✅ SUCCESS - This format works!');
      } else {
        console.log('❌ FAILED');
      }
    } catch (error) {
      console.log('❌ ERROR:', error.message);
    }
  }
}

testFormats();
