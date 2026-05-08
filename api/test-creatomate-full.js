// Vercel Serverless Function: /api/test-creatomate-full
// Complete Creatomate test flow:
// Calls Creatomate API with voiceover TEXT (Creatomate calls ElevenLabs internally)
//
// GET /api/test-creatomate-full
// Returns: { ok: true, renderId, renderDetails }

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_TEMPLATE_ID = process.env.CREATOMATE_TEMPLATE_ID || '791117d0-665c-4cd0-ba5f-a767f8921f9b';

const SCREEN_RECORDING_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/screen-recordings/friday-full-pipeline-view-2026-05-08.mp4';
const VOICEOVER_TEXT = 'This is what an active week looks like with Dossie running it. Six files. Three under option, two clear to close, one waiting on appraisal. Every deadline tracked. Every party followed up. Every T-R-E-C paragraph already cited on the deadline page. I have not opened a folder of PDFs in two weeks. The pipeline view is the file. The file is the work. The work is the deal. Texas agents — meetdossie.com slash founding.';

module.exports = async function handler(req, res) {
  if (!CREATOMATE_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'CREATOMATE_API_KEY not configured'
    });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // Create Creatomate render (Creatomate calls ElevenLabs internally)
    console.log('[test-creatomate-full] Step 3: Creating Creatomate render...');
    const modifications = {
      'Image-K8V': SCREEN_RECORDING_URL,
      'Persona-Name': 'Victor',
      'Caption': 'This is what an active week looks like with Dossie. Six files. Three under option, two clear to close, one waiting on appraisal.',
      'Voiceover': VOICEOVER_TEXT  // Pass text, not audio URL - Creatomate calls ElevenLabs
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
