// /api/voice/voices — list ElevenLabs voices available on Heath's account.
// Use this to verify the agent voice mapping is pointing at real voice IDs.
//
// Auth: Bearer <VOICE_INGEST_SECRET>
// GET → JSON { voices: [{voice_id, name, category, labels}, ...], agentMap: {...} }

const AGENT_VOICE_MAP = {
  cole:    'TX3LPaxmHKxFdv7VOQHJ', // Liam
  hadley:  'XB0fDUnXU5powFXDhCwa', // Charlotte
  pierce:  'TxGEqnHWrfWFTfGW9XjX', // Josh
  atlas:   'nPczCjzI2devNBz1zQrb', // Brian
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const expected = process.env.VOICE_INGEST_SECRET;
  if (!expected) return res.status(500).json({ ok: false, error: 'Server misconfigured' });
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const presented = (auth.match(/^Bearer\s+(.+)$/i) || [])[1];
  if (!presented || presented.trim() !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ELEVENLABS_API_KEY not configured' });
  }

  try {
    const upstream = await fetch('https://api.elevenlabs.io/v1/voices', {
      method: 'GET',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Accept': 'application/json' },
    });
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ ok: false, error: 'voices upstream failed', detail: t.slice(0, 300) });
    }
    const data = await upstream.json();
    const voices = (data.voices || []).map(v => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category,
      labels: v.labels || null,
    }));

    // Resolve each agent → confirmed presence on account
    const resolved = {};
    for (const [agent, vid] of Object.entries(AGENT_VOICE_MAP)) {
      const hit = voices.find(v => v.voice_id === vid);
      resolved[agent] = hit ? { ok: true, voice_id: vid, name: hit.name, category: hit.category } : { ok: false, voice_id: vid, note: 'voice_id not found on account' };
    }

    return res.status(200).json({ ok: true, count: voices.length, voices, agentMap: resolved });
  } catch (err) {
    console.error('[voice/voices]', err);
    return res.status(500).json({ ok: false, error: 'failed' });
  }
};
