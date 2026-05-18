// Test HCTI API with current card template
const fetch = require('node-fetch');

const COLORS = {
  BLUSH: '#F5EDE4',
  CORAL: '#C17B5C',
  SAGE: '#6B8E68',
  NAVY: '#1A1A2E',
  GOLD: '#C9A96E',
  WHITE: '#FFFFFF',
};

function buildTestHTML() {
  const W = 1080;
  const H = 1080;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@700&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 0;
      width: ${W}px;
      height: ${H}px;
      background: ${COLORS.BLUSH};
      font-family: 'Plus Jakarta Sans', sans-serif;
      overflow: hidden;
    }
    .card {
      width: ${W}px;
      height: ${H}px;
      padding: 70px 76px;
      position: relative;
      display: flex;
      flex-direction: column;
    }
    .stat {
      font-family: 'Cormorant Garamond', serif;
      font-weight: 700;
      font-size: 96px;
      line-height: 1.05;
      color: ${COLORS.CORAL};
      margin-bottom: 27px;
    }
    .stat-label {
      font-size: 28px;
      line-height: 1.3;
      color: ${COLORS.NAVY};
      margin-bottom: 43px;
    }
    .hook-container {
      display: flex;
      align-items: flex-start;
      margin-bottom: 43px;
    }
    .hook-divider {
      width: 3px;
      height: 27px;
      background: ${COLORS.SAGE};
      margin-right: 15px;
      flex-shrink: 0;
    }
    .hook {
      font-weight: 700;
      font-size: 32px;
      line-height: 1.2;
      color: ${COLORS.NAVY};
    }
    .body-container {
      display: flex;
      align-items: flex-start;
      margin-bottom: auto;
    }
    .body-bar {
      width: 4px;
      background: ${COLORS.GOLD};
      margin-right: 22px;
      flex-shrink: 0;
      align-self: stretch;
    }
    .body {
      font-size: 30px;
      line-height: 1.65;
      color: ${COLORS.NAVY};
    }
    .bottom-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 43px;
    }
    .pill {
      background: ${COLORS.GOLD};
      color: ${COLORS.WHITE};
      padding: 32px 20px;
      border-radius: 32px;
      font-size: 22px;
    }
    .url {
      font-weight: 600;
      font-size: 24px;
      color: ${COLORS.SAGE};
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="stat">$8,000</div>
    <div class="stat-label">per year for a solo TC</div>
    <div class="hook-container">
      <div class="hook-divider"></div>
      <div class="hook">Your TC just quit. Now what?</div>
    </div>
    <div class="body-container">
      <div class="body-bar"></div>
      <div class="body">Every follow-up. Every deadline. Every lender intro. She handles it.</div>
    </div>
    <div class="bottom-row">
      <div class="pill">Founding · 48 spots left</div>
      <div class="url">meetdossie.com/founding</div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

module.exports = async (req, res) => {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expectedAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const hctiUserId = process.env.HCTI_USER_ID;
  const hctiApiKey = process.env.HCTI_API_KEY;

  if (!hctiUserId || !hctiApiKey) {
    return res.status(500).json({ ok: false, error: 'HCTI credentials not configured' });
  }

  const html = buildTestHTML();

  // Test with different parameter combinations
  const tests = [
    { name: 'no-params', params: { html } },
    { name: 'ms_delay-2000', params: { html, ms_delay: 2000 } },
    { name: 'ms_delay-3000', params: { html, ms_delay: 3000 } },
    { name: 'google_fonts-true', params: { html, google_fonts: true } },
    { name: 'google_fonts-ms_delay', params: { html, google_fonts: true, ms_delay: 2000 } },
  ];

  const results = [];
  const authHeader = Buffer.from(`${hctiUserId}:${hctiApiKey}`).toString('base64');

  for (const test of tests) {
    try {
      const response = await fetch('https://hcti.io/v1/image', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(test.params),
      });

      const data = await response.json();
      results.push({
        test: test.name,
        ok: response.ok,
        status: response.status,
        url: data.url || null,
        error: data.error || null,
      });
    } catch (error) {
      results.push({
        test: test.name,
        ok: false,
        error: error.message,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    html_preview: html.slice(0, 500) + '...',
    tests: results,
    current_api_call: {
      params: { html: '...' },
      missing: ['ms_delay', 'google_fonts', 'selector'],
    },
  });
};
