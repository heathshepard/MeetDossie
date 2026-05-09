// Vercel Serverless Function: /api/get-telegram-token
// Return the TELEGRAM_BOT_TOKEN from Vercel env vars (for debugging)
//
// GET /api/get-telegram-token
// Returns: { token: "..." (first 20 chars), configured: true/false }

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  return res.status(200).json({
    configured: !!TELEGRAM_BOT_TOKEN,
    tokenPreview: TELEGRAM_BOT_TOKEN ? TELEGRAM_BOT_TOKEN.slice(0, 20) + '...' : null,
    tokenLength: TELEGRAM_BOT_TOKEN ? TELEGRAM_BOT_TOKEN.length : 0
  });
};
