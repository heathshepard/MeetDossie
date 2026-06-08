// Vercel Serverless Function: /api/cron-render-skits
// Picks up skit_queue rows where status='script_approved' and renders them
// to finished vertical MP4s using Kling (via fal.ai) + ElevenLabs + Shotstack.
//
// Pipeline per skit:
//   1. Fetch up to 2 script_approved skits from skit_queue
//   2. Generate 4 Kling video clips via fal.ai (one per scene)
//   3. Generate ElevenLabs voiceover from skit lines (Bill voice)
//   4. Upload voiceover to Supabase Storage (voiceovers bucket)
//   5. Assemble clips + voiceover + auto-captions via Shotstack
//   6. Poll Shotstack until done (max 5 min)
//   7. Write video_url + status='video_rendered' back to skit_queue
//   8. Send Telegram notification
//
// Auth: x-vercel-cron: 1 OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — "0 13 * * *" (1PM UTC / 8AM CST, after script approval window)
//
// Env vars required: FAL_KEY, ELEVENLABS_API_KEY, SHOTSTACK_API_KEY,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

const { fal } = require('@fal-ai/client');
const { generateSpeech } = require('./_utils/tts');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FAL_KEY = process.env.FAL_KEY;
const SHOTSTACK_API_KEY = process.env.SHOTSTACK_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

// Kling model — use same version as generate-broll.js but text-to-video
const KLING_MODEL = 'fal-ai/kling-video/v1.6/standard/text-to-video';

// Shotstack sandbox endpoint (free tier, 20 min/month)
// Switch to 'https://api.shotstack.io/v1/render' when moving to production key
const SHOTSTACK_BASE = 'https://api.shotstack.io/stage';

// ElevenLabs voice IDs (from CLAUDE.md)
const VOICE_IDS = {
  bill:    'pqHfZKP75CvOlQylNhV4',
  luna:    'lxYfHSkYm1EzQzGhdbfc',
  charlie: 'pqHfZKP75CvOlQylNhV4', // map charlie to Bill (closest male match)
};

const MAX_SKITS_PER_RUN = 2;
const KLING_POLL_INTERVAL_MS = 8000;
const KLING_MAX_WAIT_MS = 300000; // 5 min per clip
const SHOTSTACK_POLL_INTERVAL_MS = 5000;
const SHOTSTACK_MAX_WAIT_MS = 300000; // 5 min for full render

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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.warn('[cron-render-skits] Telegram notify failed:', err && err.message);
  }
}

// Generate one Kling clip from a scene prompt. Returns the video URL string.
async function generateKlingClip(prompt) {
  fal.config({ credentials: FAL_KEY });

  console.log(`[cron-render-skits] Kling: submitting clip prompt="${prompt.slice(0, 60)}..."`);

  const result = await fal.subscribe(KLING_MODEL, {
    input: {
      prompt: prompt.trim(),
      duration: '5',
      aspect_ratio: '9:16',
    },
    pollInterval: KLING_POLL_INTERVAL_MS,
    timeout: KLING_MAX_WAIT_MS,
    logs: false,
  });

  const videoUrl = result?.data?.video?.url;
  if (!videoUrl) {
    throw new Error(`Kling returned no video URL. Raw: ${JSON.stringify(result?.data || {}).slice(0, 300)}`);
  }

  console.log(`[cron-render-skits] Kling clip done: ${videoUrl}`);
  return videoUrl;
}

// Build voiceover text from skit lines array: [["bill", "text"], ...]
// Concatenates all line texts with a natural pause between speakers.
function buildVoiceoverText(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  return lines.map(([, text]) => String(text || '').trim()).filter(Boolean).join(' ');
}

// Determine the primary voice for a skit based on which voice appears most in lines.
// Falls back to Bill if no clear winner.
function pickPrimaryVoice(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return VOICE_IDS.bill;
  const counts = {};
  for (const [voice] of lines) {
    const key = String(voice || '').toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  // Narrator/bill always wins ties — used for the overall voiceover track
  if (counts.bill) return VOICE_IDS.bill;
  if (counts.charlie) return VOICE_IDS.charlie;
  if (counts.luna) return VOICE_IDS.luna;
  return VOICE_IDS.bill;
}

// Upload an audio buffer to Supabase Storage voiceovers bucket.
// Returns the public URL.
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
      console.log(`[cron-render-skits] voiceover already exists — reusing`);
      return `${SUPABASE_URL}/storage/v1/object/public/voiceovers/${encodeURIComponent(filename)}`;
    }
    throw new Error(`Supabase voiceover upload failed: ${res.status} ${body.slice(0, 200)}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/voiceovers/${encodeURIComponent(filename)}`;
}

// Build the Shotstack render payload from 4 clip URLs + voiceover URL.
// Output: vertical 9:16 MP4, 25fps, HD, auto-captions.
function buildShotstackPayload(clipUrls, voiceoverUrl) {
  const clipLength = 5; // seconds per Kling clip
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

// POST render to Shotstack. Returns the render ID.
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
  console.log(`[cron-render-skits] Shotstack render submitted: ${renderId}`);
  return renderId;
}

// Poll Shotstack until the render is done. Returns the MP4 URL.
async function pollShotstackRender(renderId) {
  const start = Date.now();
  while (Date.now() - start < SHOTSTACK_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, SHOTSTACK_POLL_INTERVAL_MS));
    const res = await fetch(`${SHOTSTACK_BASE}/renders/${renderId}`, {
      headers: { 'x-api-key': SHOTSTACK_API_KEY },
    });
    if (!res.ok) {
      console.warn(`[cron-render-skits] Shotstack poll HTTP ${res.status} — retrying`);
      continue;
    }
    const data = await res.json();
    const status = data?.response?.status;
    console.log(`[cron-render-skits] Shotstack render ${renderId} status=${status}`);
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

// Render one skit end-to-end. Returns { video_url } on success, throws on failure.
async function renderSkit(skit) {
  const skitId = skit.id;
  const script = skit.script_json || {};
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  const lines = Array.isArray(script.lines) ? script.lines : [];

  if (scenes.length === 0) throw new Error('skit has no scenes in script_json');
  if (lines.length === 0) throw new Error('skit has no lines in script_json');

  // Mark render as started
  await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ render_started_at: new Date().toISOString() }),
  });

  // Step 1: Generate Kling clips sequentially (API rate limits, each ~60-90s)
  console.log(`[cron-render-skits] Generating ${scenes.length} Kling clips for skit ${skitId}`);
  const clipUrls = [];
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const prompt = String(scene.prompt || '');
    if (!prompt) throw new Error(`Scene ${i} has no prompt`);
    const clipUrl = await generateKlingClip(prompt);
    clipUrls.push(clipUrl);
  }

  // Step 2: Generate ElevenLabs voiceover
  console.log(`[cron-render-skits] Generating ElevenLabs voiceover for skit ${skitId}`);
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

  // Step 3: Upload voiceover to Supabase
  const voiceoverUrl = await uploadVoiceover(skitId, audioBuffer);
  console.log(`[cron-render-skits] Voiceover uploaded: ${voiceoverUrl}`);

  // Step 4: Build Shotstack payload and submit render
  const shotstackPayload = buildShotstackPayload(clipUrls, voiceoverUrl);
  const renderId = await createShotstackRender(shotstackPayload);

  // Step 5: Poll until done
  const videoUrl = await pollShotstackRender(renderId);
  console.log(`[cron-render-skits] Render complete for skit ${skitId}: ${videoUrl}`);

  return { video_url: videoUrl };
}

module.exports = async function handler(req, res) {
  // Auth check
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Graceful degradation: warn but return 200 so Vercel doesn't alert on missing keys.
  // These keys are added by Heath — the cron can exist before they're configured.
  if (!FAL_KEY) {
    console.error('[cron-render-skits] FAL_KEY not configured — skipping run');
    return res.status(200).json({ ok: true, skipped: true, reason: 'FAL_KEY not set' });
  }
  if (!SHOTSTACK_API_KEY) {
    console.error('[cron-render-skits] SHOTSTACK_API_KEY not configured — skipping run');
    return res.status(200).json({ ok: true, skipped: true, reason: 'SHOTSTACK_API_KEY not set — add it to Vercel env vars' });
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error('[cron-render-skits] ELEVENLABS_API_KEY not configured — skipping run');
    return res.status(200).json({ ok: true, skipped: true, reason: 'ELEVENLABS_API_KEY not set' });
  }

  // Fetch script_approved skits
  const { data: rows, ok: fetchOk } = await supabaseFetch(
    `/rest/v1/skit_queue?status=eq.script_approved&order=created_at.asc&limit=${MAX_SKITS_PER_RUN}`,
  );

  if (!fetchOk) {
    console.error('[cron-render-skits] Failed to query skit_queue');
    return res.status(502).json({ ok: false, error: 'Failed to query skit_queue' });
  }

  const skits = Array.isArray(rows) ? rows : [];
  console.log(`[cron-render-skits] ${skits.length} skits ready to render`);

  if (skits.length === 0) {
    return res.status(200).json({ ok: true, rendered: 0, message: 'no script_approved skits' });
  }

  const results = [];
  let rendered = 0;
  let failed = 0;

  for (const skit of skits) {
    const skitId = skit.id;
    const topic = skit.topic || skitId;
    console.log(`[cron-render-skits] Rendering skit: ${skitId} (topic=${topic})`);

    try {
      const { video_url } = await renderSkit(skit);

      // Update skit_queue with rendered video
      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'video_rendered',
          video_url,
          render_completed_at: new Date().toISOString(),
          render_failed_reason: null,
        }),
      });

      await sendTelegram(`Reel rendered: ${topic}\nSending for final approval...`);
      results.push({ id: skitId, ok: true, video_url });
      rendered++;
    } catch (err) {
      const reason = err && err.message ? err.message.slice(0, 500) : String(err);
      console.error(`[cron-render-skits] FAILED skit ${skitId}: ${reason}`);

      await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'render_failed',
          render_failed_reason: reason,
        }),
      }).catch(() => {});

      await sendTelegram(`Reel render FAILED: ${topic}\nError: ${reason.slice(0, 200)}`);
      results.push({ id: skitId, ok: false, error: reason.slice(0, 300) });
      failed++;
    }
  }

  return res.status(200).json({
    ok: failed === 0,
    rendered,
    failed,
    total: skits.length,
    results,
  });
};
