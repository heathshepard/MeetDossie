// Vercel Serverless Function: /api/check-creatomate-render
// Check status of a Creatomate render
//
// GET /api/check-creatomate-render?renderId=<id>
// Returns: { ok: true, render: {...} }

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  // Auth added 2026-06-10 (Atlas).
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!CREATOMATE_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'CREATOMATE_API_KEY not configured'
    });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const renderId = req.query.renderId;
  if (!renderId) {
    return res.status(400).json({
      ok: false,
      error: 'Missing renderId query parameter'
    });
  }

  try {
    console.log(`[check-creatomate-render] Checking render ${renderId}`);

    const response = await fetch(`https://api.creatomate.com/v1/renders/${renderId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CREATOMATE_API_KEY}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[check-creatomate-render] Creatomate API error:', response.status, errorText);
      return res.status(response.status).json({
        ok: false,
        error: `Creatomate API error: ${response.status} ${errorText}`,
      });
    }

    const render = await response.json();

    console.log('[check-creatomate-render] Render status:', JSON.stringify(render, null, 2));

    return res.status(200).json({
      ok: true,
      render: render
    });

  } catch (error) {
    console.error('[check-creatomate-render] error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to check render status',
    });
  }
};
