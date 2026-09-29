// api/_lib/vision-parse.js
//
// Shared JSON-extraction logic for Anthropic vision-check responses. Used by
// BOTH api/_lib/verify-video-quality.js (direct-call path, when a real
// ANTHROPIC_API_KEY is present in this environment) and
// api/verify-video-vision.js (the CRON_SECRET-gated proxy route
// verify-video-quality.js POSTs sampled frames to when it is not). Kept in
// exactly one place so the two transports can never silently diverge on
// what counts as a parseable verdict — a divergence there would be
// invisible until one path passed a video the other would have held.

'use strict';

function extractVisionJson(anthropicResponseData) {
  const text = ((anthropicResponseData && anthropicResponseData.content) || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`no JSON in vision response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

module.exports = { extractVisionJson };
