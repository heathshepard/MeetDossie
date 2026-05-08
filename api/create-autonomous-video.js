// Vercel Serverless Function: /api/create-autonomous-video
// Create Creatomate render with custom parameters
//
// POST /api/create-autonomous-video
// Body: { voiceover, caption, screenRecording, personaName }
// Returns: { ok: true, renderId, videoUrl }

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_TEMPLATE_ID = '791117d0-665c-4cd0-ba5f-a767f8921f9b';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pgwoitbdiyubjugwufhk.supabase.co';

module.exports = async function handler(req, res) {
  if (!CREATOMATE_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'CREATOMATE_API_KEY not configured'
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { voiceover, caption, screenRecording, personaName } = req.body;

    if (!voiceover || !caption || !screenRecording || !personaName) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: voiceover, caption, screenRecording, personaName'
      });
    }

    // Construct screen recording URL
    const screenRecordingUrl = `${SUPABASE_URL}/storage/v1/object/public/screen-recordings/${screenRecording}`;

    const modifications = {
      'Image-K8V': screenRecordingUrl,
      'Persona-Name': personaName,
      'Caption': caption,
      'Voiceover': voiceover
    };

    console.log('[create-autonomous-video] Creating Creatomate render...');
    console.log('[create-autonomous-video] Voiceover length:', voiceover.length, 'chars');

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
    console.log('[create-autonomous-video] Render created:', renderData.id);

    return res.status(200).json({
      ok: true,
      renderId: renderData.id,
      status: renderData.status,
      videoUrl: renderData.url,
      renderDetails: renderData
    });

  } catch (error) {
    console.error('[create-autonomous-video] error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Render creation failed'
    });
  }
};
