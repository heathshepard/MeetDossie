// Vercel Serverless Function: /api/cron-assemble-skits
// Safety poller for the async skit render pipeline.
//
// Runs every 10 minutes. Finds skit_queue rows where status='rendering' and
// polls fal.ai to check whether outstanding Kling jobs are done. If all clips
// for a skit have completed (jobs COMPLETED, clip URLs available), it triggers
// the same ElevenLabs + Shotstack assembly that skit-render-callback.js would
// have done via webhook.
//
// This catches cases where the fal webhook was missed — network hiccup,
// cold-start timeout, etc. — without double-assembling skits that the webhook
// already handled (those are in status='video_rendered').
//
// Auth: x-vercel-cron: 1 OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "*/10 * * * *"
//
// Env vars required: FAL_KEY, ELEVENLABS_API_KEY, SHOTSTACK_API_KEY,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN

const { fal } = require('@fal-ai/client');
const { generateSpeech } = require('./_utils/tts');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FAL_KEY = process.env.FAL_KEY;
const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const KLING_MODEL = 'fal-ai/kling-video/v1.6/standard/text-to-video';
const SHOTSTACK_BASE = 'https://api.shotstack.io/stage';
const SHOTSTACK_POLL_INTERVAL_MS = 5000;
const SHOTSTACK_MAX_WAIT_MS = 270000; // 4.5 min — stay inside Vercel's 300s limit

const VOICE_IDS = {
  bill:    'pqHfZKP75CvOlQylNhV4',
  luna:    'lxYfHSkYm1EzQzGhdbfc',
  charlie: 'pqHfZKP75CvOlQylNhV4',
};

// Only pick up skits that have been rendering for at least 10 minutes (Kling
// typically finishes in 5-8 min). Skits rendered in the last 10 min are still
// being handled by the webhook and we don't want to race it.
const MIN_RENDER_AGE_MINUTES = 10;

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

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.warn('[cron-assemble-skits] Telegram notify failed:', err && err.message);
  }
}

function buildVoiceoverText(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return lines.map(([, text]) => String(text || '').trim()).filter(Boolean).join(' ');
}

function pickPrimaryVoice(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return VOICE_IDS.bill;
  const counts = {};
  for (const [voice] of lines) {
    const key = String(voice || '').toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  if (counts.bill) return VOICE_IDS.bill;
  if (counts.charlie) return VOICE_IDS.charlie;
  if (counts.luna) return VOICE_IDS.luna;
  return VOICE_IDS.bill;
}

async function uploadVoiceover(skitId, audioBuffer) {
  const filename = `skit-${skitId}-audio.mp3`;
  const url = `${SUPABASE_URL}/storage/v1/object/voiceovers/${encodeURIComponent(filename)}`;
  const bytes = new Uint8Array(audioBuffer);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'audio/mpeg',
    },
    body: bytes,
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 409 || body.includes('Duplicate')) {
      return `${SUPABASE_URL}/storage/v1/object/public/voiceovers/${encodeURIComponent(filename)}`;
    }
    throw new Error(`Supabase voiceover upload failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/voiceovers/${encodeURIComponent(filename)}`;
}

function buildShotstackPayload(clipUrls, voiceoverUrl) {
  const clipLength = 5;
  const totalLength = clipUrls.length * clipLength;
  return {
    timeline: {
      soundtrack: { src: voiceoverUrl, effect: 'fadeOut' },
      tracks: [
        {
          clips: clipUrls.map((url, i) => ({
            asset: { type: 'video', src: url, volume: 0 },
            start: i * clipLength,
            length: clipLength,
          })),
        },
        {
          clips: [{
            asset: {
              type: 'caption',
              src: voiceoverUrl,
              font: { family: 'Montserrat ExtraBold', size: 36 },
              color: '#ffffff',
              background: { color: '#000000', opacity: 0.6, padding: 5 },
              position: 'bottom-center',
              offset: { y: 0.15 },
            },
            start: 0,
            length: totalLength,
          }],
        },
      ],
    },
    output: { format: 'mp4', resolution: 'hd', aspectRatio: '9:16', fps: 25 },
  };
}

async function createShotstackRender(payload) {
  const res = await fetch(`${SHOTSTACK_BASE}/render`, {
    method: 'POST',
    headers: { 'x-api-key': SHOTSTACK_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Shotstack render create failed: ${res.status} ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Shotstack non-JSON: ${text.slice(0, 200)}`);
  }
  const renderId = data?.response?.id;
  if (!renderId) throw new Error(`Shotstack no render ID: ${text.slice(0, 300)}`);
  console.log(`[cron-assemble-skits] Shotstack render submitted: ${renderId}`);
  return renderId;
}

async function pollShotstackRender(renderId) {
  const start = Date.now();
  while (Date.now() - start < SHOTSTACK_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, SHOTSTACK_POLL_INTERVAL_MS));
    const res = await fetch(`${SHOTSTACK_BASE}/renders/${renderId}`, {
      headers: { 'x-api-key': SHOTSTACK_API_KEY },
    });
    if (!res.ok) { console.warn(`[cron-assemble-skits] Shotstack poll HTTP ${res.status}`); continue; }
    const data = await res.json();
    const status = data?.response?.status;
    console.log(`[cron-assemble-skits] Shotstack ${renderId} status=${status}`);
    if (status === 'done') {
      const url = data?.response?.url;
      if (!url) throw new Error('Shotstack done but no URL');
      return url;
    }
    if (status === 'failed') throw new Error(`Shotstack render failed: ${data?.response?.error || 'unknown'}`);
  }
  throw new Error(`Shotstack render ${renderId} timed out`);
}

// Poll fal for each outstanding job ID and return the clip URL if done.
// Returns null if the job is still in progress.
async function pollFalJob(requestId) {
  try {
    const status = await fal.queue.status(KLING_MODEL, { requestId });
    if (status.status === 'COMPLETED') {
      const result = await fal.queue.result(KLING_MODEL, { requestId });
      return result?.data?.video?.url || result?.video?.url || null;
    }
    if (status.status === 'FAILED') {
      throw new Error(`Kling job ${requestId} failed`);
    }
    return null; // still IN_QUEUE or IN_PROGRESS
  } catch (err) {
    if (err.message && err.message.includes('failed')) throw err;
    console.warn(`[cron-assemble-skits] fal status check error for ${requestId}:`, err && err.message);
    return null;
  }
}

async function assembleSkit(skit, clipUrls) {
  const skitId = skit.id;
  const topic = skit.topic || skitId;
  const script = skit.script_json || {};
  const lines = Array.isArray(script.lines) ? script.lines : [];

  if (lines.length === 0) throw new Error('skit has no lines in script_json');

  const voiceoverText = buildVoiceoverText(lines);
  if (!voiceoverText) throw new Error('skit lines produced empty voiceover text');

  const voiceId = pickPrimaryVoice(lines);
  const persona = voiceId === VOICE_IDS.luna ? 'luna' : 'bill';
  const { buffer: audioBuffer } = await generateSpeech(voiceoverText, {
    elevenLabsVoiceId: voiceId,
    persona,
    elevenLabsModelId: 'eleven_multilingual_v2',
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  });

  const voiceoverUrl = await uploadVoiceover(skitId, audioBuffer);
  console.log(`[cron-assemble-skits] Voiceover uploaded: ${voiceoverUrl}`);

  const shotstackPayload = buildShotstackPayload(clipUrls, voiceoverUrl);
  const renderId = await createShotstackRender(shotstackPayload);
  const videoUrl = await pollShotstackRender(renderId);
  console.log(`[cron-assemble-skits] Render complete for skit ${skitId}: ${videoUrl}`);

  await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'video_rendered',
      video_url: videoUrl,
      render_completed_at: new Date().toISOString(),
      render_failed_reason: null,
    }),
  });

  await sendTelegram(`Reel rendered: ${topic}\nSending for final approval...`);
  return videoUrl;
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
    return res.status(200).json({ ok: true, skipped: true, reason: 'FAL_KEY not set' });
  }
  if (!SHOTSTACK_API_KEY) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'SHOTSTACK_API_KEY not set' });
  }

  fal.config({ credentials: FAL_KEY });

  // Find rendering skits that are old enough that the webhook should have fired by now
  const cutoff = new Date(Date.now() - MIN_RENDER_AGE_MINUTES * 60 * 1000).toISOString();
  const { data: rows, ok: fetchOk } = await supabaseFetch(
    `/rest/v1/skit_queue?status=eq.rendering&render_started_at=lt.${cutoff}&order=render_started_at.asc&limit=2`,
  );

  if (!fetchOk) {
    console.error('[cron-assemble-skits] Failed to query skit_queue');
    return res.status(502).json({ ok: false, error: 'Failed to query skit_queue' });
  }

  const skits = Array.isArray(rows) ? rows : [];
  console.log(`[cron-assemble-skits] ${skits.length} skits in rendering state past age threshold`);

  if (skits.length === 0) {
    return res.status(200).json({ ok: true, checked: 0, message: 'no stale rendering skits' });
  }

  const results = [];

  for (const skit of skits) {
    const skitId = skit.id;
    const jobIds = Array.isArray(skit.kling_job_ids) ? skit.kling_job_ids : [];
    const existingClipUrls = Array.isArray(skit.kling_clip_urls) ? [...skit.kling_clip_urls] : [];

    if (jobIds.length === 0) {
      console.error(`[cron-assemble-skits] Skit ${skitId} in rendering with no kling_job_ids — marking failed`);
      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'render_failed', render_failed_reason: 'rendering status but no kling_job_ids' }),
      });
      results.push({ id: skitId, ok: false, error: 'no job IDs' });
      continue;
    }

    // Poll each outstanding job
    let pollFailed = false;
    for (let i = 0; i < jobIds.length; i++) {
      if (existingClipUrls[i]) continue; // already have this clip from a previous callback
      try {
        const clipUrl = await pollFalJob(jobIds[i]);
        if (clipUrl) {
          existingClipUrls[i] = clipUrl;
        }
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error(`[cron-assemble-skits] Skit ${skitId} job ${jobIds[i]} poll error: ${msg}`);
        pollFailed = true;
        await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'render_failed', render_failed_reason: msg.slice(0, 500) }),
        });
        break;
      }
    }

    if (pollFailed) {
      results.push({ id: skitId, ok: false, error: 'fal job failed' });
      continue;
    }

    const allReady = existingClipUrls.length === jobIds.length && existingClipUrls.every(Boolean);

    if (!allReady) {
      const doneCount = existingClipUrls.filter(Boolean).length;
      console.log(`[cron-assemble-skits] Skit ${skitId}: ${doneCount}/${jobIds.length} clips ready — still waiting`);
      // Update the partial clip URLs we collected so the next run starts from here
      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ kling_clip_urls: existingClipUrls }),
      });
      results.push({ id: skitId, ok: true, clips_ready: doneCount, total: jobIds.length, status: 'still_rendering' });
      continue;
    }

    // All clips ready — assemble
    console.log(`[cron-assemble-skits] Skit ${skitId}: all clips ready via poll — assembling`);
    try {
      const videoUrl = await assembleSkit(skit, existingClipUrls);
      results.push({ id: skitId, ok: true, video_url: videoUrl, status: 'assembled' });
    } catch (err) {
      const reason = err && err.message ? err.message.slice(0, 500) : String(err);
      console.error(`[cron-assemble-skits] Assembly failed for skit ${skitId}: ${reason}`);
      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'render_failed', render_failed_reason: reason }),
      }).catch(() => {});
      await sendTelegram(`Reel assembly FAILED: ${skit.topic || skitId}\nError: ${reason.slice(0, 200)}`);
      results.push({ id: skitId, ok: false, error: reason.slice(0, 300) });
    }
  }

  return res.status(200).json({ ok: true, checked: skits.length, results });
};
