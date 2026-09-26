'use strict';

// api/_lib/video-caption.js
//
// Extracted from api/register-video.js (Atlas 2026-09-25) so the CLI
// registration path (scripts/register-local-video.js) and the browser
// upload path (api/register-video.js) share ONE caption generator instead
// of a second copy drifting out of sync. Behavior is byte-for-byte the same
// as the original inline function.

/**
 * @param {string} stem  the video's id/topic slug
 * @param {object} [opts]
 * @param {string} [opts.anthropicApiKey]  defaults to process.env.ANTHROPIC_API_KEY
 * @param {(...args:any[])=>void} [opts.log]   defaults to console.log
 * @param {(...args:any[])=>void} [opts.warn]  defaults to console.warn
 * @returns {Promise<string>}
 */
async function generateCaption(stem, opts = {}) {
  const ANTHROPIC_API_KEY = opts.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
  const log = opts.log || console.log;
  const warn = opts.warn || console.warn;
  const fallback = 'Your transactions, handled. meetdossie.com/signup';

  if (!ANTHROPIC_API_KEY) {
    log('[video-caption] No ANTHROPIC_API_KEY — using fallback caption');
    return fallback;
  }

  const prompt =
    `Generate a 1-2 sentence social media caption for a Dossie video. ` +
    `Topic: ${stem}. ` +
    `Brand: warm AI transaction coordinator for Texas real estate agents. ` +
    `End with: meetdossie.com/signup. Max 150 chars. Plain ASCII only.`;

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
      warn('[video-caption] Anthropic error', resp.status, '— using fallback');
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
      const url = 'meetdossie.com/signup';
      if (!caption.includes(url)) {
        caption = caption.slice(0, 120) + '... ' + url;
      } else {
        caption = caption.slice(0, 150);
      }
    }

    log(`[video-caption] Caption (${caption.length} chars): ${caption}`);
    return caption;
  } catch (err) {
    warn('[video-caption] Caption generation threw:', err && err.message, '— using fallback');
    return fallback;
  }
}

module.exports = { generateCaption };
