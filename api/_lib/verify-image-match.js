// api/_lib/verify-image-match.js
//
// Vision-based claim-match gate for social_posts approval cards.
//
// Built 2026-08-18 after a Facebook post announcing the new team dashboard
// went out for Telegram approval with a screenshot of the regular
// single-agent Pipeline view attached instead of the actual team dashboard
// (social_posts.id=5763465d-1cf9-4ac3-9f74-3c2e9cf2061b). Nobody checked
// whether the image matched the copy before the card was sent. This closes
// that gap for good: before ANY social_posts row with a media_url goes out
// for Telegram approval — cron or one-off/manual send — a real vision-model
// call has to confirm the image genuinely depicts what the caption claims.
//
// Shared by every send path. Do not duplicate this logic inline elsewhere —
// import gateBeforeApprovalSend() and call it right before the photo/video
// send. Known call sites:
//   - api/cron-send-for-approval.js  (the scheduled pipeline)
//   - api/telegram-webhook.js        (sendReplacementToTelegram — regen path)
//   - any future one-off/manual resend script (e.g. scripts/sage-resend-*.js)
//
// On mismatch: the post is flipped to status='image_mismatch_hold' (NOT
// posted for approval), and a plain Telegram message — not an approval
// card — is sent to Heath explaining what's wrong. Caller must treat a
// `false` return from gateBeforeApprovalSend() as "stop, do not send".

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Vision-capable model — same model jarvis-voice.js uses for image attachments.
const VISION_MODEL = 'claude-sonnet-5';

const HOLD_STATUS = 'image_mismatch_hold';

function mimeFromUrl(url) {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.gif')) return 'image/gif';
  if (u.endsWith('.webp')) return 'image/webp';
  return null; // video or unrecognized — this gate only checks still images
}

async function fetchImageBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

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

async function telegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[verify-image-match] cannot alert Heath — TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('[verify-image-match] telegram alert send failed:', err && err.message);
  }
}

/**
 * Asks a vision-capable Claude model whether an image genuinely depicts what
 * a caption specifically claims — not a generic "is this on-brand" check.
 *
 * Returns:
 *   { checked: false, match: null }                      — skipped (no image, video, no API key, API error — fail-open)
 *   { checked: true,  match: false, reason, claim, seen } — could not fetch image at all — fail-closed (bad URL is itself worth holding)
 *   { checked: true,  match: true|false, reason, claim, seen, raw } — real vision verdict
 */
async function checkImageMatchesClaim({ mediaUrl, caption }) {
  if (!mediaUrl || !caption) return { checked: false, match: null, reason: null };
  const mimeType = mimeFromUrl(mediaUrl);
  if (!mimeType) return { checked: false, match: null, reason: null }; // video — not this gate's job

  if (!ANTHROPIC_API_KEY) {
    console.warn('[verify-image-match] ANTHROPIC_API_KEY not set — skipping gate (fail-open)');
    return { checked: false, match: null, reason: null };
  }

  let imageB64;
  try {
    imageB64 = await fetchImageBase64(mediaUrl);
  } catch (err) {
    console.error('[verify-image-match] could not fetch image, holding:', err && err.message);
    return {
      checked: true,
      match: false,
      reason: `Could not fetch the image at all (${err && err.message}) — holding rather than sending an approval card with a broken/unverifiable image.`,
      claim: '(unverifiable — fetch failed)',
      seen: '(unverifiable — fetch failed)',
    };
  }

  const prompt = `You are a strict fact-checker for a social media approval queue. A caption is about to be posted alongside an image. Your ONLY job: does the image ACTUALLY show what the caption specifically claims it shows?

Do not just judge whether the image is generally on-topic or on-brand. If the caption makes a specific claim about what's depicted (a named feature, screen, dashboard, document, scene, etc.), check whether the image genuinely depicts THAT SPECIFIC THING — not something adjacent, an older/different version of the product, or an unrelated screen.

Caption:
"""
${caption}
"""

Respond with JSON only, no other text, no markdown fences:
{"match": true or false, "claim": "the specific visual claim you checked against", "seen": "what the image actually shows", "reason": "one sentence explaining the verdict"}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageB64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[verify-image-match] Anthropic call failed, fail-open:', res.status, errText.slice(0, 300));
      return { checked: false, match: null, reason: null };
    }

    const data = await res.json();
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[verify-image-match] no JSON in vision response, fail-open:', text.slice(0, 200));
      return { checked: false, match: null, reason: null };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      checked: true,
      match: parsed.match === true,
      reason: String(parsed.reason || '').slice(0, 300),
      claim: String(parsed.claim || '').slice(0, 200),
      seen: String(parsed.seen || '').slice(0, 200),
      raw: parsed,
    };
  } catch (err) {
    console.error('[verify-image-match] vision check threw, fail-open:', err && err.message);
    return { checked: false, match: null, reason: null };
  }
}

/**
 * Full gate — call this immediately before sending the approval-card photo
 * message for a social_posts row.
 *
 * On genuine match (or when the check is skipped/fails-open): returns true,
 * caller proceeds exactly as before, no added friction.
 *
 * On genuine mismatch: flips the row to status='image_mismatch_hold',
 * pushes a plain (non-approval-card) Telegram alert to Heath explaining the
 * mismatch, and returns false. Caller MUST NOT send the approval card.
 *
 * @param {object} post - social_posts row (needs at least id, media_url, content/hook, platform, topic)
 * @returns {Promise<boolean>} true = proceed with send, false = held, do not send
 */
async function gateBeforeApprovalSend(post) {
  if (!post || !post.id) return true;
  const mediaUrl = post.media_url;
  const caption = String(post.content || post.hook || '');
  if (!mediaUrl || !caption) return true;

  const result = await checkImageMatchesClaim({ mediaUrl, caption });
  if (!result.checked) return true; // video / no key / API failure — fail-open, unchanged behavior

  if (result.match) {
    console.log(`[verify-image-match] MATCH ${post.id}: claim="${result.claim}" — ${result.reason}`);
    return true;
  }

  console.warn(`[verify-image-match] MISMATCH ${post.id}: claim="${result.claim}" seen="${result.seen}" — ${result.reason}`);

  await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: HOLD_STATUS,
      rejection_reason: `Image/copy mismatch (auto-held): ${result.reason}`,
    }),
  }).catch((err) => console.error('[verify-image-match] hold patch failed:', err && err.message));

  const alertText = [
    `held: ${post.id} — image/copy mismatch, NOT sent for approval`,
    '',
    `platform: ${post.platform || 'unknown'}   topic: ${post.topic || 'unknown'}`,
    '',
    `copy says: ${result.claim}`,
    `image shows: ${result.seen}`,
    '',
    result.reason,
    '',
    `media_url: ${mediaUrl}`,
    '',
    `Row status set to '${HOLD_STATUS}' — will not retry into the normal send queue. Fix media_url (or the copy) and re-run the send to re-check.`,
  ].join('\n');
  await telegramAlert(alertText);

  return false;
}

module.exports = {
  checkImageMatchesClaim,
  gateBeforeApprovalSend,
  HOLD_STATUS,
  VISION_MODEL,
};
