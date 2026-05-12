// Debug endpoint to test ElevenLabs API and Morning Brief generation
// DELETE THIS FILE after debugging

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const results = {};

  // Check if ElevenLabs API key is set
  results.elevenLabsKeySet = !!ELEVENLABS_API_KEY;
  results.elevenLabsKeyLength = ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.length : 0;

  // Test ElevenLabs API with a simple request
  if (ELEVENLABS_API_KEY) {
    try {
      const testText = "This is a test of the morning brief audio generation.";

      console.log('[debug-morning-brief] Testing ElevenLabs API...');

      const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/lxYfHSkYm1EzQzGhdbfc', {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: testText,
          model_id: 'eleven_flash_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.25,
            use_speaker_boost: true,
            speed: 1.0,
          },
        }),
      });

      const responseText = await response.text();

      results.elevenLabsTest = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        bodyPreview: responseText.slice(0, 500),
        bodyLength: responseText.length,
      };

      if (!response.ok) {
        console.error('[debug-morning-brief] ElevenLabs error:', response.status, responseText);
      } else {
        console.log('[debug-morning-brief] ElevenLabs test successful');
      }
    } catch (err) {
      results.elevenLabsTestError = err.message;
      console.error('[debug-morning-brief] ElevenLabs test threw:', err);
    }
  } else {
    results.elevenLabsTestSkipped = 'No API key';
  }

  return res.status(200).json(results);
};
