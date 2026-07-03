// Vercel Serverless Function: /api/register-video
// Called by media-studio.html after a successful browser upload to Supabase Storage.
// Generates a caption via Claude Haiku and upserts a row into video_library.
//
// POST /api/register-video
// Body: { stem, type, platforms, publicUrl, password }
// Response: { ok: true, id: stem }

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET          = process.env.CRON_SECRET;
const STUDIO_PASSWORD      = process.env.STUDIO_PASSWORD;

async function generateCaption(stem) {
  const fallback = 'Your transactions, handled. meetdossie.com/founding';

  if (!ANTHROPIC_API_KEY) {
    console.log('[register-video] No ANTHROPIC_API_KEY — using fallback caption');
    return fallback;
  }

  const prompt =
    `Generate a 1-2 sentence social media caption for a Dossie video. ` +
    `Topic: ${stem}. ` +
    `Brand: warm AI transaction coordinator for Texas real estate agents. ` +
    `End with: meetdossie.com/founding. Max 150 chars. Plain ASCII only.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!resp.ok) {
      console.warn('[register-video] Anthropic error', resp.status, '— using fallback');
      return fallback;
    }

    const data  = await resp.json();
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    let caption = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());

    // Enforce 150 char limit
    if (caption.length > 150) {
      const url = 'meetdossie.com/founding';
      if (!caption.includes(url)) {
        caption = caption.slice(0, 120) + '... ' + url;
      } else {
        caption = caption.slice(0, 150);
      }
    }

    console.log(`[register-video] Caption (${caption.length} chars): ${caption}`);
    return caption;
  } catch (err) {
    console.warn('[register-video] Caption generation threw:', err && err.message, '— using fallback');
    return fallback;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Auth
  const allowed = STUDIO_PASSWORD || CRON_SECRET;
  if (!allowed || body.password !== allowed) {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  const { stem, type, platforms, publicUrl } = body;

  if (!stem || !type || !platforms || !publicUrl) {
    return res.status(400).json({ ok: false, error: 'stem, type, platforms, publicUrl required' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
  }

  // Generate caption
  const caption = await generateCaption(stem);

  // Upsert into video_library
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const row = {
    id:            stem,
    topic:         stem,
    type,
    status:        'approved',
    platforms,
    caption,
    supabase_url:  publicUrl,
    produced_date: today,
  };

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/video_library?on_conflict=id`,
      {
        method: 'POST',
        headers: {
          'apikey':        SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[register-video] Supabase upsert error:', resp.status, text);
      return res.status(502).json({ ok: false, error: `DB upsert failed: ${resp.status}` });
    }

    console.log(`[register-video] Upserted video_library: id=${stem}`);
    return res.status(200).json({ ok: true, id: stem });
  } catch (err) {
    console.error('[register-video] fetch error:', err && err.message);
    return res.status(502).json({ ok: false, error: 'Failed to reach Supabase' });
  }
};
