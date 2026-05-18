// Test HCTI with inline-style milestone card
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

  const inlineHTML = '<div style="background:linear-gradient(135deg,#F5EDE4,#ffffff);width:800px;height:400px;border:4px solid #A48531;padding:40px;font-family:Georgia,serif;display:flex;flex-direction:column;justify-content:center;"><p style="color:#A48531;font-size:14px;text-transform:uppercase;letter-spacing:2px;margin:0 0 12px;">Milestone</p><h1 style="color:#1a1a2e;font-size:48px;margin:0 0 12px;">Clear to Close.</h1><p style="color:#8B6F6F;font-size:18px;margin:0;">Stack of paperwork: handled.</p></div>';

  try {
    const authHeader = Buffer.from(`${HCTI_USER_ID}:${HCTI_API_KEY}`).toString('base64');

    const response = await fetch('https://hcti.io/v1/image', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: inlineHTML,
        google_fonts: true,
        ms_delay: 2000,
      }),
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
      html_preview: inlineHTML.slice(0, 200) + '...',
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
};
