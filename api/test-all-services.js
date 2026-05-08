// Vercel Serverless Function: /api/test-all-services
// Test all external service connections after API key rotation
//
// GET /api/test-all-services
// Returns: { ok: true, services: { supabase, elevenlabs, stripe, telegram, zernio, creatomate } }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;

async function testSupabase() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    return {
      ok: res.ok,
      status: res.status,
      configured: !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function testElevenLabs() {
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY }
    });
    return {
      ok: res.ok,
      status: res.status,
      configured: !!ELEVENLABS_API_KEY
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function testStripe() {
  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents?limit=1', {
      headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` }
    });
    return {
      ok: res.ok,
      status: res.status,
      configured: !!STRIPE_SECRET_KEY
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function testTelegramBot(token, name) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    return {
      ok: res.ok && data.ok,
      status: res.status,
      configured: !!token,
      botName: data.result?.username || null
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function testZernio() {
  try {
    const res = await fetch('https://api.zernio.com/api/v1/accounts', {
      headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` }
    });
    return {
      ok: res.ok,
      status: res.status,
      configured: !!ZERNIO_API_KEY
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function testCreatomate() {
  try {
    const res = await fetch('https://api.creatomate.com/v2/renders?limit=1', {
      headers: { 'Authorization': `Bearer ${CREATOMATE_API_KEY}` }
    });
    return {
      ok: res.ok,
      status: res.status,
      configured: !!CREATOMATE_API_KEY
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  console.log('[test-all-services] Running diagnostics...');

  const results = {
    supabase: await testSupabase(),
    elevenlabs: await testElevenLabs(),
    stripe: await testStripe(),
    telegram_claudy: await testTelegramBot(TELEGRAM_BOT_TOKEN, 'Claudy'),
    telegram_marketing: await testTelegramBot(TELEGRAM_MARKETING_BOT_TOKEN, 'DossieMarketingBot'),
    zernio: await testZernio(),
    creatomate: await testCreatomate()
  };

  const allOk = Object.values(results).every(r => r.ok);
  const failures = Object.entries(results)
    .filter(([_, r]) => !r.ok)
    .map(([name, _]) => name);

  console.log('[test-all-services] Results:', allOk ? 'ALL OK' : `FAILURES: ${failures.join(', ')}`);

  return res.status(200).json({
    ok: allOk,
    timestamp: new Date().toISOString(),
    services: results,
    failures: failures.length > 0 ? failures : null
  });
};
