// Vercel Serverless Function: /api/delete-claudy-webhook
// Delete Claudy's webhook so it can use polling (getUpdates) instead
//
// GET /api/delete-claudy-webhook
// Returns: { ok: true, result: {...} }

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`;
    const response = await fetch(url);
    const data = await response.json();

    return res.status(200).json({
      ok: response.ok && data.ok,
      timestamp: new Date().toISOString(),
      result: data
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};
