// Vercel Serverless Function: /api/test-creatomate-full
// Complete Creatomate test flow with ElevenLabs audio:
// 1. Generate voiceover via ElevenLabs API
// 2. Upload to Supabase Storage
// 3. Call Creatomate API with audio URL
//
// GET /api/test-creatomate-full
// Returns: { ok: true, renderId, audioUrl, renderDetails }

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_TEMPLATE_ID = process.env.CREATOMATE_TEMPLATE_ID || '791117d0-665c-4cd0-ba5f-a767f8921f9b';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BILL_VOICE_ID = 'pqHfZKP75CvOlQylNhV4';
const SCREEN_RECORDING_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/screen-recordings/friday-full-pipeline-view-2026-05-08.mp4';
const VOICEOVER_TEXT = 'This is what an active week looks like with Dossie running it. Six files. Three under option, two clear to close, one waiting on appraisal. Every deadline tracked. Every party followed up. Every TREC paragraph already cited.';

module.exports = async function handler(req, res) {
  if (!ELEVENLABS_API_KEY || !CREATOMATE_API_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Required API keys not configured'
    });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // Step 1: Generate ElevenLabs voiceover
    console.log('[test-creatomate-full] Step 1: Generating voiceover...');
    const voiceResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${BILL_VOICE_ID}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: VOICEOVER_TEXT,
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    });

    if (!voiceResponse.ok) {
      const errorText = await voiceResponse.text();
      throw new Error(`ElevenLabs error: ${voiceResponse.status} ${errorText}`);
    }

    const audioBuffer = await voiceResponse.arrayBuffer();
    console.log('[test-creatomate-full] Voiceover generated:', audioBuffer.byteLength, 'bytes');

    // Step 2: Upload to Supabase Storage
    console.log('[test-creatomate-full] Step 2: Uploading to Supabase...');
    const audioFilename = `test-victor-pipeline-view-${Date.now()}.mp3`;
    const uploadResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/voiceovers/${audioFilename}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'audio/mpeg',
      },
      body: audioBuffer
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Supabase upload error: ${uploadResponse.status} ${errorText}`);
    }

    const audioUrl = `${SUPABASE_URL}/storage/v1/object/public/voiceovers/${audioFilename}`;
    console.log('[test-creatomate-full] Audio uploaded:', audioUrl);

    // Step 3: Create Creatomate render
    console.log('[test-creatomate-full] Step 3: Creating Creatomate render...');
    const modifications = {
      'Image-K8V': SCREEN_RECORDING_URL,
      'Persona-Name': 'Victor',
      'Caption': 'This is what an active week looks like with Dossie. Six files. Three under option, two clear to close, one waiting on appraisal.',
      'Voiceover': audioUrl
    };

    const renderResponse = await fetch('https://api.creatomate.com/v2/renders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CREATOMATE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        template_id: CREATOMATE_TEMPLATE_ID,
        modifications: modifications
      })
    });

    if (!renderResponse.ok) {
      const errorText = await renderResponse.text();
      throw new Error(`Creatomate error: ${renderResponse.status} ${errorText}`);
    }

    const renderData = await renderResponse.json();
    console.log('[test-creatomate-full] Render created:', renderData.id);

    return res.status(200).json({
      ok: true,
      renderId: renderData.id,
      status: renderData.status,
      videoUrl: renderData.url,
      audioUrl: audioUrl,
      renderDetails: renderData
    });

  } catch (error) {
    console.error('[test-creatomate-full] error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Test flow failed'
    });
  }
};
