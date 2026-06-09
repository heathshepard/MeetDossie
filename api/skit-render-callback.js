// Vercel Serverless Function: /api/skit-render-callback
// Webhook receiver for fal.ai Kling clip completions.
//
// fal posts here when each individual clip finishes rendering.
// Query params (set by cron-render-skits when submitting jobs):
//   skit_id       — skit_queue.id
//   scene_index   — 0-based index of this scene
//   total_scenes  — total number of scenes for this skit
//
// On each call:
//   1. Extract the clip URL from fal's payload
//   2. Append it to kling_clip_urls[scene_index] in skit_queue
//   3. If all clips are now collected, proceed to Phase 2:
//      a. Generate ElevenLabs voiceover
//      b. Upload voiceover to Supabase Storage
//      c. Submit Shotstack render
//      d. Poll Shotstack to completion (max 5 min via streaming timeout)
//      e. Write video_url + status='video_rendered'
//      f. Send Telegram notification
//
// Auth: fal does not sign its webhooks. We validate skit_id and scene_index
//       exist in the DB and that the skit is in 'rendering' status.
//
// Env vars required: FAL_KEY, ELEVENLABS_API_KEY, SHOTSTACK_API_KEY,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN

const { generateSpeech } = require('./_utils/tts');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';
const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY;

const SHOTSTACK_BASE = 'https://api.shotstack.io/stage';
const SHOTSTACK_POLL_INTERVAL_MS = 5000;
const SHOTSTACK_MAX_WAIT_MS = 300000; // 5 min

// ElevenLabs voice IDs (from CLAUDE.md)
const VOICE_IDS = {
  bill:    'pqHfZKP75CvOlQylNhV4',
  luna:    'lxYfHSkYm1EzQzGhdbfc',
  charlie: 'pqHfZKP75CvOlQylNhV4',
};

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
    console.warn('[skit-render-callback] Telegram notify failed:', err && err.message);
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
      console.log(`[skit-render-callback] Voiceover already exists — reusing`);
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
      soundtrack: {
        src: voiceoverUrl,
        effect: 'fadeOut',
      },
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
    output: {
      format: 'mp4',
      resolution: 'hd',
      aspectRatio: '9:16',
      fps: 25,
    },
  };
}

async function createShotstackRender(payload) {
  const res = await fetch(`${SHOTSTACK_BASE}/render`, {
    method: 'POST',
    headers: {
      'x-api-key': SHOTSTACK_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Shotstack render create failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Shotstack returned non-JSON: ${text.slice(0, 200)}`);
  }
  const renderId = data?.response?.id;
  if (!renderId) {
    throw new Error(`Shotstack returned no render ID: ${text.slice(0, 300)}`);
  }
  console.log(`[skit-render-callback] Shotstack render submitted: ${renderId}`);
  return renderId;
}

async function pollShotstackRender(renderId) {
  const start = Date.now();
  while (Date.now() - start < SHOTSTACK_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, SHOTSTACK_POLL_INTERVAL_MS));
    const res = await fetch(`${SHOTSTACK_BASE}/renders/${renderId}`, {
      headers: { 'x-api-key': SHOTSTACK_API_KEY },
    });
    if (!res.ok) {
      console.warn(`[skit-render-callback] Shotstack poll HTTP ${res.status} — retrying`);
      continue;
    }
    const data = await res.json();
    const status = data?.response?.status;
    console.log(`[skit-render-callback] Shotstack render ${renderId} status=${status}`);
    if (status === 'done') {
      const url = data?.response?.url;
      if (!url) throw new Error('Shotstack status=done but no URL returned');
      return url;
    }
    if (status === 'failed') {
      const err = data?.response?.error || 'unknown error';
      throw new Error(`Shotstack render failed: ${err}`);
    }
  }
  throw new Error(`Shotstack render ${renderId} timed out after ${SHOTSTACK_MAX_WAIT_MS / 1000}s`);
}

// Phase 2: called when all Kling clips for a skit are ready.
async function assembleSkit(skit, clipUrls) {
  const skitId = skit.id;
  const topic = skit.topic || skitId;
  const script = skit.script_json || {};
  const lines = Array.isArray(script.lines) ? script.lines : [];

  if (lines.length === 0) throw new Error('skit has no lines in script_json');

  // ElevenLabs voiceover
  console.log(`[skit-render-callback] Generating voiceover for skit ${skitId}`);
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
  console.log(`[skit-render-callback] Voiceover uploaded: ${voiceoverUrl}`);

  // Shotstack assembly
  const shotstackPayload = buildShotstackPayload(clipUrls, voiceoverUrl);
  const renderId = await createShotstackRender(shotstackPayload);
  const videoUrl = await pollShotstackRender(renderId);
  console.log(`[skit-render-callback] Render complete for skit ${skitId}: ${videoUrl}`);

  // Write back to DB
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Parse query params set by cron-render-skits when submitting the job
  const skitId = req.query && req.query.skit_id;
  const sceneIndex = req.query && parseInt(req.query.scene_index, 10);
  const totalScenes = req.query && parseInt(req.query.total_scenes, 10);

  if (!skitId || isNaN(sceneIndex) || isNaN(totalScenes)) {
    return res.status(400).json({ ok: false, error: 'Missing skit_id, scene_index, or total_scenes query params' });
  }

  // Parse fal webhook payload — fal POSTs JSON with the run result
  let payload;
  try {
    payload = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
  }

  // Extract clip URL from fal's response. fal wraps the model output in payload.data.
  // Kling returns: { video: { url: "https://..." } }
  const clipUrl = payload?.data?.video?.url || payload?.video?.url || null;

  if (!clipUrl) {
    console.error(`[skit-render-callback] No clip URL in fal payload for skit ${skitId} scene ${sceneIndex}:`, JSON.stringify(payload).slice(0, 300));
    return res.status(422).json({ ok: false, error: 'No video URL in fal payload' });
  }

  console.log(`[skit-render-callback] Skit ${skitId} scene ${sceneIndex}/${totalScenes - 1} clip URL: ${clipUrl}`);

  // Load the skit row to update kling_clip_urls
  const { ok: loadOk, data: rows } = await supabaseFetch(
    `/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}&limit=1`,
  );

  if (!loadOk || !Array.isArray(rows) || rows.length === 0) {
    console.error(`[skit-render-callback] Skit ${skitId} not found in DB`);
    return res.status(404).json({ ok: false, error: 'Skit not found' });
  }

  const skit = rows[0];

  if (skit.status !== 'rendering') {
    console.warn(`[skit-render-callback] Skit ${skitId} status=${skit.status} — ignoring late callback`);
    return res.status(200).json({ ok: true, ignored: true, reason: `status is ${skit.status}` });
  }

  // Merge this clip URL into the existing array (preserving order by index)
  const existingUrls = Array.isArray(skit.kling_clip_urls) ? [...skit.kling_clip_urls] : new Array(totalScenes).fill(null);
  existingUrls[sceneIndex] = clipUrl;

  await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ kling_clip_urls: existingUrls }),
  });

  // Check if all clips are present
  const allClipsReady = existingUrls.length === totalScenes && existingUrls.every(Boolean);

  if (!allClipsReady) {
    const doneCount = existingUrls.filter(Boolean).length;
    console.log(`[skit-render-callback] Skit ${skitId}: ${doneCount}/${totalScenes} clips ready — waiting`);
    return res.status(200).json({ ok: true, clips_ready: doneCount, total: totalScenes });
  }

  console.log(`[skit-render-callback] Skit ${skitId}: all ${totalScenes} clips ready — starting assembly`);

  // Respond to fal immediately so their webhook doesn't time out, then assemble async.
  // Vercel will keep the function alive as long as there is work in progress.
  res.status(200).json({ ok: true, assembling: true });

  // Assembly runs after the response is sent. Vercel keeps the lambda running.
  assembleSkit(skit, existingUrls).catch(async (err) => {
    const reason = err && err.message ? err.message.slice(0, 500) : String(err);
    console.error(`[skit-render-callback] Assembly failed for skit ${skitId}: ${reason}`);
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'render_failed',
        render_failed_reason: reason,
      }),
    }).catch(() => {});
    await sendTelegram(`Reel assembly FAILED: ${skit.topic || skitId}\nError: ${reason.slice(0, 200)}`);
  });
};
