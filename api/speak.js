// Vercel Serverless Function: /api/speak
// ElevenLabs TTS for Dossie's voice (Luna)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { text, speed } = req.body;

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ ok: false, error: 'Text is required' });
    }

    const speedValue = typeof speed === 'number' && speed >= 0.25 && speed <= 4.0 ? speed : 1.0;

    if (!process.env.ELEVENLABS_API_KEY) {
      console.error('ELEVENLABS_API_KEY not configured');
      return res.status(500).json({ ok: false, error: 'Server configuration error' });
    }

    // Strip markdown, emoji, asterisks
    const cleanText = text
      .replace(/[*_~`]/g, '')
      .replace(/#+\s/g, '')
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
      .trim();

    if (!cleanText) {
      return res.status(400).json({ ok: false, error: 'No text after cleaning' });
    }

    const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/6rOxfAnZpbM3VIEhFaeV', {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.35,
          similarity_boost: 0.75,
          style: 0.25,
          use_speaker_boost: true,
          speed: speedValue,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('ElevenLabs error:', error);
      return res.status(response.status).json({ ok: false, error: 'TTS failed' });
    }

    const audioBuffer = await response.arrayBuffer();
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.byteLength);
    res.status(200).send(Buffer.from(audioBuffer));

  } catch (error) {
    console.error('Speak API error:', error);
    return res.status(500).json({ ok: false, error: 'Failed to generate speech' });
  }
}
