// Test endpoint to generate Morning Brief audio with specific text
// Usage: GET /api/test-brief-audio

const { retryFetch } = require('./_lib/retry.js');

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('ELEVENLABS_API_KEY not configured');
    return res.status(500).json({ ok: false, error: 'Server configuration error' });
  }

  const testText = "Good morning Heath. You've got two things that need your eyes today. The Chen file option period expires tomorrow — make sure that decision is in. Everything else is moving cleanly. I've got the details when you need them.";

  const elevenLabsUrl = 'https://api.elevenlabs.io/v1/text-to-speech/lxYfHSkYm1EzQzGhdbfc/stream';
  const voiceSettings = {
    stability: 0.35,
    similarity_boost: 0.75,
    style: 0.25,
    use_speaker_boost: true,
    speed: 0.85,
  };

  console.log('[test-brief-audio] Generating test audio...');
  console.log('[test-brief-audio] URL:', elevenLabsUrl);
  console.log('[test-brief-audio] Settings:', JSON.stringify(voiceSettings));
  console.log('[test-brief-audio] Text:', testText);

  try {
    const response = await retryFetch(
      elevenLabsUrl,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: testText,
          model_id: 'eleven_flash_v2_5',
          voice_settings: voiceSettings,
        }),
      },
      { name: 'ElevenLabs', maxAttempts: 3, baseDelay: 1000 }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '<no body>');
      console.error('[test-brief-audio] ElevenLabs error:', response.status, errorBody);
      return res.status(response.status >= 500 ? 502 : response.status).json({
        ok: false,
        error: 'TTS failed',
        details: errorBody
      });
    }

    console.log('[test-brief-audio] Audio generated successfully, streaming to client...');

    // Stream the audio response directly to the client
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Content-Disposition', 'inline; filename="test-brief.mp3"');
    res.status(200);

    // Pipe the response body stream to the client
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      } catch (streamError) {
        console.error('[test-brief-audio] Stream error:', streamError);
        if (!res.headersSent) {
          return res.status(500).json({ ok: false, error: 'Stream failed' });
        }
        res.end();
      }
    } else {
      // Fallback if streaming not supported
      const audioBuffer = await response.arrayBuffer();
      res.write(Buffer.from(audioBuffer));
      res.end();
    }

  } catch (error) {
    console.error('[test-brief-audio] Error:', error);
    return res.status(500).json({ ok: false, error: 'Failed to generate test audio' });
  }
}
