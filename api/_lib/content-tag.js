'use strict';

// api/_lib/content-tag.js
//
// Shared content-attribution tag scheme, used at PUBLISH time (not draft/
// generation time) so the tag always reflects the real platform, format,
// content row, and the date it actually went out.
//
// Heath, 2026-09-17: "which post produced a signup" was impossible to answer
// — no link carried an id back to the row that generated it. This closes
// that gap for the social_posts publish path (cron-publish-approved.js),
// covering both target_owner='dossie' and target_owner='heath-realtor' rows
// (same table, same pipeline — brand is just a column).
//
// TAG SHAPE — one string, decodable without a DB lookup:
//   <brand>.<platform>.<format>.<shortId>.<YYYYMMDD>
//   e.g. "dossie.facebook.video.a1b2c3d4.20260917"
//
// shortId is the first 8 alnum chars of the row's real uuid (social_posts.id)
// — enough to disambiguate within a single day for a given brand+platform+
// format without bloating caption text. The full row is always recoverable:
//   select * from social_posts where id::text like '<shortId>%';
//
// This tag is carried as the utm_content value on any outbound link. Some
// platforms strip caption links entirely (see PLATFORMS_WITHOUT_CAPTION_LINKS
// below) — this file documents that constraint; callers must not pretend a
// clickable link exists where the platform doesn't allow one.
//
// KNOWN PLATFORM CONSTRAINTS (verified platform behavior, not a guess):
//   - Instagram: caption text is NEVER clickable. The only tappable link is
//     the single bio link. Per-post attribution via a caption URL is
//     structurally impossible without a link-in-bio rotator (not in this
//     stack). Fallback: content_tag is still recorded on the row (so a
//     future bio-link tool could rotate to "today's post"), but clicks for
//     Instagram will always read 0/untracked for a specific post — that is
//     the platform, not "no interest." An evergreen bio link, if ever
//     tagged, should carry utm_content='bio_link' (platform-level only).
//   - TikTok: same constraint — caption text is not clickable. Same fallback.
//   - Facebook / Twitter(X) / LinkedIn: plain URLs in post/comment text are
//     auto-linkified and the destination's query string (including
//     utm_content) survives the click. Tagging works.
//   - YouTube: the description field supports a real clickable link. Tagging
//     works.
//
// Owner: Carter, 2026-09-17

const NON_ALNUM_RE = /[^a-z0-9]/g;

function slug(value, fallback) {
  const s = String(value == null ? '' : value).toLowerCase().replace(NON_ALNUM_RE, '');
  return s || fallback;
}

function shortId(id) {
  const s = String(id == null ? '' : id).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return s.slice(0, 8) || 'unk';
}

function dateStamp(when) {
  const d = when ? new Date(when) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Platforms where a caption/comment link can never be tapped — documented
// above. Exported so callers (and the attribution report) can label clicks
// as a platform constraint instead of a performance signal.
const PLATFORMS_WITHOUT_CAPTION_LINKS = ['instagram', 'tiktok'];

function buildContentTag({ brand, platform, format, contentId, postedAt } = {}) {
  const b = slug(brand, 'unk');
  const p = slug(platform, 'unk');
  const f = slug(format, 'post');
  const id = shortId(contentId);
  const d = dateStamp(postedAt);
  return `${b}.${p}.${f}.${id}.${d}`;
}

const TAG_RE = /^([a-z0-9]+)\.([a-z0-9]+)\.([a-z0-9]+)\.([a-z0-9]{1,12})\.(\d{8})$/;

// Returns null for anything that isn't a real tag this scheme produced —
// callers must treat that as "unattributed", never guess at a shape.
function parseContentTag(tag) {
  const m = TAG_RE.exec(String(tag == null ? '' : tag).trim().toLowerCase());
  if (!m) return null;
  const [, brand, platform, format, shortContentId, dateCompact] = m;
  const postedDate = `${dateCompact.slice(0, 4)}-${dateCompact.slice(4, 6)}-${dateCompact.slice(6, 8)}`;
  return { brand, platform, format, shortContentId, postedDate };
}

// Stamps every outbound link to `domain` found in `text` with utm_source/
// utm_medium/utm_campaign/utm_content — idempotent (won't double-stamp a
// link that already carries utm_source). Matches the bare domain with or
// without a scheme/www, since generated captions routinely write
// "meetdossie.com/signup" with no "https://" prefix (the LLM writes it that
// way in cron-generate-posts.js's cta_rule fields) — a scheme-only regex
// silently tags nothing on those rows.
//
// Always returns the computed tag (even if no link was found in the text)
// so the caller can still persist content_tag on the row for record-keeping
// — see PLATFORMS_WITHOUT_CAPTION_LINKS above for why that matters on IG/TikTok.
function tagOutboundLinks(text, { domain, brand, platform, format, contentId, postedAt } = {}) {
  const tag = buildContentTag({ brand, platform, format, contentId, postedAt });
  if (!text || !domain) return { text, tag, linked: false };

  const escapedDomain = String(domain).replace(/\./g, '\\.');
  const re = new RegExp(`((?:https?:\\/\\/)?(?:www\\.)?${escapedDomain}(?:/[^\\s)<>\\]"']*)?)`, 'gi');

  let linked = false;
  const out = text.replace(re, (match) => {
    if (/[?&]utm_source=/i.test(match)) return match; // already tagged — idempotent
    linked = true;
    const sep = match.includes('?') ? '&' : '?';
    return `${match}${sep}utm_source=${encodeURIComponent(platform || 'unknown')}` +
      `&utm_medium=social&utm_campaign=${encodeURIComponent(brand || 'unknown')}` +
      `&utm_content=${encodeURIComponent(tag)}`;
  });

  return { text: out, tag, linked };
}

module.exports = {
  buildContentTag,
  parseContentTag,
  tagOutboundLinks,
  PLATFORMS_WITHOUT_CAPTION_LINKS,
  TAG_RE,
};
