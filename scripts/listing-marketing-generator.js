'use strict';

// scripts/listing-marketing-generator.js
//
// Daily generator for Heath's own active-listing marketing rotation
// (Fawndale / Nopalito / Senisa). Produces AT MOST:
//   - ONE Tier-1 owned-channel post (facebook.com/HeathShepardRealtor +
//     @heathshepardrealtor) -- inserted as a social_posts row,
//     target_owner='heath-realtor', status='draft'. Rides the EXISTING
//     cron-send-for-approval -> Telegram approve/reject -> cron-publish-
//     approved -> Zernio pipeline untouched -- no new approval code needed.
//   - ONE Tier-2 FB-group post -- inserted as a group_posts row,
//     pipeline='listing-groups', status='draft', THEN notified to Heath via
//     its own Telegram message (lst_approve/lst_edit/lst_skip buttons --
//     api/listing-group-post-callback.js + the wiring in
//     api/telegram-webhook.js). Actual posting happens via
//     scripts/fb-listing-group-post-queue.js on a local scheduler tick,
//     mirroring scripts/fb-group5-post-queue.js exactly.
//
// Rotation logic (deterministic, auditable -- NOT AI-freeform invention):
//   Tier 1: among active, non-paused listings, pick the one whose
//   listing_marketing_rotation(tier='owned') row has the OLDEST
//   last_posted_at (nulls first = never posted). Pick the next angle not
//   in its last min(3, len(ANGLES)-1) angle_history entries.
//   Tier 2: among (listing, venue) pairs valid per listing.groupVenues,
//   same oldest-last-posted-first rule, across ALL pairs (so both listing
//   AND venue vary day to day) -- this is the actual "different listing,
//   different venue every day" rotation the task calls for.
//
// Copy is template-based against the verified fact pack in
// scripts/_lib/listing-marketing-facts.js -- never freeform AI invention of
// facts. Every generated body is checked by
// scripts/_lib/listing-post-compliance-gate.js before insert.
//
// STAGING ONLY as of 2026-09-10 -- inserts drafts, never auto-approves.
// Heath approves the first cycle before this runs live/on a schedule.
//
// Usage:
//   node scripts/listing-marketing-generator.js               # run for real
//   node scripts/listing-marketing-generator.js --dry-run      # print, no DB writes
//
// Owner: Carter, 2026-09-10

const path = require('path');
const fs = require('fs');
const { LISTINGS, GROUP_VENUES, ANGLES, TREC_ATTRIBUTION, OWNER_DISCLOSURE } = require('./_lib/listing-marketing-facts');
const { checkListingPostCompliance, MAX_STATUS_AGE_MINUTES } = require('./_lib/listing-post-compliance-gate');

try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch (e) { /* non-fatal */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DRY_RUN = process.argv.includes('--dry-run');
const STORAGE_BASE = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public` : null;

async function sbFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// ─── Copy templates ─────────────────────────────────────────────────────────
// Deterministic, fact-pack-driven. Each returns { body, imageLabel }.

function moneyFmt(n) {
  return '$' + Number(n).toLocaleString('en-US');
}

function pickImage(listing, preferredLabel) {
  const imgs = (listing.photos && listing.photos.images) || [];
  if (!imgs.length) return null;
  const byLabel = imgs.find((i) => i.label === preferredLabel);
  return byLabel || imgs[0];
}

// 2026-09-11 (Carter, urgent fix): media_url was landing null on every
// queued listing row even though real cards and video existed on Heath's
// Desktop -- nothing in this pipeline ever pointed at them. Purpose-built
// marketing video (see listing.videos in listing-marketing-facts.js) is now
// preferred over a plain MLS photo wherever available, matching Heath's
// standing "video only" rule. Falls back to the still-photo path only when
// no video asset is on file for that listing yet (e.g. Senisa).
function pickMedia(listing, preferredImageLabel) {
  if (!STORAGE_BASE) return { url: null, isVideo: false, image: null };
  if (listing.videos && listing.videos.vertical) {
    return {
      url: `${STORAGE_BASE}/${listing.videos.bucket}/${listing.videos.vertical}`,
      isVideo: true,
      image: pickImage(listing, preferredImageLabel), // still returned for staged-label/compliance checks
    };
  }
  const image = pickImage(listing, preferredImageLabel);
  return {
    url: image ? `${STORAGE_BASE}/${listing.photos.bucket}/${image.file}` : null,
    isVideo: false,
    image,
  };
}

// Instagram cannot post text-only content via the API at all -- a queued IG
// row with no media_url is a guaranteed-fail dead row (2026-09-11 bug: three
// listings' worth of IG rows sat in the approval queue with "no media yet"
// and would have failed outright the moment Heath tapped Approve). Call
// this immediately before any social_posts insert; it refuses (returns
// false, logs why) rather than letting a doomed row reach Telegram at all.
function refuseIfInstagramWithoutMedia(platform, mediaUrl, context) {
  if (String(platform).toLowerCase() === 'instagram' && !mediaUrl) {
    console.error(`[listing-gen] REFUSING to queue an Instagram post with no media (${context}) -- Instagram cannot post text-only via the API, this would be a guaranteed-fail dead row.`);
    return true;
  }
  return false;
}

function ownerLine(listing) {
  return listing.isAgentOwned ? `\n\n${OWNER_DISCLOSURE}` : '';
}

function stagedLine(image) {
  return image && image.staged ? '\n\n(Photo shown is virtually staged to show scale/layout - furniture shown is not included.)' : '';
}

function attributionLine() {
  return `\n\n${TREC_ATTRIBUTION}`;
}

const OWNED_TEMPLATES = {
  room_feature: (l, price, img) =>
    `A closer look at ${l.address} - ${(img && img.label || 'this space').replace(/_/g, ' ')}. `
    + `${l.features[0]}. ${moneyFmt(price)}, ${l.sqft.toLocaleString()} sqft`
    + (l.beds ? `, ${l.beds} bed` : '') + (l.baths ? `/${l.baths} bath` : '') + `.`,
  price_value: (l, price, img) =>
    `${l.address}, listed at ${moneyFmt(price)}` + (l.priceCompSqft
      ? ` ($${Math.round(price / l.sqft)}/sqft - original-condition homes nearby have traded closer to $${l.priceCompSqft}/sqft, and this one's fully renovated).`
      : ` - ${l.sqft.toLocaleString()} sqft in ${l.subdivision}.`),
  neighborhood_lifestyle: (l, price, img) =>
    `${l.subdivision} - ${l.city}, TX. ${l.features[Math.min(1, l.features.length - 1)]}. `
    + `${l.address}, ${moneyFmt(price)}.`,
  buyer_fit: (l, price, img) =>
    `${l.address} could be a strong fit if you're looking in ${l.city} under ${moneyFmt(Math.ceil(price / 50000) * 50000)}: `
    + `${l.features[Math.min(2, l.features.length - 1)]}.`,
  agent_to_agent: (l, price, img) =>
    `Active listing, ${l.address}, ${l.city} - ${moneyFmt(price)}, ${l.sqft.toLocaleString()} sqft. `
    + `${l.features[0]} Happy to work with buyer's agents on showings - reach out directly.`,
  showing_availability: (l, price, img) =>
    `${l.address} is showing now. ${l.conditionCaveat ? 'Contact me directly to confirm current showing status before scheduling. ' : ''}`
    + `${moneyFmt(price)}, ${l.sqft.toLocaleString()} sqft, ${l.subdivision}.`,
};

function buildMilestoneLine(listing, status) {
  if (status.list_price != null && status.last_notified_price != null
    && Number(status.list_price) !== Number(status.last_notified_price)) {
    const dir = Number(status.list_price) < Number(status.last_notified_price) ? 'down' : 'up';
    return `Price update on ${listing.address}: now ${moneyFmt(status.list_price)} (${dir} from ${moneyFmt(status.last_notified_price)}).`;
  }
  return null;
}

function buildOwnedPost(listing, status, angle) {
  const price = status.list_price;
  const milestoneLine = angle === 'milestone' ? buildMilestoneLine(listing, status) : null;
  const img = pickImage(listing, angle === 'room_feature' ? 'kitchen' : null);
  let body;
  if (milestoneLine) {
    body = milestoneLine;
  } else if (OWNED_TEMPLATES[angle]) {
    body = OWNED_TEMPLATES[angle](listing, price, img);
  } else {
    body = OWNED_TEMPLATES.price_value(listing, price, img);
  }
  body += (listing.conditionCaveat && /kitchen|bath|move.?in/i.test(body) ? '' : '');
  body += ownerLine(listing);
  body += stagedLine(img);
  body += attributionLine();
  return { body: body.trim(), image: img, hasMilestone: !!milestoneLine };
}

const GROUP_TEMPLATES = {
  agent_to_agent: (l, price) =>
    `${l.address}, ${l.city} TX - active, ${moneyFmt(price)}, ${l.sqft.toLocaleString()} sqft, ${l.subdivision}. `
    + `${l.features[0]} Working with buyer's agents on this one - reach out for showing access or questions.`,
  buyer_fit: (l, price) =>
    `Got a buyer looking in ${l.city} around ${moneyFmt(price)}? ${l.address} might be worth a look: ${l.features[Math.min(1, l.features.length - 1)]}`,
  price_value: (l, price) =>
    `${l.address} - ${moneyFmt(price)}, ${l.sqft.toLocaleString()} sqft.` + (l.priceCompSqft
      ? ` Priced around $${Math.round(price / l.sqft)}/sqft against a nearby original-condition comp tier of $${l.priceCompSqft}/sqft.` : ''),
  room_feature: (l, price) => `${l.address} - ${l.features[0]} ${moneyFmt(price)}, ${l.subdivision}.`,
};

function buildGroupPost(listing, status, angle, venue) {
  const price = status.list_price;
  const fn = GROUP_TEMPLATES[angle] || GROUP_TEMPLATES.agent_to_agent;
  let body = fn(listing, price);
  body += ownerLine(listing);
  body += attributionLine();
  return body.trim();
}

// ─── Rotation selection ─────────────────────────────────────────────────────

// Root cause of the 2026-09-10 23 Nopalito incident: this function used to
// hand back ANY row with is_active=true regardless of how old
// last_verified_at was, so a real MLS price change that happened after the
// last sync silently rode along as fact. Never trust a snapshot past
// MAX_STATUS_AGE_MINUTES old -- refuse (skip) that listing entirely rather
// than draft off it. This is belt-and-suspenders alongside the same check
// in listing-post-compliance-gate.js; both must independently refuse.
async function loadActiveListings() {
  const { ok, data } = await sbFetch(`/rest/v1/listing_marketing_status?is_active=eq.true&is_paused=eq.false`);
  if (!ok || !Array.isArray(data)) return [];
  const tracked = data.filter((row) => LISTINGS[row.mls_number]); // only tracked listings
  const fresh = [];
  for (const row of tracked) {
    const ageMinutes = row.last_verified_at
      ? (Date.now() - new Date(row.last_verified_at).getTime()) / 60000
      : Infinity;
    if (!Number.isFinite(ageMinutes) || ageMinutes > MAX_STATUS_AGE_MINUTES) {
      console.error(`[listing-gen] REFUSING ${row.mls_number} (${row.address || 'unknown address'}) -- listing_marketing_status is ${Number.isFinite(ageMinutes) ? Math.round(ageMinutes) + 'min' : 'never'} old (max ${MAX_STATUS_AGE_MINUTES}min). Run status-sync immediately before generating -- prefer scripts/listing-marketing-generate-live.js, which does both in one process with zero gap.`);
      continue;
    }
    fresh.push(row);
  }
  return fresh;
}

async function loadRotation(mlsNumbers, tier) {
  if (!mlsNumbers.length) return {};
  const { ok, data } = await sbFetch(
    `/rest/v1/listing_marketing_rotation?tier=eq.${tier}&mls_number=in.(${mlsNumbers.join(',')})`,
  );
  const out = {};
  if (ok && Array.isArray(data)) {
    for (const row of data) out[row.mls_number] = row;
  }
  return out;
}

function nextAngle(history, deck) {
  const recent = (history || []).slice(-Math.min(3, deck.length - 1));
  const candidates = deck.filter((a) => !recent.includes(a));
  return (candidates.length ? candidates : deck)[0];
}

async function upsertRotation(mlsNumber, tier, angle, venue) {
  const { ok, data } = await sbFetch(
    `/rest/v1/listing_marketing_rotation?mls_number=eq.${mlsNumber}&tier=eq.${tier}`,
  );
  const existing = ok && Array.isArray(data) && data[0];
  const angleHistory = ((existing && existing.angle_history) || []).concat([angle]).slice(-6);
  const venueHistory = venue ? ((existing && existing.venue_history) || []).concat([venue]).slice(-6) : (existing && existing.venue_history) || [];
  const row = {
    mls_number: mlsNumber,
    tier,
    last_angle: angle,
    last_venue: venue || (existing && existing.last_venue) || null,
    last_posted_at: new Date().toISOString(),
    angle_history: angleHistory,
    venue_history: venueHistory,
    updated_at: new Date().toISOString(),
  };
  if (DRY_RUN) return;
  await sbFetch(`/rest/v1/listing_marketing_rotation?on_conflict=mls_number,tier`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

async function telegramSend(text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: 'telegram_env_missing' };
  const body = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, data };
}

// Detect if a media URL is a video (MP4) or a still image. Same pattern as
// api/cron-send-for-approval.js's isVideoUrl -- kept local here since this
// script runs standalone (node, not the Vercel function bundle).
function isVideoUrl(url) {
  return /\.(mp4|mov|webm)(\?|$)/i.test(String(url || ''));
}

// Pick the listing's marketing video for a given orientation. Group posts
// (Tier 2, FB-only audience) use the SQUARE cut; Tier 1 owned-channel posts
// stay on the vertical cut already returned by pickMedia() above. Returns
// null if the listing has no video asset on file yet (e.g. Senisa) --
// callers must fall back to the text-only card and say so explicitly.
function pickMediaUrlForOrientation(listing, orientation) {
  if (!STORAGE_BASE || !listing.videos) return null;
  const file = orientation === 'square' ? listing.videos.square : listing.videos.vertical;
  if (!file) return null;
  return `${STORAGE_BASE}/${listing.videos.bucket}/${file}`;
}

// 2026-09-11 (Carter): the Tier-2 (FB group) approval card used to be
// text-only even when the listing had a real marketing video on file --
// Heath never saw what he was approving, just a caption. group_posts has
// no media_url column, so this sends the actual video as its OWN Telegram
// message (sendVideo/sendPhoto) BEFORE the text+buttons card, mirroring the
// safe two-message pattern already shipped in api/cron-send-for-approval.js
// (buttons stay on the text message so editMessageText in
// api/telegram-webhook.js keeps working unmodified -- Telegram can't
// editMessageText on a photo/video message). Best-effort and non-fatal: a
// failed media send never blocks the actual approval card from going out.
async function telegramSendMediaPreview(mediaUrl, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !mediaUrl) {
    return { ok: false, reason: 'no_media_or_telegram_env' };
  }
  const method = isVideoUrl(mediaUrl) ? 'sendVideo' : 'sendPhoto';
  const body = { chat_id: TELEGRAM_CHAT_ID, caption: String(caption || '').slice(0, 1020) };
  if (method === 'sendVideo') body.video = mediaUrl; else body.photo = mediaUrl;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!res.ok || data?.ok !== true) {
      console.error(`[listing-gen] media preview send failed (${method}):`, raw.slice(0, 300));
    }
    return { ok: res.ok && data?.ok === true, data };
  } catch (err) {
    console.error('[listing-gen] media preview send threw:', err && err.message);
    return { ok: false, reason: err && err.message };
  }
}

function lstKeyboard(rowId) {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `lst_approve:${rowId}` },
      { text: 'Edit', callback_data: `lst_edit:${rowId}` },
      { text: 'Skip', callback_data: `lst_skip:${rowId}` },
    ]],
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

// opts.freshStatuses -- when the caller (scripts/listing-marketing-generate-live.js)
// just performed a live connectMLS pull in THIS SAME process, it passes the
// resulting rows straight through here, bypassing the DB re-read (and its
// staleness window) entirely. This is the actual "live read at generation
// time" path. Falling back to the DB read (loadActiveListings, which itself
// enforces MAX_STATUS_AGE_MINUTES) is only safe for a manual/one-off run
// immediately after a sync -- it is NOT what should run unattended.
async function run(opts = {}) {
  const statuses = Array.isArray(opts.freshStatuses) && opts.freshStatuses.length
    ? opts.freshStatuses.filter((row) => LISTINGS[row.mls_number] && row.is_active)
    : await loadActiveListings();
  if (!statuses.length) {
    console.log('[listing-gen] No active, unpaused, FRESH listings in listing_marketing_status -- run listing-marketing-status-sync.js first (or scripts/listing-marketing-generate-live.js for the atomic path), or all listings are paused/under contract/stale.');
    return { ownedDrafted: 0, groupDrafted: 0 };
  }
  const statusByMls = Object.fromEntries(statuses.map((s) => [s.mls_number, s]));
  const activeMls = statuses.map((s) => s.mls_number);

  const out = { ownedDrafted: 0, groupDrafted: 0, results: [] };

  // ── Tier 1: owned channels ──
  const ownedRotation = await loadRotation(activeMls, 'owned');
  const ownedPick = activeMls
    .map((mls) => ({ mls, lastPostedAt: ownedRotation[mls]?.last_posted_at || null }))
    .sort((a, b) => (a.lastPostedAt || '').localeCompare(b.lastPostedAt || ''))[0];

  if (ownedPick) {
    const mls = ownedPick.mls;
    const listing = LISTINGS[mls];
    const status = statusByMls[mls];
    const rot = ownedRotation[mls] || {};
    const deck = status.list_price != null && status.last_notified_price != null
      && Number(status.list_price) !== Number(status.last_notified_price)
      ? ['milestone', ...ANGLES] : ANGLES;
    const angle = nextAngle(rot.angle_history, deck);
    const { body, image, hasMilestone } = buildOwnedPost(listing, status, angle);
    const usesStaged = !!(image && image.staged);
    const gate = checkListingPostCompliance({ body, isAgentOwned: listing.isAgentOwned, usesStagedImage: usesStaged, hasRealMilestone: hasMilestone, status });
    if (!gate.allowed) {
      console.error(`[listing-gen] TIER1 compliance gate BLOCKED ${mls}: ${gate.reasons.join(', ')} -- not inserted.`);
    } else {
      const preferredLabel = angle === 'room_feature' ? 'kitchen' : null;
      const media = pickMedia(listing, preferredLabel);
      const mediaUrl = media.url;
      const platform = 'facebook';
      if (refuseIfInstagramWithoutMedia(platform, mediaUrl, `${listing.key} owned/${angle}`)) {
        // Not reachable today (Tier-1 is facebook-only) -- guard kept here so
        // this insert path can never silently regress if a future edit adds
        // an 'instagram' platform without also carrying media forward.
      } else {
      const row = {
        post_id: `listing-${listing.key}-owned-${new Date().toISOString().slice(0, 10)}`,
        platform,
        content: body,
        status: 'draft',
        target_owner: 'heath-realtor',
        persona: 'heath-realtor',
        topic: `listing_${angle}`,
        media_url: mediaUrl,
        requires_approval: true,
        generated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      console.log(`[listing-gen] TIER1 (owned) -> ${listing.address} [${angle}]\n${body}\n`);
      if (!DRY_RUN) {
        const ins = await sbFetch('/rest/v1/social_posts', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        });
        if (ins.ok) {
          out.ownedDrafted++;
          await upsertRotation(mls, 'owned', angle, null);
          if (hasMilestone) {
            await sbFetch(`/rest/v1/listing_marketing_status?mls_number=eq.${mls}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ last_notified_price: status.list_price }),
            });
          }
        } else {
          console.error('[listing-gen] TIER1 insert failed', JSON.stringify(ins.data).slice(0, 300));
        }
      } else {
        out.ownedDrafted++;
      }
      out.results.push({ tier: 'owned', mls, address: listing.address, angle, body });
      }
    }
  }

  // ── Tier 2: FB groups ──
  const groupRotation = await loadRotation(activeMls, 'group');
  const pairs = [];
  for (const mls of activeMls) {
    const listing = LISTINGS[mls];
    for (const venueKey of listing.groupVenues || []) {
      pairs.push({ mls, venueKey });
    }
  }
  // Rank by (mls,venue) pair recency using the per-mls rotation row's venue_history
  // recency (a pair not in venue_history yet sorts first).
  const ranked = pairs
    .map((p) => {
      const rot = groupRotation[p.mls] || {};
      const idx = (rot.venue_history || []).lastIndexOf(p.venueKey);
      const recency = idx === -1 ? -1 : idx; // -1 = never used, sorts first
      return { ...p, recency, lastPostedAt: rot.last_posted_at || null };
    })
    .sort((a, b) => {
      if (a.recency !== b.recency) return a.recency - b.recency;
      return (a.lastPostedAt || '').localeCompare(b.lastPostedAt || '');
    });

  // Prefer a DIFFERENT listing than today's Tier-1 pick so a single day's
  // output doesn't put the same house in front of both audiences at once —
  // falls back to allowing overlap only if no other candidate exists.
  const rankedPreferDifferent = ownedPick
    ? ranked.filter((p) => p.mls !== ownedPick.mls).concat(ranked.filter((p) => p.mls === ownedPick.mls))
    : ranked;
  const groupPick = rankedPreferDifferent[0];
  if (groupPick) {
    const { mls, venueKey } = groupPick;
    const listing = LISTINGS[mls];
    const status = statusByMls[mls];
    const venue = GROUP_VENUES[venueKey];
    const rot = groupRotation[mls] || {};
    const GROUP_ANGLES = ['agent_to_agent', 'buyer_fit', 'price_value', 'room_feature'];
    const angle = nextAngle(rot.angle_history, GROUP_ANGLES);
    const body = buildGroupPost(listing, status, angle, venue);
    const gate = checkListingPostCompliance({ body, isAgentOwned: listing.isAgentOwned, usesStagedImage: false, hasRealMilestone: false, status });
    if (!gate.allowed) {
      console.error(`[listing-gen] TIER2 compliance gate BLOCKED ${mls}/${venueKey}: ${gate.reasons.join(', ')} -- not inserted.`);
    } else if (!venue.url) {
      console.error(`[listing-gen] TIER2 SKIPPED ${venueKey} -- no confirmed group URL on file, needs Heath to confirm before first send.`);
    } else {
      console.log(`[listing-gen] TIER2 (group) -> ${listing.address} -> ${venue.name} [${angle}]\n${body}\n`);
      if (!DRY_RUN) {
        const insertRow = {
          group_name: venue.name,
          group_url: venue.url,
          pipeline: 'listing-groups',
          category: 'listing-groups',
          template_id: angle,
          hook_type: angle,
          group_key: venueKey,
          post_body: body,
          first_comment_body: null,
          status: 'draft',
        };
        const ins = await sbFetch('/rest/v1/group_posts', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(insertRow),
        });
        if (ins.ok && Array.isArray(ins.data) && ins.data.length) {
          const post = ins.data[0];
          out.groupDrafted++;
          await upsertRotation(mls, 'group', angle, venueKey);
          // Show the real marketing video before the text card -- group_posts
          // has no media_url column, so this is a standalone preview message,
          // never persisted. Square cut (FB-group audience). Falls back to
          // the plain text card, saying so explicitly, if no video is on
          // file for this listing yet.
          const mediaUrl = pickMediaUrlForOrientation(listing, 'square');
          let mediaLine;
          if (mediaUrl) {
            await telegramSendMediaPreview(mediaUrl, `${listing.address} -> ${venue.name}`);
            mediaLine = '(video above)';
          } else {
            mediaLine = '(no media yet for this listing -- text only)';
          }
          const msg = `LISTING GROUP POST DRAFT\n${listing.address} -> ${venue.name}\nAngle: ${angle}\n${mediaLine}\n\n${body}`;
          const sendRes = await telegramSend(msg, lstKeyboard(post.id));
          if (sendRes.ok) {
            await sbFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(post.id)}`, {
              method: 'PATCH', headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ telegram_sent_at: new Date().toISOString(), telegram_message_id: sendRes.data?.result?.message_id != null ? String(sendRes.data.result.message_id) : null }),
            });
          } else {
            console.error('[listing-gen] TIER2 telegram send failed/skipped -- row left as draft for retry', sendRes.reason || '');
          }
        } else {
          console.error('[listing-gen] TIER2 insert failed', JSON.stringify(ins.data).slice(0, 300));
        }
      } else {
        out.groupDrafted++;
      }
      out.results.push({ tier: 'group', mls, address: listing.address, venue: venue.name, angle, body });
    }
  }

  console.log(`[listing-gen] DONE. Tier1 drafted: ${out.ownedDrafted}, Tier2 drafted: ${out.groupDrafted}. DRY_RUN=${DRY_RUN}`);
  return out;
}

if (require.main === module) {
  run().catch((e) => { console.error('[listing-gen] FATAL', e.message); process.exitCode = 1; });
}

module.exports = {
  run, buildOwnedPost, buildGroupPost, nextAngle, pickMedia, refuseIfInstagramWithoutMedia,
  pickMediaUrlForOrientation, telegramSendMediaPreview, telegramSend, lstKeyboard, isVideoUrl,
};
