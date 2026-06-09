// Vercel Serverless Function: /api/cron-render-skits
// Phase 1 of the async skit render pipeline.
//
// Picks up skit_queue rows where status='script_approved', submits one Kling clip
// job per scene via fal.queue.submit (non-blocking, webhook-driven), stores the
// fal request IDs in kling_job_ids, and marks the skit as 'rendering'. Returns
// in well under 10 seconds regardless of how many scenes the skit has.
//
// Phase 2 lives in api/cron-assemble-skits.js — it polls fal for completed clips
// every 10 minutes, assembles ElevenLabs + Shotstack when all clips are ready,
// and writes status='video_rendered'.
//
// Auth: x-vercel-cron: 1 OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 13 * * *" (1PM UTC / 8AM CST)
//
// Env vars required: FAL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { fal } = require('@fal-ai/client');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FAL_KEY = process.env.FAL_KEY;

const KLING_MODEL = 'fal-ai/kling-video/v1.6/standard/text-to-video';
const MAX_SKITS_PER_RUN = 2;

// The public webhook URL that fal will POST to when each clip finishes.
// api/skit-render-callback.js handles the incoming payload.
const SKIT_CALLBACK_URL = 'https://meetdossie.com/api/skit-render-callback';

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!FAL_KEY) {
    console.error('[cron-render-skits] FAL_KEY not configured — skipping run');
    return res.status(200).json({ ok: true, skipped: true, reason: 'FAL_KEY not set' });
  }

  fal.config({ credentials: FAL_KEY });

  // Fetch script_approved skits
  const { data: rows, ok: fetchOk } = await supabaseFetch(
    `/rest/v1/skit_queue?status=eq.script_approved&order=created_at.asc&limit=${MAX_SKITS_PER_RUN}`,
  );

  if (!fetchOk) {
    console.error('[cron-render-skits] Failed to query skit_queue');
    return res.status(502).json({ ok: false, error: 'Failed to query skit_queue' });
  }

  const skits = Array.isArray(rows) ? rows : [];
  console.log(`[cron-render-skits] ${skits.length} skits ready to dispatch`);

  if (skits.length === 0) {
    return res.status(200).json({ ok: true, dispatched: 0, message: 'no script_approved skits' });
  }

  const results = [];

  for (const skit of skits) {
    const skitId = skit.id;
    const script = skit.script_json || {};
    const scenes = Array.isArray(script.scenes) ? script.scenes : [];

    if (scenes.length === 0) {
      console.error(`[cron-render-skits] Skit ${skitId} has no scenes — skipping`);
      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'render_failed',
          render_failed_reason: 'script_json has no scenes array',
        }),
      });
      results.push({ id: skitId, ok: false, error: 'no scenes' });
      continue;
    }

    // Submit one fal queue job per scene. Each job posts back to skit-render-callback
    // with a metadata payload identifying which skit and scene index it belongs to.
    const jobIds = [];
    let dispatchFailed = false;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const prompt = String(scene.prompt || '').trim();
      if (!prompt) {
        console.error(`[cron-render-skits] Skit ${skitId} scene ${i} has no prompt — aborting`);
        dispatchFailed = true;
        break;
      }

      try {
        // fal.queue.submit returns {request_id} immediately without waiting for render.
        // The webhookUrl receives a POST when the clip is done.
        const webhookUrl = `${SKIT_CALLBACK_URL}?skit_id=${encodeURIComponent(skitId)}&scene_index=${i}&total_scenes=${scenes.length}`;
        const { request_id } = await fal.queue.submit(KLING_MODEL, {
          input: {
            prompt,
            duration: '5',
            aspect_ratio: '9:16',
          },
          webhookUrl,
        });
        console.log(`[cron-render-skits] Skit ${skitId} scene ${i}: fal request_id=${request_id}`);
        jobIds.push(request_id);
      } catch (err) {
        const msg = err && err.message ? err.message.slice(0, 300) : String(err);
        console.error(`[cron-render-skits] Skit ${skitId} scene ${i} fal submit failed: ${msg}`);
        dispatchFailed = true;
        break;
      }
    }

    if (dispatchFailed) {
      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'render_failed',
          render_failed_reason: 'fal.queue.submit failed on one or more scenes',
        }),
      });
      results.push({ id: skitId, ok: false, error: 'fal submit failed' });
      continue;
    }

    // All scene jobs submitted — store job IDs and mark as rendering
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'rendering',
        render_started_at: new Date().toISOString(),
        kling_job_ids: jobIds,
        kling_clip_urls: null,
        render_failed_reason: null,
      }),
    });

    console.log(`[cron-render-skits] Skit ${skitId} dispatched: ${scenes.length} Kling jobs submitted`);
    results.push({ id: skitId, ok: true, scenes: scenes.length, job_ids: jobIds });
  }

  const dispatched = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  return res.status(200).json({
    ok: failed === 0,
    dispatched,
    failed,
    total: skits.length,
    results,
  });
};
