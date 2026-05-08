// Vercel Serverless Function: /api/setup-creatomate-template
// One-time setup to create the Dossie video template in Creatomate.
// Creates a 9:16 vertical template with dynamic fields for screen recording,
// persona name, captions, and voiceover.
//
// GET /api/setup-creatomate-template
// Returns: { ok: true, templateId, templateName, fields }

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;

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
    // Create Creatomate template
    const template = {
      name: 'Dossie Lifestyle Video Template',
      width: 720,
      height: 1280,
      frame_rate: 60,
      duration: null, // Dynamic based on audio
      elements: [
        // Background - solid blush
        {
          type: 'shape',
          width: '100%',
          height: '100%',
          x: '0%',
          y: '0%',
          fill_color: '#F5E6E0',
          track: 1,
        },
        // Screen recording layer - centered, 75% height at 45% Y
        {
          type: 'video',
          source: '{{Screen-Recording}}',
          width: '100%',
          height: '75%',
          x: '50%',
          y: '45%',
          x_anchor: '50%',
          y_anchor: '50%',
          track: 2,
        },
        // Top left wordmark "DOSSIE"
        {
          type: 'text',
          text: 'DOSSIE',
          font_family: 'Plus Jakarta Sans',
          font_size: '20px',
          font_weight: '600',
          fill_color: '#C9A96E',
          letter_spacing: '0.1em',
          x: '5%',
          y: '4%',
          x_anchor: '0%',
          y_anchor: '0%',
          track: 3,
        },
        // Persona name - centered at 10% Y
        {
          type: 'text',
          text: '{{Persona}}',
          font_family: 'Cormorant Garamond',
          font_size: '40px',
          font_weight: '600',
          fill_color: '#E8836B',
          x: '50%',
          y: '10%',
          x_anchor: '50%',
          y_anchor: '50%',
          track: 4,
        },
        // Animated captions - bottom 15%
        {
          type: 'text',
          text: '{{Caption}}',
          font_family: 'Plus Jakarta Sans',
          font_size: '32px',
          font_weight: '600',
          fill_color: '#1A1A2E',
          x: '50%',
          y: '85%',
          x_anchor: '50%',
          y_anchor: '50%',
          width: '90%',
          text_align: 'center',
          animations: [
            {
              type: 'text-word',
              scope: 'word',
              animation_properties: {
                type: 'scale',
                fade: true,
                easing: 'cubic-bezier(0.5, 0, 0.1, 1)',
                duration: 0.3,
              },
            },
          ],
          track: 5,
        },
        // Lower third CTA
        {
          type: 'text',
          text: 'meetdossie.com/founding',
          font_family: 'Plus Jakarta Sans',
          font_size: '24px',
          font_weight: '600',
          fill_color: '#8BA888',
          x: '50%',
          y: '96%',
          x_anchor: '50%',
          y_anchor: '100%',
          track: 6,
        },
        // Audio layer - voiceover
        {
          type: 'audio',
          source: '{{Voiceover}}',
          track: 7,
        },
      ],
    };

    // Create template via Creatomate API
    const response = await fetch('https://api.creatomate.com/v1/templates', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CREATOMATE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(template),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        ok: false,
        error: `Creatomate API error: ${response.status} ${errorText}`,
      });
    }

    const createdTemplate = await response.json();

    // Extract dynamic fields
    const fields = [
      'Screen-Recording',
      'Persona',
      'Caption',
      'Voiceover',
    ];

    return res.status(200).json({
      ok: true,
      templateId: createdTemplate.id,
      templateName: createdTemplate.name,
      fields,
      template: createdTemplate,
    });

  } catch (error) {
    console.error('[setup-creatomate-template] error:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Failed to create template',
    });
  }
};
