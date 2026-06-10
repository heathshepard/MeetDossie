// Test endpoint to generate Morning Brief audio with specific text
// Usage: GET /api/test-brief-audio
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)
// Previously public — anyone could burn ElevenLabs credits on demand.

const { generateSpeech } = require('./_utils/tts');
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const testText = "Good morning Heath. You've got two things that need your eyes today. The Chen file option period expires tomorrow - make sure that decision is in. Everything else is moving cleanly. I've got the details when you need them.";

  console.log('[test-brief-audio] Generating test audio...');

  try {
    const { buffer, provider } = await generateSpeech(testText, {
      elevenLabsVoiceId: 'lxYfHSkYm1EzQzGhdbfc',
      persona: 'luna',
      elevenLabsModelId: 'eleven_flash_v2_5',
      voiceSettings: {
        stability: 0.35,
        similarity_boost: 0.75,
        style: 0.25,
        use_speaker_boost: true,
        speed: 0.85,
      },
    });

    console.log(`[test-brief-audio] Audio ready (provider: ${provider}), bytes: ${buffer.length}`);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Content-Disposition', 'inline; filename="test-brief.mp3"');
    res.setHeader('X-TTS-Provider', provider);
    res.status(200);
    res.write(buffer);
    res.end();

  } catch (error) {
    console.error('[test-brief-audio] Error:', error);
    return res.status(500).json({ ok: false, error: 'Failed to generate test audio', detail: error.message });
  }
}
