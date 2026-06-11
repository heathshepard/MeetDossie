// GET /api/test-zernio-auth
// Test Zernio API authentication and list accounts
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)
// Previously public — leaked Zernio account IDs and the last 4 chars of the API key.

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    // Test accounts endpoint
    const accountsRes = await fetch('https://zernio.com/api/v1/accounts', {
      headers: {
        'Authorization': `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const accountsText = await accountsRes.text();
    let accountsData;
    try {
      accountsData = JSON.parse(accountsText);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'Zernio returned non-JSON response',
        status: accountsRes.status,
        response: accountsText.substring(0, 500),
      });
    }

    // Expected account IDs from CLAUDE.md
    const expectedAccounts = {
      facebook: '69f253c3985e734bf3d8f9bc',
      instagram: '69f25431985e734bf3d8fcbe',
      twitter: '69f255c6985e734bf3d90ba1',
      linkedin: '69fccd7392b3d8e85f8f12be',
      tiktok: '69f15791985e734bf3d13b89',
    };

    // Parse actual accounts
    const actualAccounts = {};
    if (accountsData.accounts && Array.isArray(accountsData.accounts)) {
      accountsData.accounts.forEach(acc => {
        if (acc.isActive || acc.is_active) {
          actualAccounts[acc.platform] = {
            id: acc._id || acc.id,
            name: acc.displayName || acc.name,
            is_active: acc.isActive || acc.is_active,
          };
        }
      });
    }

    // Compare
    const comparison = {};
    Object.entries(expectedAccounts).forEach(([platform, expectedId]) => {
      const actual = actualAccounts[platform];
      comparison[platform] = {
        expected_id: expectedId,
        actual_id: actual?.id || null,
        matches: actual?.id === expectedId,
        is_active: actual?.is_active || false,
        account_name: actual?.name || null,
      };
    });

    return res.status(200).json({
      ok: accountsRes.ok,
      api_key_last_4: ZERNIO_API_KEY ? ZERNIO_API_KEY.slice(-4) : 'NOT SET',
      total_accounts: accountsData.accounts?.length || 0,
      active_accounts: Object.keys(actualAccounts).length,
      comparison,
      raw_response: accountsData,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
    });
  }
}
