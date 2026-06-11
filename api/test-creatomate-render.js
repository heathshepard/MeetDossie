// Vercel Serverless Function: /api/test-creatomate-render
// Test Creatomate video rendering with Victor persona and pipeline view
//
// GET /api/test-creatomate-render
// Returns: { ok: true, renderId, status, url?, renderDetails }

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const CREATOMATE_TEMPLATE_ID = process.env.CREATOMATE_TEMPLATE_ID || '791117d0-665c-4cd0-ba5f-a767f8921f9b';
const SCREEN_RECORDING_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/screen-recordings/friday-full-pipeline-view-2026-05-08.mp4';
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  // Auth added 2026-06-10 (Atlas) — Creatomate renders cost money per call.
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
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
    // Test render with Victor persona and pipeline view
    const modifications = {
      'Image-K8V': SCREEN_RECORDING_URL,
      'Persona-Name': 'Victor',
      'Caption': 'This is what an active week looks like with Dossie. Six files. Three under option, two clear to close, one waiting on appraisal.',
      'Voiceover': 'This is what an active week looks like with Dossie running it. Six files. Three under option, two clear to close, one waiting on appraisal. Every deadline tracked. Every party followed up. Every TREC paragraph already cited.'
    };

    const payload = {
      template_id: CREATOMATE_TEMPLATE_ID,
      modifications: modifications
    };

    console.log('[test-creatomate-render] Calling Creatomate API with:', JSON.stringify(modifications, null, 2));

    // Create render via Creatomate API
    const response = await fetch('https://api.creatomate.com/v2/renders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CREATOMATE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[test-creatomate-render] Creatomate API error:', response.status, errorText);
      return res.status(response.status).json({
        ok: false,
        error: `Creatomate API error: ${response.status} ${errorText}`,
      });
    }

    const renderResponse = await response.json();

    console.log('[test-creatomate-render] Render created:', JSON.stringify(renderResponse, null, 2));

    return res.status(200).json({
      ok: true,
      renderId: renderResponse.id,
      status: renderResponse.status,
      url: renderResponse.url || null,
      renderDetails: renderResponse,
      message: renderResponse.url
        ? 'Render complete!'
        : 'Render in progress. Check status at: https://creatomate.com/renders/' + renderResponse.id
    });

  } catch (error) {
    console.error('[test-creatomate-render] error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to create render',
    });
  }
};
