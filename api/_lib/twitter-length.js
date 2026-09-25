//
// api/_lib/twitter-length.js
//
// Twitter's ACTUAL character count, and a clamp that uses it.
//
// THE FAILURE
// -----------
// Four consecutive Twitter deliveries failed, 2026-09-22, 09-24 (x2), 09-25,
// every one of them:
//
//   "Tweet text is too long (306 / 310 / 312 characters). Twitter's limit is 280."
//
// Nothing surfaced it. The rows still read `status='posted'` with a NULL
// zernio_post_id and a NULL actual_platform_url, so the dashboard showed four
// published tweets that do not exist.
//
// WHY THE EXISTING 280 CHECKS DID NOT CATCH IT
// --------------------------------------------
// There are two of them and both measure the wrong string:
//
//  1. api/cron-generate-posts.js validateAndFixCaption() clamps
//     `text.length <= CAPTION_LIMITS.twitter` at GENERATION time. The stored
//     rows are all 222-279 raw characters — every one of them passes.
//
//  2. api/cron-publish-approved.js splitForTwitter() checks
//     `text.length <= TWITTER_LIMIT` at SEND time.
//
// Between those two, buildPostBody() runs tagOutboundLinks() (api/_lib/
// content-tag.js), which rewrites
//
//     meetdossie.com/signup                                          21 chars
//
// into
//
//     meetdossie.com/signup?utm_source=twitter&utm_medium=social
//       &utm_campaign=dossie&utm_content=dossie-twitter-video-20260925-a1b2c3d4
//                                                                  ~120 chars
//
// — roughly +100 characters — and then appends the hashtag line. A 276-char
// caption becomes a ~376-char body. splitForTwitter() threads it, but its
// step 2 pushes a single sentence through unsplit when that sentence is
// already over the limit on its own (`if (cur) splitLong.push(cur); cur = s;`
// — `s` is never re-checked). The sentence carrying the fat tagged URL is
// exactly that sentence. It ships at 306+ and only ever produced a
// console.warn.
//
// So the generation-time clamp measured the caption BEFORE the publisher grew
// it, and the send-time check could not actually enforce its own limit.
//
// THE OTHER HALF: TWITTER DOES NOT COUNT CHARACTERS THE WAY .length DOES
// ----------------------------------------------------------------------
// Twitter counts a *weighted* length (twitter-text v3):
//
//   * every URL counts as exactly 23, however long or short it is —
//     t.co rewrites it. So the 120-char tagged link above is 23 to Twitter,
//     and a bare 21-char `meetdossie.com/signup` is 23 too, i.e. JS
//     `.length` UNDER-counts a short link by 2;
//   * Latin, punctuation and the common ranges weigh 1 per code point;
//     everything else (CJK, emoji) weighs 2.
//
// Counting raw `.length` is therefore wrong in both directions, and a clamp
// built on it either truncates copy that would have fit or lets through copy
// that will not.
//
// WHAT THIS MODULE IS FOR
// -----------------------
//   weightedLength(text)            Twitter's own count
//   clampForTwitter(text, opts)     trim to fit, on a word boundary, never
//                                   mid-URL, with room reserved for whatever
//                                   the publisher is going to append
//
// `reserve` is the load-bearing option. Generation-time callers pass the
// growth the publisher will add (link tagging + hashtag line) so the clamp is
// applied to the string that will actually be sent.

'use strict';

const TWITTER_LIMIT = 280;
const TRANSFORMED_URL_LENGTH = 23;

// twitter-text v3 configuration: code points inside these ranges weigh 1,
// everything else weighs 2.
const WEIGHT_1_RANGES = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

// Matches http(s) links AND the bare-domain form this codebase actually
// writes. api/_lib/content-tag.js's own header records that requiring a
// scheme "silently matched nothing on the vast majority of real captions" —
// cron-generate-posts.js's cta_rule emits "meetdossie.com/signup" with no
// scheme, and Twitter linkifies it exactly the same way.
const URL_RE = /\b(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|app|co|ai|dev|xyz|us)(?:\/[^\s<>"')\]]*)?/gi;

function codePointWeight(cp) {
  for (const [lo, hi] of WEIGHT_1_RANGES) {
    if (cp >= lo && cp <= hi) return 1;
  }
  return 2;
}

/** Every URL in `text`, as {start, end, raw} index spans. */
function findUrls(text) {
  const out = [];
  URL_RE.lastIndex = 0;
  let m = URL_RE.exec(text);
  while (m) {
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
    m = URL_RE.exec(text);
  }
  return out;
}

/**
 * weightedLength — what Twitter will say the tweet is.
 * URLs count 23 each; everything else by code-point weight.
 */
function weightedLength(text) {
  const s = String(text || '');
  const urls = findUrls(s);
  let total = 0;
  let i = 0;
  while (i < s.length) {
    const url = urls.find((u) => u.start === i);
    if (url) { total += TRANSFORMED_URL_LENGTH; i = url.end; continue; }
    const cp = s.codePointAt(i);
    total += codePointWeight(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return total;
}

/**
 * effectiveLength — the number that actually has to clear 280.
 *
 * TWO counters stand between a caption and a published tweet and they
 * disagree:
 *
 *   * Twitter counts WEIGHTED length — every URL is 23 because t.co rewrites
 *     it, CJK/emoji weigh 2. This is the count weightedLength() implements
 *     and the one Twitter's own docs describe.
 *
 *   * Zernio's pre-flight validator counts RAW characters. Its rejection
 *     string is literally "Tweet text is too long (306 characters). Twitter's
 *     limit is 280." — 306 is the raw length of a body whose 21-char CTA link
 *     had ~100 characters of UTM parameters bolted on by tagOutboundLinks().
 *     Under the weighted count that same body is comfortably inside 280,
 *     which is exactly why a weighted-only check would not have caught any of
 *     the four failures.
 *
 * A tweet has to clear BOTH. Taking the max is not belt-and-braces, it is the
 * only count that describes reality: whichever counter is stricter for this
 * particular string is the one that will reject it.
 */
function effectiveLength(text) {
  return Math.max(String(text || '').length, weightedLength(text));
}

/** Does this text fit, once `reserve` more characters are added? */
function fitsTwitter(text, { limit = TWITTER_LIMIT, reserve = 0 } = {}) {
  return effectiveLength(text) + reserve <= limit;
}

/**
 * clampForTwitter — trim to fit, preserving meaning as far as possible.
 *
 * Rules, in order:
 *   1. If it already fits, return it untouched. Never truncate a good tweet.
 *   2. Never cut inside a URL — a half URL is a dead link, which is worse
 *      than a missing one. A URL that cannot fit whole is removed whole.
 *   3. Cut on a word boundary and append the ellipsis only when something was
 *      actually removed.
 *
 * @param {string} text
 * @param {object} opts
 * @param {number} opts.limit     default 280
 * @param {number} opts.reserve   weighted characters the caller knows will be
 *                                APPENDED later (hashtag line, UTM growth).
 * @param {string} opts.ellipsis  default '...'
 * @returns {{text, changed, before, after, reserve}}
 */
function clampForTwitter(text, { limit = TWITTER_LIMIT, reserve = 0, ellipsis = '...', protectTrailingUrl = true } = {}) {
  const original = String(text || '');
  const before = effectiveLength(original);
  const budget = limit - reserve;

  if (before <= budget) return { text: original, changed: false, before, after: before, reserve };
  if (budget <= 0) return { text: '', changed: true, before, after: 0, reserve };

  // PROTECT THE CTA LINK.
  //
  // Every one of these captions ends with the call to action — "Solo pricing
  // is $149/month. meetdossie.com/signup". A naive right-trim cuts the link
  // off first, because it is last, and ships a post that asks for nothing.
  // That is a worse outcome than a shorter post: the link IS the post.
  //
  // So when a URL sits in the tail, hold it out, clamp the prose in front of
  // it to whatever budget remains, and re-attach it.
  if (protectTrailingUrl) {
    const allUrls = findUrls(original);
    const last = allUrls[allUrls.length - 1];
    // "In the tail" means nothing but whitespace and hashtags follows it.
    // "... meetdossie.com/signup #txrealestate #realtorlife #trec" is the
    // shape a good third of the real rows use, and a strict end-of-string
    // test misses every one of them.
    const afterUrl = last ? original.slice(last.end) : '';
    const tailIsLinkPlusTags = /^(?:\s|#\w+)*$/.test(afterUrl);
    if (last && tailIsLinkPlusTags && last.start > original.length * 0.4) {
      const tail = original.slice(last.start);
      const head = original.slice(0, last.start).replace(/\s+$/, '');
      const tailCost = effectiveLength(tail) + 1; // + the separating space
      if (budget - tailCost > 40) {
        const clampedHead = clampForTwitter(head, {
          limit: budget - tailCost, reserve: 0, ellipsis, protectTrailingUrl: false,
        });
        const joined = `${clampedHead.text} ${tail}`;
        return {
          text: joined, changed: true, before, after: effectiveLength(joined), reserve, keptTrailingUrl: true,
        };
      }
    }
  }

  const urls = findUrls(original);
  const ellipsisWeight = effectiveLength(ellipsis);
  const target = budget - ellipsisWeight;

  // Walk forward accumulating weight, recording the last safe cut point (a
  // whitespace boundary that is not inside a URL).
  let weighted = 0;
  let raw = 0;
  let i = 0;
  let lastSafe = 0;
  while (i < original.length) {
    const url = urls.find((u) => u.start === i);
    const step = url ? { w: TRANSFORMED_URL_LENGTH, n: url.end - i } : null;
    const cp = step ? null : original.codePointAt(i);
    const w = step ? step.w : codePointWeight(cp);
    const n = step ? step.n : (cp > 0xffff ? 2 : 1);

    // Both counters advance together; the cut point has to satisfy the
    // stricter of the two, which for a UTM-tagged link is the RAW one.
    if (Math.max(weighted + w, raw + n) > target) break;
    weighted += w;
    raw += n;
    i += n;
    // A boundary is safe when we are not mid-URL.
    if (!urls.some((u) => i > u.start && i < u.end)) {
      if (step || /\s/.test(original[i] || ' ')) lastSafe = i;
    }
  }

  let cut = lastSafe > 0 ? lastSafe : i;
  // Prefer the last whitespace so we do not sever a word.
  const ws = original.slice(0, cut).search(/\s+\S*$/);
  if (ws > budget * 0.5) cut = ws;

  const trimmed = `${original.slice(0, cut).replace(/\s+$/, '')}${ellipsis}`;
  return { text: trimmed, changed: true, before, after: effectiveLength(trimmed), reserve };
}

/**
 * assertTwitterFits — the loud send-time guard.
 *
 * Returns the offending chunks rather than throwing, so a caller can record a
 * real error on the row instead of a console.warn nobody reads. Silence is
 * what let four failures stack up unnoticed.
 */
function assertTwitterFits(chunks, { limit = TWITTER_LIMIT } = {}) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  const over = [];
  list.forEach((c, idx) => {
    const w = weightedLength(c);
    const raw = String(c).length;
    if (Math.max(w, raw) > limit) {
      over.push({
        index: idx, weighted: w, raw, effective: Math.max(w, raw),
        counter: raw >= w ? 'raw (Zernio pre-flight)' : 'weighted (Twitter)',
        preview: String(c).slice(0, 80),
      });
    }
  });
  return { ok: over.length === 0, over, limit };
}

module.exports = {
  TWITTER_LIMIT,
  TRANSFORMED_URL_LENGTH,
  weightedLength,
  effectiveLength,
  fitsTwitter,
  clampForTwitter,
  assertTwitterFits,
  findUrls,
};

/**
 * estimatePublisherGrowth — how many characters api/cron-publish-approved.js
 * will ADD to this caption between generation and send.
 *
 * This is what makes a generation-time clamp honest. The generator writes a
 * 264-character caption and calls it safe; buildPostBody() then grows it to
 * 372 by UTM-tagging the CTA link and appending the hashtag line, and Zernio
 * rejects it. Reserving that growth up front is the difference between
 * clamping the string that exists and clamping the string that ships.
 *
 * Two contributions, both built from the real template rather than a round
 * number:
 *
 *  1. The UTM suffix per outbound link to `domain`, exactly as
 *     api/_lib/content-tag.js tagOutboundLinks() writes it. The content tag
 *     is `brand.platform.format.<shortid>.<YYYYMMDD>`, shortid <= 12 chars.
 *
 *  2. The hashtag line, which buildPostBody() appends only when the caption
 *     carries no inline hashtag of its own (its own test: /\B#\w/).
 *
 * @returns {number} characters to reserve
 */
function estimatePublisherGrowth(text, {
  domain = 'meetdossie.com', platform = 'twitter', brand = 'dossie',
  format = 'video', hashtags = [],
} = {}) {
  const s = String(text || '');
  let growth = 0;

  const tag = `${brand}.${platform}.${format}.${'x'.repeat(8)}.${'0'.repeat(8)}`;
  const suffix = `?utm_source=${encodeURIComponent(platform)}&utm_medium=social`
    + `&utm_campaign=${encodeURIComponent(brand)}&utm_content=${encodeURIComponent(tag)}`;

  for (const u of findUrls(s)) {
    if (!u.raw.toLowerCase().includes(String(domain).toLowerCase())) continue;
    if (/[?&]utm_source=/i.test(u.raw)) continue; // already tagged — idempotent
    growth += suffix.length;
  }

  const hasInlineHashtag = /\B#\w/.test(s);
  if (!hasInlineHashtag && Array.isArray(hashtags) && hashtags.length) {
    growth += 2 + hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ').length;
  }

  return growth;
}

module.exports.estimatePublisherGrowth = estimatePublisherGrowth;
