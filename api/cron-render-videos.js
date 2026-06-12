// Vercel Serverless Function: /api/cron-render-videos
// Picks up social_posts where video_required=true AND media_url IS NULL,
// renders a Creatomate video (screen recording frame + ElevenLabs voiceover),
// and writes the rendered video URL back to social_posts.media_url.
//
// This runs BETWEEN cron-generate-posts (11:00 UTC) and cron-send-for-approval
// (11:30 UTC), giving Heath a 30-minute window to render all videos before the
// approval messages hit Telegram. Schedule: 11:10 UTC daily.
//
// Pipeline per post:
//   1. Select best screen recording from RECORDING_MAP (topic + platform match)
//   2. Upload a static JPEG frame to Supabase social-cards bucket (via service role)
//   3. Generate ElevenLabs TTS from voiceover_script, upload to voiceovers bucket
//   4. Call Creatomate REST API (template 791117d0-665c-4cd0-ba5f-a767f8921f9b)
//   5. Poll until succeeded (max 5 min)
//   6. PATCH social_posts.media_url = rendered video URL
//   7. Notify Heath via Telegram on batch completion
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1
// Schedule: vercel.json — "10 11 * * *"
//
// Cost per post:
//   ElevenLabs: ~50-100 credits (voiceover_script ~400-500 chars)
//   Creatomate: free plan covers test volume; check dashboard monthly
//   Supabase Storage: negligible

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const CREATOMATE_TEMPLATE_ID = '791117d0-665c-4cd0-ba5f-a767f8921f9b';
const CREATOMATE_API_URL = 'https://api.creatomate.com/v1/renders';

const { generateSpeech } = require('./_utils/tts');

// ElevenLabs voice IDs (from CLAUDE.md)
const VOICE_MAP = {
  victor:   'pqHfZKP75CvOlQylNhV4', // Bill
  brenda:   'pqHfZKP75CvOlQylNhV4', // Bill (per generate-creatomate-video.py convention)
  patricia: 'lxYfHSkYm1EzQzGhdbfc', // Luna
  dossie:   'lxYfHSkYm1EzQzGhdbfc', // Luna (brand voice defaults to Luna)
};
const VOICE_DEFAULT = 'lxYfHSkYm1EzQzGhdbfc'; // Luna

// Screen recording selection map.
// Key: platform group (mobile = instagram/tiktok, desktop = facebook/twitter/linkedin)
// Each entry: { filename, topic_match: string[] }
// The renderer picks the FIRST match for the post's topic, falling back to the
// last entry (general fallback). Update this when Heath records new footage.
// Source of truth: Media/screen-recordings/LIBRARY.md
const RECORDING_MAP = {
  mobile: [
    { filename: 'pipeline-mobile-2026-05-29.mp4',        topics: ['pipeline', 'day_in_the_life', 'cost_math', 'control_freak_agent', 'community_movement', 'feature_reveal', 'build_in_public'] },
    { filename: 'talk-to-dossie-mobile-2026-05-06.mp4',  topics: ['capability_oneliners', 'pain_points'], persona_lock: 'victor' },
    { filename: 'morning-brief-mobile-2026-05-06.mp4',   topics: ['morning_brief'] },
    { filename: 'trec-deadlines-mobile-2026-05-06.mp4',  topics: ['trec_education', 'trec_deadlines'] },
    // General fallback
    { filename: 'pipeline-mobile-2026-05-29.mp4',        topics: [] },
  ],
  desktop: [
    { filename: 'amendment-demo-desktop-2026-05-27.mp4', topics: ['capability_oneliners', 'feature_reveal'] },
    { filename: 'draft-emails-desktop-2026-05-26-b.mp4', topics: ['cost_math', 'pain_points', 'day_in_the_life'] },
    { filename: 'trec-deadlines-desktop-2026-05-26.mp4', topics: ['trec_education', 'trec_deadlines', 'control_freak_agent'] },
    // General fallback
    { filename: 'draft-emails-desktop-2026-05-26-b.mp4', topics: [] },
  ],
};

const SUPABASE_SCREEN_RECORDINGS_PREFIX =
  'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/social-cards/screen-frames/';
const SUPABASE_VOICEOVERS_PREFIX =
  'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/voiceovers/';

const MOBILE_PLATFORMS = new Set(['instagram', 'tiktok']);

// How many posts to render in one Vercel invocation. Creatomate renders take
// ~30-60s each; 3 posts = ~3 min, safely under the 90s maxDuration.
// Remaining posts render on the next scheduled run (or a self-heal pass).
const MAX_PER_RUN = 3;

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

function pickRecording(topic, persona, platform) {
  const group = MOBILE_PLATFORMS.has(platform) ? 'mobile' : 'desktop';
  const candidates = RECORDING_MAP[group] || [];
  const topicKey = String(topic || '').toLowerCase();
  const personaKey = String(persona || '').toLowerCase();

  // Find first entry whose topics list includes this topic
  for (const entry of candidates) {
    if (entry.topics.length === 0) continue; // skip fallback on first pass
    if (entry.persona_lock && entry.persona_lock !== personaKey) continue;
    if (entry.topics.some((t) => topicKey.includes(t) || t.includes(topicKey))) {
      return entry.filename;
    }
  }
  // Fallback: last entry (always has topics:[])
  const fallback = candidates[candidates.length - 1];
  return fallback ? fallback.filename : null;
}

// Download a screen recording from Supabase Storage using service role.
// Returns ArrayBuffer.
async function downloadScreenRecording(filename) {
  const url = `${SUPABASE_URL}/storage/v1/object/authenticated/screen-recordings/${encodeURIComponent(filename)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to download screen recording ${filename}: ${res.status}`);
  }
  return res.arrayBuffer();
}

// Extract a JPEG frame at offsetSeconds using a Vercel-compatible approach.
// Since we can't spawn ffmpeg on Vercel, we use a lighter trick: upload the
// video to a temporary Supabase URL and call a pre-signed transformation.
// Fallback: use a 1x1 blush-colored JPEG placeholder so the render doesn't
// block on ffmpeg. Creatomate will show the frame as a static image element.
//
// REAL IMPLEMENTATION NOTE: Vercel serverless cannot run ffmpeg. Two options:
//   A. Pre-upload frame JPEGs alongside each MP4 (filename: <stem>-frame.jpg).
//      The DONE handler already does this via generate-creatomate-video.py.
//      This cron checks for a pre-existing frame first.
//   B. Use Supabase Storage image transformation (only works for images, not video).
//
// For now: check for pre-uploaded <stem>-frame.jpg in social-cards bucket.
// If not found, use the screen recording's Supabase public URL directly
// as Image-K8V — Creatomate accepts video URLs for image elements and
// extracts the first frame server-side.
async function resolveFrameUrl(filename) {
  const stem = filename.replace(/\.mp4$/i, '');
  const frameFilename = `${stem}-frame.jpg`;
  // Check if a pre-uploaded frame exists
  const checkRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/info/social-cards/${encodeURIComponent(frameFilename)}`,
    { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (checkRes.ok) {
    // Frame exists — use it
    return `${SUPABASE_URL}/storage/v1/object/public/social-cards/${encodeURIComponent(frameFilename)}`;
  }
  // No pre-uploaded frame — pass the public screen recording URL.
  // Creatomate image elements accept video URLs and extract first frame.
  // This only works if the screen-recordings bucket is public. If it's private,
  // Heath must run generate-creatomate-video.py locally to pre-upload frames.
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/screen-recordings/${encodeURIComponent(filename)}`;
  console.log(`[cron-render-videos] no pre-uploaded frame for ${filename} — passing video URL directly to Creatomate`);
  return publicUrl;
}

async function generateElevenLabsAudio(text, voiceId) {
  // Determine persona from voice ID for OpenAI fallback voice selection.
  const persona = voiceId === 'lxYfHSkYm1EzQzGhdbfc' ? 'luna' : 'bill';
  const { buffer } = await generateSpeech(text, {
    elevenLabsVoiceId: voiceId,
    persona,
    elevenLabsModelId: 'eleven_multilingual_v2',
    voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
  });
  return buffer; // Node Buffer — compatible with new Uint8Array(buffer) downstream
}

async function uploadToSupabase(bucket, path, dataBuffer, contentType) {
  const bytes = new Uint8Array(dataBuffer);
  const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
    },
    body: bytes,
  });
  if (!res.ok) {
    const body = await res.text();
    // 409 = already exists — that's fine, reuse the existing file
    if (res.status === 409 || body.includes('Duplicate')) {
      console.log(`[cron-render-videos] storage: ${path} already exists — reusing`);
      return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
    }
    throw new Error(`Supabase upload failed for ${bucket}/${path}: ${res.status} ${body.slice(0, 200)}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${encodeURIComponent(path)}`;
}

async function createCreatomateRender(imageUrl, audioUrl, personaName, caption) {
  const modifications = {
    'Image-K8V': imageUrl,
    'Persona-Name': personaName,
    'Caption': caption.slice(0, 200), // card caption — truncated for visual fit
    'Voiceover.source': audioUrl,
    'Voiceover.provider': '', // clear ElevenLabs provider; use static audio URL
  };
  const payload = {
    template_id: CREATOMATE_TEMPLATE_ID,
    modifications,
  };
  const res = await fetch(CREATOMATE_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CREATOMATE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Creatomate render create failed: ${res.status} ${text.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Creatomate returned non-JSON: ${text.slice(0, 200)}`); }
  // Creatomate v1 returns an array when using template_id
  const render = Array.isArray(data) ? data[0] : data;
  const renderId = render?.id;
  if (!renderId) throw new Error(`Creatomate returned no render id: ${text.slice(0, 300)}`);
  return renderId;
}

async function pollCreatomateRender(renderId, maxWaitMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 8000)); // poll every 8s
    const res = await fetch(`${CREATOMATE_API_URL}/${renderId}`, {
      headers: { Authorization: `Bearer ${CREATOMATE_API_KEY}` },
    });
    if (!res.ok) continue;
    const data = await res.json();
    const status = data?.status;
    console.log(`[cron-render-videos] render ${renderId} status=${status}`);
    if (status === 'succeeded') return data?.url || null;
    if (status === 'failed') throw new Error(`Creatomate render failed: ${data?.error_message || 'unknown'}`);
  }
  throw new Error(`Creatomate render ${renderId} timed out after ${maxWaitMs / 1000}s`);
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
    console.warn('[cron-render-videos] Telegram notify failed:', err && err.message);
  }
}

module.exports = withTelemetry('cron-render-videos', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Guard: warn but don't block if Creatomate or ElevenLabs not configured.
  // This lets the route exist without crashing on a missing key; Heath can add
  // the key when ready and the next cron run will process the backlog.
  if (!CREATOMATE_API_KEY) {
    console.error('[cron-render-videos] CREATOMATE_API_KEY not configured — skipping run');
    return res.status(200).json({ ok: true, skipped: true, reason: 'CREATOMATE_API_KEY not set' });
  }
  if (!ELEVENLABS_API_KEY) {
    console.error('[cron-render-videos] ELEVENLABS_API_KEY not configured — skipping run');
    return res.status(200).json({ ok: true, skipped: true, reason: 'ELEVENLABS_API_KEY not set' });
  }

  // Query posts that need a video render.
  // Include pending_video: the publish cron parks instagram/tiktok posts there
  // when media_url is null. Without this, backed-up posts are never retried.
  const { data: posts, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?video_required=eq.true&media_url=is.null&status=in.(draft,approved,pending_video)&order=created_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'Failed to query posts needing video render' });
  }

  const queue = Array.isArray(posts) ? posts : [];
  console.log(`[cron-render-videos] ${queue.length} posts need video render`);

  if (queue.length === 0) {
    return res.status(200).json({ ok: true, rendered: 0, message: 'no posts need video render' });
  }

  const results = [];
  let rendered = 0;
  let failed = 0;

  for (const post of queue) {
    const postId = post.id;
    const platform = String(post.platform || '').toLowerCase();
    const persona = String(post.persona || 'dossie').toLowerCase();
    const topic = String(post.topic || '').toLowerCase();
    const voiceoverText = String(post.voiceover_script || post.hook || post.content || '').slice(0, 1000);
    const caption = String(post.content || '').slice(0, 200);

    console.log(`[cron-render-videos] processing post ${postId} (${platform}/${persona} topic=${topic})`);

    try {
      // 1. Pick screen recording
      const recordingFilename = pickRecording(topic, persona, platform);
      if (!recordingFilename) {
        throw new Error(`No screen recording available for topic=${topic} platform=${platform}`);
      }
      console.log(`[cron-render-videos] using recording: ${recordingFilename}`);

      // 2. Resolve frame URL (pre-uploaded JPEG or video URL for Creatomate first-frame)
      const frameUrl = await resolveFrameUrl(recordingFilename);
      console.log(`[cron-render-videos] frame URL: ${frameUrl}`);

      // 3. Generate ElevenLabs audio
      const voiceId = VOICE_MAP[persona] || VOICE_DEFAULT;
      const audioBuffer = await generateElevenLabsAudio(voiceoverText, voiceId);
      const audioFilename = `${post.post_id || postId}-voiceover.mp3`;
      const audioUrl = await uploadToSupabase('voiceovers', audioFilename, audioBuffer, 'audio/mpeg');
      console.log(`[cron-render-videos] audio uploaded: ${audioUrl}`);

      // 4. Create Creatomate render
      const personaName = persona.charAt(0).toUpperCase() + persona.slice(1);
      const renderId = await createCreatomateRender(frameUrl, audioUrl, personaName, caption);
      console.log(`[cron-render-videos] Creatomate render created: ${renderId}`);

      // 5. Poll for completion
      const videoUrl = await pollCreatomateRender(renderId);
      if (!videoUrl) throw new Error('Creatomate returned no video URL after succeeded status');
      console.log(`[cron-render-videos] render complete: ${videoUrl}`);

      // 6. Write video URL back to social_posts.
      // Restore status based on whether Heath already approved this post:
      //   - approved_at set → restore to 'approved' so publish cron picks it up immediately
      //   - approved_at null → restore to 'draft' so it routes through the normal Telegram approval flow
      // Posts land here as pending_video (parked by publish cron when media_url was null)
      // or as draft (never approved). Clear error_message so stale failure text is gone.
      const restoredStatus = post.approved_at ? 'approved' : 'draft';
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ media_url: videoUrl, status: restoredStatus, error_message: null }),
      });
      if (!patch.ok) throw new Error(`Failed to patch media_url on post ${postId}: ${patch.status}`);

      console.log(`[cron-render-videos] patched post ${postId} with media_url=${videoUrl}`);
      results.push({ post_id: postId, platform, ok: true, video_url: videoUrl });
      rendered++;
    } catch (err) {
      const errMsg = err && err.message ? err.message : String(err);
      console.error(`[cron-render-videos] FAILED post ${postId}: ${errMsg}`);
      // Record failure in error_message — don't change status, let the next run retry
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ error_message: `video render failed: ${errMsg.slice(0, 500)}` }),
      }).catch(() => {});
      results.push({ post_id: postId, platform, ok: false, error: errMsg.slice(0, 300) });
      failed++;
    }
  }

  // Telegram summary
  const remaining = queue.length - rendered - failed;
  const lines = [
    `Video render batch complete`,
    `Rendered: ${rendered}/${queue.length}`,
    failed > 0 ? `Failed: ${failed} (check social_posts.error_message)` : null,
    remaining > 0 ? `More posts queued — will render on next run` : null,
  ].filter(Boolean);
  await sendTelegram(lines.join('\n'));

  return res.status(200).json({
    ok: failed === 0,
    rendered,
    failed,
    total: queue.length,
    results,
  });
});
