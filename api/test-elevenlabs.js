// Test ElevenLabs API integration
// DELETE THIS FILE after debugging

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const results = {
    keySet: !!ELEVENLABS_API_KEY,
    keyLength: ELEVENLABS_API_KEY ? ELEVENLABS_API_KEY.length : 0,
  };

  if (ELEVENLABS_API_KEY) {
    // Check for BOM or other special characters
    results.keyStartsWithBOM = ELEVENLABS_API_KEY.charCodeAt(0) === 65279;
    results.firstCharCode = ELEVENLABS_API_KEY.charCodeAt(0);
    results.keyPreview = ELEVENLABS_API_KEY.slice(0, 10) + '...';

    // Try calling ElevenLabs
    try {
      const response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/lxYfHSkYm1EzQzGhdbfc', {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: "Test",
          model_id: 'eleven_flash_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      });

      const responseText = await response.text();

      results.elevenLabsResponse = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        bodyPreview: responseText.slice(0, 500),
      };
    } catch (err) {
      results.elevenLabsError = err.message;
    }
  }

  return res.status(200).json(results);
};
