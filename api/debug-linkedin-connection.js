// Debug LinkedIn connection and publish test post
// DELETE THIS FILE after debugging

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!ZERNIO_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ZERNIO_API_KEY not configured' });
  }

  const results = {};

  // Step 1: Get all Zernio accounts to see LinkedIn details
  try {
    const accountsRes = await fetch('https://zernio.com/api/v1/accounts', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const accountsText = await accountsRes.text();
    let accountsData = null;
    try { accountsData = JSON.parse(accountsText); } catch {}

    results.accounts = {
      ok: accountsRes.ok,
      status: accountsRes.status,
      data: accountsData,
    };

    // Find LinkedIn account details
    if (accountsData && accountsData.accounts) {
      const linkedinAccount = accountsData.accounts.find(a => a.platform === 'linkedin');
      results.linkedinAccount = linkedinAccount || null;
    }
  } catch (err) {
    results.accountsError = err.message;
  }

  // Step 2: Publish a unique test post to LinkedIn
  const timestamp = new Date().toISOString();
  const uniqueContent = `Testing LinkedIn connection - ${timestamp}

This is a test post from Dossie to verify LinkedIn publishing is working correctly.

If you see this post on linkedin.com/company/meetdossie, the integration is working.

#test #meetdossie #verification`;

  const linkedinAccountId = '69fccd7392b3d8e85f8f12be';

  try {
    const postRes = await fetch('https://zernio.com/api/v1/posts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platforms: [
          {
            platform: 'linkedin',
            accountId: linkedinAccountId,
          }
        ],
        content: uniqueContent,
        scheduledFor: new Date().toISOString(),
      }),
    });

    const postText = await postRes.text();
    let postData = null;
    try { postData = JSON.parse(postText); } catch {}

    results.publish = {
      ok: postRes.ok,
      status: postRes.status,
      data: postData,
      timestamp,
    };
  } catch (err) {
    results.publishError = err.message;
  }

  return res.status(200).json(results);
};
