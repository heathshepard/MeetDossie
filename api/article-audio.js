'use strict';

// api/article-audio.js
// "Listen to this guide" — TTS for /guides/* and /answers/* article pages.
//
// GET /api/article-audio?type=guide|answer&slug=<slug>
//
// Architecture: on-demand generation, cached in Supabase Storage after the
// first request. Pre-generating audio for all ~50 guide/answer pages up
// front would burn roughly 150-200k ElevenLabs characters/credits against
// the 30k/mo Creator-plan cap for pages that may never get a single play.
// On-demand keeps spend proportional to actual reader demand — worst case,
// every page gets read once and costs ~1 credit/char (~3-4k credits/page).
//
// Cache hit  -> 302 redirect straight to the Supabase Storage public URL
//               (Storage's own CDN serves the bytes, not this function).
// Cache miss -> generate via ElevenLabs (Luna voice, same narration model/
//               settings already proven in cron-render-videos.js), upload
//               to Storage, then stream the mp3 back directly.
//
// Voice: Luna (lxYfHSkYm1EzQzGhdbfc). Heath asked for "Darcy" — no such
// voice exists anywhere in this codebase or the ElevenLabs account; it's a
// known STT mishearing of "Dossie" (see AGENT_PROMPTS name-correction rule
// in api/chat.js). Luna is the existing warm-female voice used for
// Dossie's own narration elsewhere (cron-render-videos.js) and is the
// better tone fit for reading an article aloud than Bill (male, used for
// male-persona video voiceover).

const fs = require('fs');
const path = require('path');
const { generateSpeech } = require('./_utils/tts');

const GUIDES_DIR = path.join(__dirname, '..', 'marketing', 'guides-data');
const ANSWERS_DIR = path.join(__dirname, '..', 'marketing', 'answers-data');

const LUNA_VOICE_ID = 'lxYfHSkYm1EzQzGhdbfc';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'article-audio';

const SLUG_RE = /^[a-z0-9-]{1,120}$/;
const MAX_TTS_CHARS = 9000; // guides run up to ~9k chars; comfortably under the Creator-plan per-request ceiling

function sbHeaders(extra) {
  return Object.assign(
    { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    extra || {}
  );
}

function publicUrl(objectPath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
}

function decodeEntities(s) {
  return s
    .replace(/&rsquo;|&#8217;/g, '’')
    .replace(/&lsquo;|&#8216;/g, '‘')
    .replace(/&rdquo;|&#8221;/g, '”')
    .replace(/&ldquo;|&#8220;/g, '“')
    .replace(/&ndash;|&#8211;/g, '-')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Turn body_html into text that reads naturally aloud: headings, paragraphs,
// and list items become sentence-ending pauses; everything else is stripped
// of markup. Full legal-form body text (verbatim TREC clause quotes) reads
// fine here — it's the surrounding CTA/legal-disclaimer chrome we deliberately
// leave out by only reading body_html, not the whole page template.
function htmlToSpeechText(html) {
  if (!html) return '';
  return decodeEntities(
    String(html)
      .replace(/<\/(p|li|h2|h3|h4|blockquote|div)>/gi, '. ')
      .replace(/<br\s*\/?>/gi, '. ')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s+\./g, '.')
      .replace(/\.{2,}/g, '.')
      .trim()
  );
}

function loadArticle(type, slug) {
  const dir = type === 'answer' ? ANSWERS_DIR : GUIDES_DIR;
  const file = path.join(dir, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildSpeechText(data) {
  const parts = [];
  if (data.title) parts.push(String(data.title).replace(/\s*\([^)]*\)\s*/g, ' ')); // drop parenthetical form numbers — reads awkwardly aloud
  if (data.deck) parts.push(data.deck);
  if (data.tldr) parts.push(data.tldr);
  parts.push(htmlToSpeechText(data.body_html));
  return parts.filter(Boolean).join('. ').replace(/\s+/g, ' ').trim();
}

async function ensureBucket() {
  const check = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers: sbHeaders() });
  if (check.ok) return true;
  const create = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 20971520 }),
  });
  if (create.ok || create.status === 409) return true;
  console.warn('[article-audio] bucket create failed', create.status, await create.text().catch(() => ''));
  return false;
}

async function uploadToCache(objectPath, buffer) {
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  try {
    if (!(await ensureBucket())) return false;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(objectPath)}`, {
      method: 'POST',
      headers: sbHeaders({ 'Content-Type': 'audio/mpeg', 'x-upsert': 'true' }),
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      console.warn('[article-audio] upload failed', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[article-audio] upload error', e.message);
    return false;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const type = req.query.type === 'answer' ? 'answer' : 'guide';
  const slug = String(req.query.slug || '');
  if (!SLUG_RE.test(slug)) return res.status(400).json({ ok: false, error: 'invalid slug' });

  const objectPath = `${type}/${slug}.mp3`;

  // Cache hit — redirect straight to Supabase's CDN, no Vercel bandwidth spent.
  if (SUPABASE_URL) {
    try {
      const head = await fetch(publicUrl(objectPath), { method: 'HEAD' });
      if (head.ok) {
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.redirect(302, publicUrl(objectPath));
      }
    } catch (e) {
      console.warn('[article-audio] cache check failed', e.message);
    }
  }

  const data = loadArticle(type, slug);
  if (!data) return res.status(404).json({ ok: false, error: 'article not found' });

  const text = buildSpeechText(data);
  if (!text) return res.status(422).json({ ok: false, error: 'no readable content' });

  const finalText = text.length > MAX_TTS_CHARS
    ? text.slice(0, MAX_TTS_CHARS).replace(/\s+\S*$/, '') + '.'
    : text;

  try {
    // eleven_turbo_v2_5, not eleven_multilingual_v2 — this is a live click-and-
    // wait request, not an async cron render. multilingual_v2 (used for short
    // pre-rendered voiceover clips in cron-render-videos.js) took 58-90s to
    // synthesize a full article here; turbo is ElevenLabs' low-latency model
    // and is what the other user-facing endpoints (api/voice/tts.js,
    // api/speak.js) already use for exactly this reason.
    const { buffer, provider } = await generateSpeech(finalText, {
      elevenLabsVoiceId: LUNA_VOICE_ID,
      persona: 'luna',
      elevenLabsModelId: 'eleven_turbo_v2_5',
      voiceSettings: { stability: 0.5, similarity_boost: 0.75 },
    });

    // Cache write before responding — Vercel can freeze the lambda once the
    // handler returns, so an unawaited "fire and forget" upload risks never
    // completing. The extra latency here is one small Storage PUT.
    await uploadToCache(objectPath, buffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-TTS-Provider', provider);
    res.status(200);
    res.write(buffer);
    return res.end();
  } catch (err) {
    console.error('[article-audio] fatal', err);
    if (!res.headersSent) return res.status(500).json({ ok: false, error: 'TTS failed' });
    return res.end();
  }
};
