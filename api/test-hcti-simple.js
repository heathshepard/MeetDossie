// Test HCTI with simple HTML
const fetch = require('node-fetch');

module.exports = async function handler(req, res) {
  // Auth check
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expectedAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const HCTI_USER_ID = process.env.HCTI_USER_ID;
  const HCTI_API_KEY = process.env.HCTI_API_KEY;

  if (!HCTI_USER_ID || !HCTI_API_KEY) {
    return res.status(500).json({ ok: false, error: 'HCTI credentials not configured' });
  }

  const simpleHTML = '<div style="background:#F5EDE4;width:800px;height:400px;display:flex;align-items:center;justify-content:center;"><h1 style="color:#1a1a2e;">Clear to Close.</h1></div>';

  try {
    const authHeader = Buffer.from(`${HCTI_USER_ID}:${HCTI_API_KEY}`).toString('base64');

    const response = await fetch('https://hcti.io/v1/image', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ html: simpleHTML }),
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    return res.status(200).json({
      ok: response.ok,
      status: response.status,
      response: responseData,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
