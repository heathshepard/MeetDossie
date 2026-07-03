// Comprehensive system health check - tests full pipeline end-to-end
// Auth required: CRON_SECRET

const { retryFetch } = require('./_lib/retry.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const HCTI_USER_ID = process.env.HCTI_USER_ID;
const HCTI_API_KEY = process.env.HCTI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function testSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: 'Supabase credentials not set' };
  }

  try {
    const response = await retryFetch(
      `${SUPABASE_URL}/rest/v1/social_posts?select=id&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
      { name: 'Supabase', maxAttempts: 3 }
    );

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testElevenLabs() {
  if (!ELEVENLABS_API_KEY) {
    return { ok: false, error: 'ElevenLabs API key not set' };
  }

  // Check for BOM
  if (ELEVENLABS_API_KEY.charCodeAt(0) === 65279) {
    return { ok: false, error: 'API key has BOM character - regenerate key' };
  }

  try {
    const response = await retryFetch(
      'https://api.elevenlabs.io/v1/text-to-speech/lxYfHSkYm1EzQzGhdbfc',
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: "System test",
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
      { name: 'ElevenLabs', maxAttempts: 3 }
    );

    if (response.ok) {
      const audioBuffer = await response.arrayBuffer();
      return { ok: true, status: response.status, audioSize: audioBuffer.byteLength };
    }

    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testZernio() {
  if (!ZERNIO_API_KEY) {
    return { ok: false, error: 'Zernio API key not set' };
  }

  try {
    const response = await retryFetch(
      'https://zernio.com/api/v1/accounts',
      {
        headers: {
          'Authorization': `Bearer ${ZERNIO_API_KEY}`,
          'Content-Type': 'application/json',
        },
      },
      { name: 'Zernio', maxAttempts: 3 }
    );

    if (response.ok) {
      const data = await response.json();
      const accountCount = data?.accounts?.length || 0;
      return { ok: true, status: response.status, accountCount };
    }

    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testHCTI() {
  if (!HCTI_USER_ID || !HCTI_API_KEY) {
    return { ok: false, error: 'HCTI credentials not set' };
  }

  try {
    const response = await retryFetch(
      'https://hcti.io/v1/image',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${HCTI_USER_ID}:${HCTI_API_KEY}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          html: '<div>Test</div>',
          css: 'div { color: black; }',
        }),
      },
      { name: 'HCTI', maxAttempts: 3 }
    );

    if (response.ok) {
      const data = await response.json();
      return { ok: true, status: response.status, url: data?.url };
    }

    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function testAnthropic() {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, error: 'Anthropic API key not set' };
  }

  try {
    const response = await retryFetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      },
      { name: 'Anthropic', maxAttempts: 3 }
    );

    if (response.ok) {
      return { ok: true, status: response.status };
    }

    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const startTime = Date.now();

  const results = {
    timestamp: new Date().toISOString(),
    tests: {},
  };

  // Run all tests
  console.log('[system-health] Testing Supabase...');
  results.tests.supabase = await testSupabase();

  console.log('[system-health] Testing ElevenLabs...');
  results.tests.elevenlabs = await testElevenLabs();

  console.log('[system-health] Testing Zernio...');
  results.tests.zernio = await testZernio();

  console.log('[system-health] Testing HCTI...');
  results.tests.hcti = await testHCTI();

  console.log('[system-health] Testing Anthropic...');
  results.tests.anthropic = await testAnthropic();

  // Calculate summary
  const allTests = Object.values(results.tests);
  const passed = allTests.filter(t => t.ok).length;
  const failed = allTests.filter(t => !t.ok).length;

  results.summary = {
    total: allTests.length,
    passed,
    failed,
    allHealthy: failed === 0,
    durationMs: Date.now() - startTime,
  };

  // List broken services
  if (failed > 0) {
    results.broken = Object.entries(results.tests)
      .filter(([_, test]) => !test.ok)
      .map(([name, test]) => ({
        service: name,
        error: test.error,
      }));
  }

  return res.status(200).json(results);
};
