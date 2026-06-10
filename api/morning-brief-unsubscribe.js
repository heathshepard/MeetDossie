// Vercel Serverless Function: /api/morning-brief-unsubscribe
//
// GET ?token=<base64url-userId>.<hmac>
//
// Validates the unsubscribe token (stateless HMAC-SHA256 using CRON_SECRET),
// flips profiles.morning_brief_email_enabled = false for that user, and
// renders a plain confirmation page.
//
// Token format: base64url(userId) + '.' + base64url(HMAC-SHA256(userId, CRON_SECRET))
// This matches the token minted in cron-customer-morning-brief.js.

const { createHmac } = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const userIdB64 = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  let userId;
  try {
    userId = Buffer.from(userIdB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', CRON_SECRET || 'fallback-secret')
    .update(userId)
    .digest('base64url');
  if (mac !== expected) return null;
  return userId;
}

function confirmPage(message, isError) {
  const color = isError ? '#C0392B' : '#8BA888';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dossie - Morning Brief</title>
  <style>
    body { font-family: 'Georgia', serif; background: #FDFCFA; color: #1C2B3A; margin: 0; padding: 0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { max-width: 480px; padding: 48px 40px; text-align: center; }
    .eyebrow { font-size: 12px; letter-spacing: 2px; color: #E8927C; text-transform: uppercase; font-weight: 700; margin-bottom: 18px; font-family: Arial, sans-serif; }
    h1 { font-size: 28px; line-height: 1.3; margin: 0 0 16px; color: #1C2B3A; }
    p { font-size: 16px; color: #5C6B7A; line-height: 1.7; margin: 0 0 28px; font-family: Arial, sans-serif; }
    .status { font-size: 14px; color: ${color}; font-family: Arial, sans-serif; }
    a { color: #E8927C; }
  </style>
</head>
<body>
  <div class="card">
    <div class="eyebrow">DOSSIE</div>
    <h1>${isError ? 'Something went wrong.' : 'You\'re unsubscribed.'}</h1>
    <p>${message}</p>
    <p class="status"><a href="https://meetdossie.com/app">Back to Dossie &rarr;</a></p>
  </div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const token = req.query && req.query.token;
  if (!token) {
    return res.status(400).send(confirmPage('This unsubscribe link is missing its token. Please use the link from your email.', true));
  }

  const userId = verifyToken(token);
  if (!userId) {
    return res.status(400).send(confirmPage('This unsubscribe link is invalid or expired. If you want to unsubscribe, reply to any morning brief email and ask us to stop.', true));
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).send(confirmPage('Server configuration error. Please reply to your morning brief email to unsubscribe.', true));
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ morning_brief_email_enabled: false }),
      },
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('[morning-brief-unsubscribe] PATCH failed:', r.status, detail.slice(0, 200));
      return res.status(500).send(confirmPage('We had trouble saving your preference. Please reply to a morning brief email to unsubscribe manually.', true));
    }
    return res.status(200).send(confirmPage("You won't receive morning brief emails anymore. You can re-enable them in Dossie Settings anytime.", false));
  } catch (err) {
    console.error('[morning-brief-unsubscribe] error:', err && err.message);
    return res.status(500).send(confirmPage('Something went wrong. Please reply to a morning brief email to unsubscribe manually.', true));
  }
};
