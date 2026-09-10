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
const { checkListingPostCompliance } = require('./_lib/listing-post-compliance-gate');

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

async function loadActiveListings() {
  const { ok, data } = await sbFetch(`/rest/v1/listing_marketing_status?is_active=eq.true&is_paused=eq.false`);
  if (!ok || !Array.isArray(data)) return [];
  return data.filter((row) => LISTINGS[row.mls_number]); // only tracked listings
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

async function run() {
  const statuses = await loadActiveListings();
  if (!statuses.length) {
    console.log('[listing-gen] No active, unpaused listings in listing_marketing_status -- run listing-marketing-status-sync.js first, or all listings are paused/under contract.');
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
    const gate = checkListingPostCompliance({ body, isAgentOwned: listing.isAgentOwned, usesStagedImage: usesStaged, hasRealMilestone: hasMilestone });
    if (!gate.allowed) {
      console.error(`[listing-gen] TIER1 compliance gate BLOCKED ${mls}: ${gate.reasons.join(', ')} -- not inserted.`);
    } else {
      const mediaUrl = image && STORAGE_BASE ? `${STORAGE_BASE}/${listing.photos.bucket}/${image.file}` : null;
      const row = {
        post_id: `listing-${listing.key}-owned-${new Date().toISOString().slice(0, 10)}`,
        platform: 'facebook',
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
    const gate = checkListingPostCompliance({ body, isAgentOwned: listing.isAgentOwned, usesStagedImage: false, hasRealMilestone: false });
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
          const msg = `LISTING GROUP POST DRAFT\n${listing.address} -> ${venue.name}\nAngle: ${angle}\n\n${body}`;
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

module.exports = { run, buildOwnedPost, buildGroupPost, nextAngle };
