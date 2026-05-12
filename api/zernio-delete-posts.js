// Temporary helper endpoint to delete posts from Zernio
// DELETE THIS FILE after use

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

  const { accountId, postIds } = req.body || {};

  if (req.method === 'GET') {
    // List posts for an account
    if (!accountId) {
      return res.status(400).json({ ok: false, error: 'accountId required' });
    }

    try {
      const listRes = await fetch(`https://zernio.com/api/v1/posts?accountId=${accountId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${ZERNIO_API_KEY}`,
          'Content-Type': 'application/json',
        },
      });

      const text = await listRes.text();
      let data = null;
      try { data = JSON.parse(text); } catch { data = null; }

      return res.status(listRes.status).json({
        ok: listRes.ok,
        status: listRes.status,
        data,
        rawText: text.slice(0, 500),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    // Delete posts by ID
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ ok: false, error: 'postIds array required' });
    }

    const results = [];
    for (const postId of postIds) {
      try {
        const delRes = await fetch(`https://zernio.com/api/v1/posts/${postId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${ZERNIO_API_KEY}`,
          },
        });

        results.push({
          postId,
          ok: delRes.ok,
          status: delRes.status,
        });
      } catch (err) {
        results.push({
          postId,
          ok: false,
          error: err.message,
        });
      }
    }

    return res.status(200).json({ ok: true, results });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
};
