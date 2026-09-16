// Vercel Serverless Function: POST /api/verify-video-vision
//
// Server-side proxy for the Anthropic vision calls
// api/_lib/verify-video-quality.js's checkVideoQuality() needs for its 4
// VISION-CHECKED rules (hook_visible_frame0, hook_cleared_by_3s,
// opening_not_login_or_empty, captions_present).
//
// WHY THIS EXISTS: ANTHROPIC_API_KEY is a write-only Vercel Sensitive var
// with no usable vault backup (CLAUDE.md §19 — `vercel env pull` returns
// the literal string "[SENSITIVE]"; Bitwarden needs Heath's master
// password). Heath's machine cannot read it. The quality gate is
// fail-closed BY DESIGN (see verify-video-quality.js's file header) — a
// missing key must HOLD a video, never silently skip the check — which
// meant every video built locally held forever on the vision rules alone,
// the single biggest blocker to unattended weekly video runs. This route
// runs the vision call where the real key already lives (Vercel), gated on
// a secret the local machine DOES have.
//
// Auth: Authorization: Bearer ${CRON_SECRET} — the approved manual-trigger
// pattern (CLAUDE.md §15, "Approved manual-trigger patterns"). CRON_SECRET
// is a real value in Heath's .env.local (Bitwarden-backed too), unlike
// ANTHROPIC_API_KEY.
//
// Request:  POST { images: [{ base64, mimeType }, ...], promptText }
//   images: 1-MAX_IMAGES entries, mimeType one of image/png, image/jpeg,
//   image/webp. Caller (verify-video-quality.js) compresses frames to JPEG
//   before sending — this route additionally enforces a hard per-image and
//   total-request size cap as defense in depth, independent of what the
//   caller intended to send.
//
// Response: 200 { ok: true, result: <parsed JSON the prompt asked for> }
//           401 / 400 / 500 / 502 { ok: false, error } on any failure.
//
// The caller MUST treat any non-200 or malformed response as fail-closed
// (HOLD the video), never as a pass — see
// scripts/regression-video-quality-vision-transport.js for the proof.
//
// Never logs or echoes ANTHROPIC_API_KEY. Never accepts a key from the
// client — always process.env only, read server-side.

'use strict';

const { extractVisionJson } = require('./_lib/vision-parse.js');

const CRON_SECRET = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const VISION_MODEL = 'claude-sonnet-5';

// Real max callers ever send today is 3 (captions_present). Generous
// headroom over that, still a real sanity cap, not a design target.
const MAX_IMAGES = 6;
// Per-image budget: ~2MB base64 (~1.5MB decoded). The caller's own
// compression (compressFrameForVision in verify-video-quality.js) targets
// well under this; this is a backstop so a caller bug can never push a
// multi-MB frame through to Anthropic (or toward Vercel's hard,
// non-configurable 4.5MB request-body cap — see
// api/jarvis-bridge-turn.js's own note on that limit).
const MAX_IMAGE_BASE64 = 2_000_000;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Treat the local-machine placeholder the same as truly missing — see
  // ANTHROPIC_KEY_USABLE in verify-video-quality.js for the matching guard
  // on the caller side. On a real Vercel deployment this is always a real
  // key, so this branch is not expected to fire there.
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === '[SENSITIVE]') {
    console.error('[verify-video-vision] ANTHROPIC_API_KEY not configured on this deployment');
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const body = req.body || {};
  const images = Array.isArray(body.images) ? body.images : null;
  const promptText = typeof body.promptText === 'string' ? body.promptText : '';

  if (!images || images.length === 0) {
    return res.status(400).json({ ok: false, error: 'images (non-empty array) is required' });
  }
  if (images.length > MAX_IMAGES) {
    return res.status(400).json({ ok: false, error: `too many images (${images.length}, max ${MAX_IMAGES})` });
  }
  if (!promptText.trim()) {
    return res.status(400).json({ ok: false, error: 'promptText is required' });
  }
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || typeof img.base64 !== 'string' || !img.base64) {
      return res.status(400).json({ ok: false, error: `images[${i}].base64 is required` });
    }
    if (!ALLOWED_MIME.has(img.mimeType)) {
      return res.status(400).json({ ok: false, error: `images[${i}].mimeType must be one of ${[...ALLOWED_MIME].join(', ')}` });
    }
    if (img.base64.length > MAX_IMAGE_BASE64) {
      return res.status(400).json({
        ok: false,
        error: `images[${i}] too large (${img.base64.length} base64 chars, max ${MAX_IMAGE_BASE64}) — refusing to forward to Anthropic`,
      });
    }
  }

  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
  }));
  content.push({ type: 'text', text: promptText });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: VISION_MODEL, max_tokens: 500, messages: [{ role: 'user', content }] }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      console.error(`[verify-video-vision] Anthropic call failed: ${anthropicRes.status} ${errText.slice(0, 300)}`);
      return res.status(502).json({ ok: false, error: `Anthropic call failed: ${anthropicRes.status}` });
    }

    const data = await anthropicRes.json();
    let result;
    try {
      result = extractVisionJson(data);
    } catch (parseErr) {
      console.error('[verify-video-vision] could not parse vision JSON:', parseErr.message);
      return res.status(502).json({ ok: false, error: `unparseable vision response: ${parseErr.message}` });
    }

    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('[verify-video-vision] unexpected error:', err && err.message);
    return res.status(502).json({ ok: false, error: (err && err.message) || 'unexpected error' });
  }
};
