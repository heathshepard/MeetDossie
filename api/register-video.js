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

// Auto-scheduling (Atlas 2026-09-25 — "videos also get scheduled when they
// are made"). See api/_lib/video-schedule.js file header.
const { pickScheduledFor } = require('./_lib/video-schedule.js');
// Caption generation, extracted 2026-09-25 into a shared lib so this and
// scripts/register-local-video.js (the CLI registration path) don't fork it.
const { generateCaption } = require('./_lib/video-caption.js');

async function restGet(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, data };
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

  // Auto-schedule (no explicit time was ever a param on this endpoint, so
  // this always runs unless it genuinely finds nothing in the next 14 days,
  // in which case scheduled_for stays NULL — the pre-existing behavior).
  let scheduledFor = null;
  try {
    scheduledFor = await pickScheduledFor({ platforms, owner: 'dossie', restGet });
  } catch (err) {
    console.warn('[register-video] pickScheduledFor threw, leaving scheduled_for null:', err && err.message);
  }

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
    scheduled_for: scheduledFor,
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

    console.log(`[register-video] Upserted video_library: id=${stem} scheduled_for=${scheduledFor || '(none — no free slot / no schedule)'}`);
    return res.status(200).json({ ok: true, id: stem, scheduled_for: scheduledFor });
  } catch (err) {
    console.error('[register-video] fetch error:', err && err.message);
    return res.status(502).json({ ok: false, error: 'Failed to reach Supabase' });
  }
};
