// Test the exact Instagram post payload that n8n would send

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;

// This is the exact Patricia Instagram post content
const payload = {
  content: `She closed 6 deals this month.

And spent 14 hours on follow-up emails.

That is $8,000 a year. For email follow-ups.

Patricia used to write every email by hand. Title company updates. Lender follow-ups. Inspection reminders.

Every single one.

Her TC handles some of it. But not everything. And her TC does not work nights.

Dossie drafts follow-ups in seconds. She reviews them. She hits send.

2 minutes instead of 20.

The work still gets done. The tone is still hers. The clients still feel taken care of.

But she is not writing emails at 9 PM anymore.

This is Dossie.

Texas agents — meetdossie.com slash founding

#txrealestate #transactioncoordination #realtorlife #closingdeals #realestatebusiness #texasrealtor #realestatetech #agentproductivity`,
  platforms: [
    {
      platform: 'instagram',
      accountId: '69f25431985e734bf3d8fcbe'
    }
  ],
  publishNow: true, // Actually publish this time
  mediaItems: [
    {
      url: 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/social-cards/instagram/2026-05-14-patricia-instagram-3.png',
      type: 'image'
    }
  ]
};

async function testPost() {
  console.log('Testing exact Instagram post from database...\n');
  console.log('Request body:', JSON.stringify(payload, null, 2));
  console.log('\nSending to Zernio...');

  const response = await fetch('https://zernio.com/api/v1/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  console.log('\nStatus:', response.status, response.statusText);
  const data = await response.json();
  console.log('\nResponse:', JSON.stringify(data, null, 2));

  if (response.ok && data.message === 'Post published successfully') {
    console.log('\n✅ SUCCESS - Post published to Instagram!');
    if (data.post?.platforms?.[0]?.platformPostUrl) {
      console.log('URL:', data.post.platforms[0].platformPostUrl);
    }
  } else {
    console.log('\n❌ FAILED');
  }
}

testPost();
