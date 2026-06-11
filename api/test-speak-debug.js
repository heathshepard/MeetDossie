// Debug endpoint to diagnose speak 401 issue
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)
// Previously echoed ALL request headers including any Bearer tokens —
// hard to abuse from outside but extremely loud if scraped.
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Log EVERYTHING
  const debug = {
    method: req.method,
    url: req.url,
    headers: req.headers,
    query: req.query,
    body: req.body,
    timestamp: new Date().toISOString(),
  };

  console.log('[test-speak-debug] Full request:', JSON.stringify(debug, null, 2));

  return res.status(200).json({
    ok: true,
    message: 'Debug endpoint - check Vercel logs for full request details',
    preview: {
      method: req.method,
      hasAuth: !!req.headers.authorization,
      origin: req.headers.origin,
      contentType: req.headers['content-type'],
    }
  });
}
