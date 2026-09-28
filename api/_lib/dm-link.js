'use strict';

// api/_lib/dm-link.js
//
// Closes the gap the 30-day plan surfaced (Heath, 2026-09-17): group
// comments deliberately never mention Dossie or carry a link
// (heath-group-comment-voice.md — zero pitch, zero link, ever). The
// conversation that actually converts is the one that later moves to a 1:1
// DM — and today, whatever link goes out there is a bare, untagged URL.
// api/_lib/attribution.js can already answer "which PUBLISHED post produced
// a signup" via content_tag; it could see NOTHING from this channel.
//
// This reuses the EXACT SAME tag scheme as a published post
// (api/_lib/content-tag.js buildContentTag()/parseContentTag()) with
// format='dm' and contentId = the conversation's own row id — so a DM link
// decodes exactly like a post link, and any future attribution work that
// joins on content_tag picks these up for free with zero special-casing.
//
// SOURCE TABLES (the places a 1:1 DM conversation lives, each with its own
// dm_link_tag column):
//   - tc_discovery_responses  (TC-discovery campaign comment threads) —
//     supabase/migrations/20260917d_ops_policy.sql
//   - comment_opportunities   (daily comment-opportunity engagement) —
//     supabase/migrations/20260917d_ops_policy.sql
//   - comment_dm_leads        (comment-to-DM keyword leads, touch 2/3 offer
//     link — Carter, 2026-09-28) —
//     supabase/migrations/20260928_comment_dm_followup_sequence.sql
//
// IDEMPOTENT BY DESIGN: getOrCreateDmLink() checks the row's dm_link_tag
// first. If already set, it returns the EXISTING tag/link — tapping "DM
// link" twice on the same conversation must never mint a second tag (that
// would silently fragment one conversation's attribution across two ids).
//
// Owner: Carter, 2026-09-17

const { buildContentTag, parseContentTag } = require('./content-tag.js');

const SOURCE_TABLES = {
  tc_discovery_responses: { platformDefault: 'facebook' },
  comment_opportunities: { platformDefault: 'facebook' },
  // Comment-to-DM leads are Instagram/Facebook only (video_comment_automations
  // .platform check) — caller always passes the lead's real platform anyway,
  // this is just the fallback.
  comment_dm_leads: { platformDefault: 'instagram' },
};

const DEFAULT_BASE_URL = 'https://meetdossie.com';

function assertKnownSource(sourceTable) {
  if (!Object.prototype.hasOwnProperty.call(SOURCE_TABLES, sourceTable)) {
    throw new Error(`dm-link: unknown sourceTable '${sourceTable}' — must be one of ${Object.keys(SOURCE_TABLES).join(', ')}`);
  }
}

/**
 * Build the tagged link WITHOUT touching the DB — pure, used by tests and
 * by getOrCreateDmLink() below.
 *
 * @returns {{ tag: string, url: string }}
 */
function buildDmLink({ sourceTable, sourceId, platform, brand = 'dossie', baseUrl = DEFAULT_BASE_URL, postedAt } = {}) {
  assertKnownSource(sourceTable);
  const effectivePlatform = platform || SOURCE_TABLES[sourceTable].platformDefault;
  const tag = buildContentTag({ brand, platform: effectivePlatform, format: 'dm', contentId: sourceId, postedAt });
  const sep = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${sep}utm_source=${encodeURIComponent(effectivePlatform)}` +
    `&utm_medium=dm&utm_campaign=${encodeURIComponent(brand)}&utm_content=${encodeURIComponent(tag)}`;
  return { tag, url };
}

/**
 * Idempotent get-or-create: reads the row's dm_link_tag first; if present,
 * rebuilds the URL from the STORED tag (never mints a new one). If absent,
 * builds a fresh tag/link and PATCHes it onto the row.
 *
 * @param {object} opts { sourceTable, sourceId, platform, brand, baseUrl, sbFetch }
 * @returns {Promise<{ ok:boolean, tag:string, url:string, created:boolean, error?:string }>}
 */
async function getOrCreateDmLink({ sourceTable, sourceId, platform, brand = 'dossie', baseUrl = DEFAULT_BASE_URL, sbFetch } = {}) {
  assertKnownSource(sourceTable);
  if (!sbFetch) throw new Error('dm-link: getOrCreateDmLink requires an sbFetch');
  if (!sourceId) return { ok: false, tag: null, url: null, created: false, error: 'sourceId required' };

  const existing = await sbFetch(
    `/rest/v1/${sourceTable}?id=eq.${encodeURIComponent(sourceId)}&select=id,dm_link_tag&limit=1`,
  );
  if (!existing.ok) {
    return { ok: false, tag: null, url: null, created: false, error: `lookup failed (status ${existing.status})` };
  }
  const row = Array.isArray(existing.data) && existing.data[0] ? existing.data[0] : null;
  if (!row) {
    return { ok: false, tag: null, url: null, created: false, error: 'row not found' };
  }

  if (row.dm_link_tag) {
    const decoded = parseContentTag(row.dm_link_tag);
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}utm_source=${encodeURIComponent(decoded ? decoded.platform : (platform || SOURCE_TABLES[sourceTable].platformDefault))}` +
      `&utm_medium=dm&utm_campaign=${encodeURIComponent(brand)}&utm_content=${encodeURIComponent(row.dm_link_tag)}`;
    return { ok: true, tag: row.dm_link_tag, url, created: false };
  }

  const { tag, url } = buildDmLink({ sourceTable, sourceId, platform, brand, baseUrl });
  const patch = await sbFetch(`/rest/v1/${sourceTable}?id=eq.${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ dm_link_tag: tag }),
  });
  if (!patch.ok) {
    // Still hand back a usable link even if the cache-write failed — a
    // re-tap will just mint a fresh (still-decodable) tag rather than fail
    // outright. Not ideal, but never a dead end for Heath.
    return { ok: true, tag, url, created: true, error: `dm_link_tag write failed (status ${patch.status}) — not cached` };
  }
  return { ok: true, tag, url, created: true };
}

module.exports = {
  SOURCE_TABLES,
  DEFAULT_BASE_URL,
  buildDmLink,
  getOrCreateDmLink,
};
