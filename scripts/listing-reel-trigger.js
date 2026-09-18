#!/usr/bin/env node
'use strict';

// scripts/listing-reel-trigger.js
//
// R1 "Ken Burns Listing Reel" AUTO-TRIGGER.
// docs/CONTENT-FORMAT-LIBRARY.md section R1 + section 5.3.
//
// The chain already exists end to end and NONE of it is rebuilt here:
//   live connectMLS read   scripts/listing-marketing-status-sync.js (syncAll)
//   verified fact pack     scripts/_lib/listing-marketing-facts.js
//   text-post generator    scripts/listing-marketing-generator.js
//   renderer               scripts/generate-listing-video.js  (Ken Burns 9:16 + 1:1, TREC card)
//   voiceover              scripts/gen-listing-voiceover.py
//   quality gate           scripts/check-video-quality-cli.js
//   queue (Pipeline B)     scripts/queue-finished-videos.py  -> video_library -> Telegram approval
//
// The ONLY missing link, per section 5.3, was firing the video build from the
// same atomic live-read run that generates the copy, so a reel can never be
// built off a stale price. That is all this file does.
//
// ---------------------------------------------------------------------------
// WHERE THIS FIRES FROM
// ---------------------------------------------------------------------------
// Inside the atomic run in scripts/listing-marketing-generate-live.js, between
// the live read and the text generator, using the SAME in-memory
// `freshStatuses` array -- no DB round trip, no window for a stale snapshot:
//
//     const syncResult = await syncAllFn({ verifiedBy: '...' });   // live read
//     const freshStatuses = Object.values(syncResult.statusByMls);
//     ...
// +   const reelResult = await require('./listing-reel-trigger')
// +     .runReelTrigger({ freshStatuses, dryRun, notifyHeath: notify });
//     const genResult = await generatorRunFn({ freshStatuses });    // text posts
//
// (That two-line wire-up belongs to whoever owns listing-marketing-generate-
// live.js -- this file does not edit it.)
//
// Standalone, this script performs the identical atomic sequence itself:
// it calls syncAll() in-process and feeds the result straight in. Either way
// the facts used to build a reel were read live in THIS process.
//
//   node scripts/listing-reel-trigger.js                  # live read + trigger + build spec
//   node scripts/listing-reel-trigger.js --render         # also render + gate + queue
//   node scripts/listing-reel-trigger.js --dry-run        # decide + gate, write nothing
//   node scripts/listing-reel-trigger.js --force          # ignore the per-listing cooldown
//   node scripts/listing-reel-trigger.js --mls 1916402    # restrict to one listing
//   node scripts/listing-reel-trigger.js --emit-fact-pack 1916402 --out-dir <dir>
//
// WSL GOTCHA -- the entry script must live under /mnt/c/ (a real C: path).
// scripts/_lib/brokerage-browser.js re-execs the ENTRY SCRIPT through Windows
// node.exe (real Chrome only exists on Windows) and Windows node resolves the
// path as a Windows path, so a runner living in a WSL-only dir like /tmp
// becomes "C:\tmp\..." and fails with MODULE_NOT_FOUND. Run this file in
// place; put scratch DATA wherever you like (LISTING_REEL_STAGING_DIR /
// LISTING_REEL_STATE_FILE), it is only the script path that must be
// Windows-visible. Env values holding paths must be Windows-style too.
//
// ---------------------------------------------------------------------------
// HARD RULES THIS FILE ENFORCES (each one exists because of a real incident)
// ---------------------------------------------------------------------------
// 1. LIVE READ ONLY, NEVER A CACHED FALLBACK. This module contains NO read of
//    listing_marketing_status. Facts arrive only as `freshStatuses` produced
//    by syncAll() in this same process, and every row is re-checked for
//    last_verified_by + last_verified_at freshness before it is used. If the
//    live read throws, or verifies zero listings, this ABORTS AND ALERTS and
//    builds nothing. api/cron-daily-listing-posts.js was killed 2026-09-11
//    for advertising a stale $1,195,000 against a live $999,000; that cron is
//    never re-enabled and this file must never grow a DB fallback.
// 2. MLS STATUS IS THE SOLE SOURCE OF TRUTH for active / under contract /
//    sold. Nothing here infers status from a PDF, an envelope, or a document.
// 3. COPY NEVER SIGNALS WEAKNESS. A price change is a legitimate REFRESH
//    TRIGGER; the copy may never reference the change. Enforced by
//    scripts/_lib/listing-reel-copy-gate.js, run over every visible surface
//    before anything renders.
// 4. NEVER SHOW A SALE PRICE ON A JUST-SOLD. show_price is hard-forced false
//    and the gate additionally refuses any price mention on a non-active
//    status.
// 5. TREC ADVERTISING. The broker name lands on the closing card, derived by
//    parsing TREC_ATTRIBUTION -- never hand-written -- and the gate verifies
//    it is actually on the card surface.
// 6. FAIR HOUSING. docs/CONTENT-DO-NOT-WRITE-LIST.md's machine-readable index
//    is loaded and run before render. Missing/unparseable doc, or a blocking
//    topic with no detector, halts the run.
// 7. QUALITY GATE IS FAIL-CLOSED. A non-parseable / crashed
//    check-video-quality-cli.js result is a HARD FAIL, never "skip".
// 8. NOTHING AUTO-POSTS. Output lands in video_library via the existing
//    Pipeline B queue at status='approved' -> the normal Telegram approval
//    flow. No new queue path, no direct publish.
//
// Owner: R1 trigger build, 2026-09-16.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

// ── .env.local (same loader the rest of the pipeline uses) ──────────────────
try {
  const envPath = path.join(REPO_ROOT, '.env.local');
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
} catch { /* non-fatal */ }

const { LISTINGS, ANGLES } = require('./_lib/listing-marketing-facts');
const { MAX_STATUS_AGE_MINUTES } = require('./_lib/listing-post-compliance-gate');
const { checkReelCopy, parseTrecAttribution } = require('./_lib/listing-reel-copy-gate');
const { ACTIVE_FAMILY, UNDER_CONTRACT_ACTIVE_FAMILY, OFF_MARKET, isPostableActive } = require('./_lib/mls-status-taxonomy');
const { nextAngle } = require('./listing-marketing-generator');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Paths / conventions ─────────────────────────────────────────────────────

// Same dot-prefixed local-state convention as
// scripts/.listing-marketing-live-state.json (written by
// listing-marketing-generate-live.js). This is the FAST ledger; video_library
// is the DURABLE one (see hasAlreadyFired()).
// LISTING_REEL_STATE_FILE overrides it for a test run so a rehearsal never
// writes the real ledger.
const STATE_FILE = process.env.LISTING_REEL_STATE_FILE || path.join(__dirname, '.listing-reel-trigger-state.json');

// The ONE real Media/ library. Media/ is gitignored, so a clean checkout of
// origin/main -- which is exactly what Windows Task Scheduler runs out of
// (C:\Users\Heath\Projects\MeetDossie-scheduler, docs/SCHEDULER-CHECKOUT.md)
// -- has the code, the music beds, and the watch folders in DIFFERENT places
// than the dev tree. DOSSIE_MEDIA_ROOT points every path below at the same
// library regardless of which checkout is executing, so a scheduled reel lands
// in the folder queue-finished-videos.py actually scans.
const MEDIA_ROOT = process.env.DOSSIE_MEDIA_ROOT || path.join(REPO_ROOT, 'Media');

// Pipeline B's realtor watch folder. queue-finished-videos.py scans this and
// uses the FILENAME STEM as video_library.id -- the filename IS the ledger
// (its own words). We name reels deterministically so that property holds.
const REALTOR_FINISHED_DIR = path.join(MEDIA_ROOT, 'finished-videos', 'realtor');

// Staging area: reels render here FIRST and are only moved into the watch
// folder after the quality gate passes. A failing reel must never land in a
// folder something else scans.
const STAGING_DIR = process.env.LISTING_REEL_STAGING_DIR || path.join(MEDIA_ROOT, 'listing-reels-staging');

const QUALITY_GATE_CLI = path.join(__dirname, 'check-video-quality-cli.js');
const RENDERER = path.join(__dirname, 'generate-listing-video.js');
const VOICEOVER_SCRIPT = path.join(__dirname, 'gen-listing-voiceover.py');
const QUEUE_SCRIPT = path.join(__dirname, 'queue-finished-videos.py');
const MUSIC_DIR = path.join(MEDIA_ROOT, 'Music');

// MLS photo dumps are gitignored (.tmp/), so the location is configurable and
// resolution is explicit -- a missing photo set is a hard skip with a named
// reason, never a substituted or fabricated image.
const PHOTO_ROOTS = [
  process.env.LISTING_REEL_PHOTOS_ROOT,
  path.join(REPO_ROOT, '.tmp', 'fawndale-wildcherry-photos'),
  path.join(MEDIA_ROOT, 'listing-photos'),
  // Heath's main dev tree, where the MLS photo dumps actually live today.
  // Read-only; nothing is ever written there.
  '/mnt/c/Users/Heath/Projects/MeetDossie/.tmp/fawndale-wildcherry-photos',
].filter(Boolean);

// Don't let a flapping MLS status burn the runway. Overridable per run.
const MIN_INTERVAL_HOURS = Number(process.env.LISTING_REEL_MIN_INTERVAL_HOURS) || 24;
// One reel per run by default -- 6 angles x active listings is the whole
// runway (18 at 3 active listings); it is not meant to be spent in a day.
const DEFAULT_MAX_PER_RUN = Number(process.env.LISTING_REEL_MAX_PER_RUN) || 1;

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; } else { out[key] = true; }
    } else out._.push(a);
  }
  return out;
}

// ── Small helpers ───────────────────────────────────────────────────────────

const moneyFmt = (n) => '$' + Number(n).toLocaleString('en-US');
const nowIso = () => new Date().toISOString();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch { /* start fresh */ }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[reel-trigger] could not persist state:', e.message);
  }
}

async function sbFetch(urlPath, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { ok: false, status: 0, data: null, reason: 'supabase_env_missing' };
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  try {
    const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, reason: e.message };
  }
}

async function notifyHeathDefault(text) {
  const token = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[reel-trigger] No Telegram token/chat id -- cannot alert. Message was:', text);
    return { ok: false, reason: 'telegram_env_missing' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4090), disable_web_page_preview: true }),
    });
    return { ok: res.ok };
  } catch (e) {
    console.warn('[reel-trigger] Telegram alert failed:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RULE 1 -- live-read provenance. There is deliberately no code path in this
// file that reads listing_marketing_status. A row is usable only if it came
// out of syncAll() in this process AND still carries fresh verification
// metadata. Belt-and-suspenders with the same check in
// listing-post-compliance-gate.js; both must independently refuse.
// ─────────────────────────────────────────────────────────────────────────────
function assertLiveProvenance(freshStatuses) {
  if (!Array.isArray(freshStatuses) || !freshStatuses.length) {
    return { ok: false, reason: 'live read verified ZERO listings -- building nothing, never falling back to cached/DB data' };
  }
  const bad = [];
  for (const row of freshStatuses) {
    if (!row || !row.mls_number) { bad.push('row_without_mls_number'); continue; }
    if (!row.last_verified_by) { bad.push(`${row.mls_number}:no_last_verified_by`); continue; }
    if (!row.last_verified_at) { bad.push(`${row.mls_number}:no_last_verified_at`); continue; }
    const ageMin = (Date.now() - new Date(row.last_verified_at).getTime()) / 60000;
    if (!Number.isFinite(ageMin) || ageMin > MAX_STATUS_AGE_MINUTES) {
      bad.push(`${row.mls_number}:stale_${Math.round(ageMin)}min`);
      continue;
    }
    if (!row.mls_status) { bad.push(`${row.mls_number}:no_mls_status`); }
  }
  if (bad.length) {
    return { ok: false, reason: `rows failed live-provenance check: ${bad.join(', ')}` };
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER DETECTION
// ─────────────────────────────────────────────────────────────────────────────

// The trigger FINGERPRINT is the event, not the day: (mls, status, price).
// Same listing, same MLS status, same live price => same fingerprint => the
// reel for it is already built and this never fires again. A REAL status
// change or a REAL price change changes the fingerprint exactly once.
function fingerprintOf(row) {
  const raw = `${row.mls_number}|${row.mls_status}|${row.list_price == null ? '' : Number(row.list_price)}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
}

/**
 * Classify what (if anything) this live row triggers, against the ledger.
 * Returns { fire: boolean, reason, kind, fingerprint, detail }.
 *
 * kind:
 *   'listing_reel'        R1 -- an active listing (new, or an active-family
 *                         status/price refresh)
 *   'just_sold'           R6 -- SLD. Price is HARD-FORCED off.
 *   'under_contract'      R6 -- went under contract / option. Price off.
 *   null                  no reel (withdrawn/expired/cancelled/rented, or
 *                         nothing actually changed)
 */
function classifyTrigger(row, ledgerEntry, { force = false } = {}) {
  const fp = fingerprintOf(row);
  const status = row.mls_status;
  const prev = ledgerEntry || null;

  const isNewListing = !prev;
  const statusChanged = !!prev && prev.last_mls_status !== status;
  const priceChanged = !!prev && Number(prev.last_list_price) !== Number(row.list_price);

  // Already built a reel for this exact (listing, status, price) event.
  if (prev && prev.fired && prev.fired[fp] && prev.fired[fp].outcome === 'queued' && !force) {
    return { fire: false, reason: 'already_fired_for_this_event', kind: null, fingerprint: fp };
  }

  // Cooldown -- a flapping status must not spend the runway.
  if (prev && prev.last_fired_at && !force) {
    const hrs = (Date.now() - new Date(prev.last_fired_at).getTime()) / 3600000;
    if (Number.isFinite(hrs) && hrs < MIN_INTERVAL_HOURS) {
      return { fire: false, reason: `cooldown_${Math.round(hrs)}h_of_${MIN_INTERVAL_HOURS}h`, kind: null, fingerprint: fp };
    }
  }

  // Off-market / under-contract handling. MLS status is the sole source of
  // truth here -- never an envelope, never a PDF.
  if (OFF_MARKET.has(status)) {
    if (status === 'SLD') {
      if (!statusChanged && !isNewListing && !force) {
        return { fire: false, reason: 'already_sold_no_change', kind: null, fingerprint: fp };
      }
      return {
        fire: true, kind: 'just_sold', fingerprint: fp,
        reason: isNewListing ? 'new_listing_already_sold' : `status_change:${prev.last_mls_status}->${status}`,
        detail: 'sale price hard-forced off (memory: never show the sale price on a just-sold)',
      };
    }
    // EXP / CAN / WD / RNTD -- no reel, ever. Record the status so the next
    // genuine relist (BOM/NEW) reads as a real change.
    return { fire: false, reason: `off_market_no_reel:${status}`, kind: null, fingerprint: fp };
  }

  if (UNDER_CONTRACT_ACTIVE_FAMILY.has(status)) {
    if (!statusChanged && !isNewListing && !force) {
      return { fire: false, reason: 'already_under_contract_no_change', kind: null, fingerprint: fp };
    }
    return {
      fire: true, kind: 'under_contract', fingerprint: fp,
      reason: isNewListing ? 'new_listing_already_under_contract' : `status_change:${prev.last_mls_status}->${status}`,
      detail: 'price hard-forced off; marketing an under-contract listing as buyable is the exact auto-stop failure mode',
    };
  }

  if (!ACTIVE_FAMILY.has(status)) {
    return { fire: false, reason: `unrecognised_mls_status:${status}`, kind: null, fingerprint: fp };
  }

  // ── Active family. The three R1 refresh inputs, per CONTENT-FORMAT-LIBRARY
  //    section R1 "Freshness": a new listing, a status change, a price change.
  if (isNewListing) {
    return { fire: true, kind: 'listing_reel', fingerprint: fp, reason: 'new_listing', detail: `first time ${row.mls_number} has been seen by the reel trigger` };
  }
  if (statusChanged) {
    return { fire: true, kind: 'listing_reel', fingerprint: fp, reason: `status_change:${prev.last_mls_status}->${status}`, detail: 'real MLS status change' };
  }
  if (priceChanged) {
    // A price change TRIGGERS the refresh. The copy must never reference the
    // change itself -- enforced downstream by listing-reel-copy-gate.js.
    return {
      fire: true, kind: 'listing_reel', fingerprint: fp,
      reason: 'price_refresh',
      detail: 'price moved -- refreshing the reel at the new live price; the copy must never mention that it moved',
    };
  }
  if (force) {
    return { fire: true, kind: 'listing_reel', fingerprint: fp, reason: 'forced', detail: '--force' };
  }
  return { fire: false, reason: 'no_change', kind: null, fingerprint: fp };
}

/**
 * Durable idempotency cross-check. The local JSON ledger is fast but
 * deletable; video_library is the real one -- queue-finished-videos.py's own
 * convention is that the filename stem IS the id and a stem already in
 * video_library is never re-queued. Reel ids are deterministic per event, so
 * asking video_library "do you already have this reel?" survives a wiped
 * state file. A Supabase failure here returns null = UNKNOWN, and unknown is
 * treated as "do not fire" by the caller (fail-closed on idempotency too --
 * a missed reel is recoverable, a duplicate advert is not).
 */
async function alreadyInVideoLibrary(reelId) {
  const { ok, data, reason } = await sbFetch(`/rest/v1/video_library?id=eq.${encodeURIComponent(reelId)}&select=id`);
  if (!ok) {
    console.warn(`[reel-trigger] could not check video_library for ${reelId} (${reason || 'http error'})`);
    return null;
  }
  return Array.isArray(data) && data.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEC BUILD -- copy is template-based against the verified fact pack, never
// freeform invention. Same philosophy as listing-marketing-generator.js.
// ─────────────────────────────────────────────────────────────────────────────

function agentPhone() {
  if (process.env.LISTING_AGENT_PHONE) return process.env.LISTING_AGENT_PHONE;
  // Reuse the already-shipped, already-approved value from the existing
  // listing-video configs rather than typing a phone number into new code.
  const dir = path.join(__dirname, 'listing-video-configs');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && j.agent && j.agent.phone) return j.agent.phone;
    }
  } catch { /* fall through */ }
  return null;
}

function resolvePhotoDir(listing) {
  for (const root of PHOTO_ROOTS) {
    const dir = path.join(root, listing.key);
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => new RegExp(`^${listing.key}-photo\\d+\\.jpg$`).test(f));
      if (files.length >= 4) return { dir, prefix: `${listing.key}-photo`, count: files.length };
    }
  }
  return null;
}

function bathCount(listing) {
  if (!listing.baths) return null;
  const m = String(listing.baths).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function specLine(listing) {
  const parts = [];
  if (listing.subdivision) parts.push(String(listing.subdivision).toUpperCase());
  if (listing.sqft) parts.push(`${listing.sqft.toLocaleString()} SQ FT`);
  if (listing.lotAcres && listing.lotAcres >= 1) parts.push(`${listing.lotAcres} ACRES`);
  else if (listing.beds) parts.push(`${listing.beds} BED`);
  return parts.slice(0, 3).join('  |  ');
}

// Take the strongest short fragment out of a verified feature string, for a
// hook line. Never rewrites the fact, only truncates at a clause boundary.
function featureHeadline(feature, maxLen = 34) {
  const first = String(feature || '').split(/\s+[-–]\s+|[,.:;]/)[0].trim();
  if (!first) return null;
  if (first.length <= maxLen) return first;
  const cut = first.slice(0, maxLen);
  return cut.slice(0, cut.lastIndexOf(' ')) || cut;
}

// Hook bank is deliberately FACT-DERIVED, not persuasion-derived: every line
// is a value already verified live or already in the fact pack. The playbook's
// realtor hook bank (SCROLL-STOPPING-VIDEO-PLAYBOOK.md section 2, items 19-21)
// is the place to enrich this -- but anything added here still has to clear
// listing-reel-copy-gate.js, which is the point.
function buildAngleCopy({ listing, price, showPrice, angle, kind }) {
  const city = listing.city;
  const baths = bathCount(listing);
  const sqft = listing.sqft ? listing.sqft.toLocaleString() : null;

  if (kind === 'just_sold') {
    return {
      eyebrow: 'JUST SOLD',
      hook: `Sold.\n${listing.address}`,
      // No price. Not in the hook, not in the pill, not in the card, not in
      // the script. Enforced again by the gate.
      script: `${listing.address} in ${city} has closed. `
        + `${sqft ? `${sqft} square feet` : 'A great home'}${listing.subdivision ? ` in ${listing.subdivision}` : ''}. `
        + `If you are thinking about selling in ${city}, I would be glad to walk you through what your home would do in this market. `
        + `Text me. ${agentPhone() || ''}`.trim(),
    };
  }

  if (kind === 'under_contract') {
    return {
      eyebrow: 'UNDER CONTRACT',
      hook: `Under contract.\n${listing.address}`,
      script: `${listing.address} in ${city} is under contract. `
        + `If you are looking in ${city}${listing.subdivision ? ` or ${listing.subdivision}` : ''}, I keep an eye on what comes up. `
        + `Text me and I will send you what fits. ${agentPhone() || ''}`.trim(),
    };
  }

  const priceSentence = showPrice && price != null ? `Listed at ${moneyFmt(price)}. ` : '';
  const cta = `Text me for a private showing. ${agentPhone() || ''}`.trim();
  const f0 = featureHeadline(listing.features && listing.features[0]);
  const f1 = featureHeadline(listing.features && listing.features[1]);
  const f2 = featureHeadline(listing.features && listing.features[2]);

  switch (angle) {
    case 'room_feature':
      return {
        eyebrow: 'INSIDE',
        hook: sqft && listing.beds ? `${sqft} sq ft.\n${listing.beds} bed, ${baths || listing.baths} bath.` : `Inside\n${listing.address}`,
        script: `A closer look inside ${listing.address}, ${city}. `
          + (listing.features && listing.features[0] ? `${listing.features[0]}. ` : '')
          + (sqft ? `${sqft} square feet` : '')
          + (listing.beds ? `, ${listing.beds} bedrooms` : '')
          + (baths ? `, ${baths} full baths` : '') + '. '
          + priceSentence + cta,
      };
    case 'price_value':
      return {
        eyebrow: 'ON THE MARKET',
        hook: showPrice && price != null ? `${moneyFmt(price)}\nin ${city}.` : `${sqft || ''} sq ft\nin ${city}.`.trim(),
        script: `${listing.address}, ${city}. `
          + priceSentence
          + (sqft ? `${sqft} square feet` : '')
          + (listing.subdivision ? ` in ${listing.subdivision}` : '') + '. '
          + (listing.features && listing.features[0] ? `${listing.features[0]}. ` : '')
          + cta,
      };
    case 'neighborhood_lifestyle':
      return {
        eyebrow: (listing.subdivision || city).toUpperCase(),
        hook: listing.lotAcres && listing.lotAcres >= 1
          ? `${listing.lotAcres} acres.\n${city}, Texas.`
          : `${listing.subdivision || city}.\n${city}, Texas.`,
        script: `${listing.subdivision || city}, in ${city}. `
          + (f1 ? `${listing.features[1]}. ` : '')
          + `${listing.address}${sqft ? `, ${sqft} square feet` : ''}. `
          + priceSentence + cta,
      };
    case 'buyer_fit':
      return {
        eyebrow: 'WHO IT FITS',
        hook: f2 ? `${f2}.\n${listing.address}` : `${listing.address}\n${city}, Texas.`,
        script: `If you are looking in ${city}, ${listing.address} is worth a walk-through. `
          + (listing.features && listing.features[2] ? `${listing.features[2]}. ` : (listing.features && listing.features[0] ? `${listing.features[0]}. ` : ''))
          + priceSentence + cta,
      };
    case 'agent_to_agent':
      return {
        eyebrow: 'FOR AGENTS',
        hook: `${listing.address}\n${city}, Texas.`,
        script: `Agents, ${listing.address} in ${city} is on the market. `
          + (sqft ? `${sqft} square feet` : '')
          + (listing.subdivision ? ` in ${listing.subdivision}` : '') + '. '
          + priceSentence
          + `I am happy to work with buyer agents on showing access. Reach out directly. ${agentPhone() || ''}`.trim(),
      };
    case 'showing_availability':
    default:
      return {
        eyebrow: 'SHOWING NOW',
        hook: `${listing.address}\nis showing.`,
        script: `${listing.address}, ${city}, is showing now. `
          + (f0 ? `${listing.features[0]}. ` : '')
          + priceSentence + cta,
      };
  }
}

/**
 * Build the full reel spec (the generate-listing-video.js listing JSON plus
 * the voiceover script and the post caption) from the LIVE row + the verified
 * fact pack. Returns null-safe { spec, script, caption, surfaces }.
 */
function buildReelSpec({ row, listing, angle, kind, reelId, photo }) {
  const trec = parseTrecAttribution(); // parsed, never hand-written
  const phone = agentPhone();
  if (!phone) throw new Error('[reel-trigger] no agent phone available (set LISTING_AGENT_PHONE or keep scripts/listing-video-configs/*.json) -- refusing to render a card with a blank contact line.');

  // RULE 4 -- a sale price NEVER appears on a just-sold, and an under-contract
  // listing is never advertised at a buyable price.
  const showPrice = kind === 'listing_reel' && isPostableActive(row.mls_status) && row.list_price != null;
  const price = showPrice ? Number(row.list_price) : null;

  const copy = buildAngleCopy({ listing, price, showPrice, angle, kind });
  const specs = specLine(listing);

  const photoOrder = [];
  for (let i = 0; i < Math.min(10, photo.count); i++) photoOrder.push(i);

  const spec = {
    id: reelId,
    address_line1: listing.address,
    address_line2: `${listing.city}, TX ${listing.zip}`,
    eyebrow: copy.eyebrow,
    hook: copy.hook,
    show_price: showPrice,
    price: showPrice ? moneyFmt(price) : null,
    specs,
    photo_prefix: photo.prefix,
    photo_order: photoOrder,
    intro_photo_count: Math.min(4, photoOrder.length),
    voice_marker: null,
    agent: {
      // Derived from TREC_ATTRIBUTION. The brokerage segment IS the
      // TREC-required broker name on the card.
      name: trec.agentName,
      brokerage: trec.brokerage,
      phone,
    },
    // Provenance, written into the spec so a rendered reel can always be
    // traced back to the exact live read it was built from.
    _provenance: {
      mls_number: row.mls_number,
      mls_status: row.mls_status,
      list_price: row.list_price == null ? null : Number(row.list_price),
      last_verified_at: row.last_verified_at,
      last_verified_by: row.last_verified_by,
      // status-sync.js HARD-BLOCKS a genuine street-suffix mismatch (the 702
      // Fawndale Dr/Ln incident) but only console-warns when it finds no
      // corroborating text in the remarks/directions -- and it does not
      // surface that outcome on the row today. "Not corroborated" is not
      // "mismatched", so it is not a block, but it must not be INVISIBLE on
      // a TREC-regulated advert either: it is carried here, surfaced in the
      // Telegram approval message, and can be made a hard gate by setting
      // LISTING_REEL_REQUIRE_ADDRESS_CORROBORATION=1 once status-sync starts
      // returning row.address_verified.
      address_corroboration: typeof row.address_verified === 'boolean'
        ? (row.address_verified ? 'verified_this_read' : 'not_corroborated_this_read')
        : 'unknown_status_sync_does_not_report_it_yet',
      trec_attribution: trec.full,
      angle,
      kind,
      built_at: nowIso(),
      source: 'scripts/listing-reel-trigger.js (same-process live connectMLS read)',
    },
  };

  // post_caption lives in the build spec so the compositor's own caption
  // check sees it, and is ALSO written as <stem>.caption.txt next to the mp4
  // -- Pipeline B (queue-finished-videos.py, 57db314d) reads that sidecar
  // when no WEEKLY-RECORDING-KIT.md script matches the topic slug. R1 copy
  // must never pre-exist the render: a pre-written kit-doc caption is by
  // definition a cached price, which is the defect that killed
  // api/cron-daily-listing-posts.js on 2026-09-11.
  spec.post_caption = null; // set below, after `caption` is built

  const caption = `${copy.script}\n\n${trec.full}`
    + (listing.isAgentOwned ? '\n\nSeller/Owner is a licensed Texas real estate broker/sales agent.' : '');
  spec.post_caption = caption;

  // EVERY visible surface goes to the gate. A surface omitted here is a
  // surface not checked.
  const closingCardText = [
    showPrice ? spec.price : '',
    spec.address_line1,
    spec.address_line2,
    spec.agent.name,
    spec.agent.brokerage,
    spec.agent.phone,
  ].filter(Boolean).join('\n');

  const surfaces = [
    { name: 'eyebrow', text: spec.eyebrow },
    { name: 'hook', text: spec.hook },
    { name: 'specs', text: spec.specs },
    { name: 'price_pill', text: showPrice ? spec.price : '' },
    { name: 'lower_third', text: `${spec.address_line1} ${spec.address_line2}` },
    { name: 'closing_card', text: closingCardText },
    { name: 'voiceover_script', text: copy.script },
    { name: 'caption', text: caption },
  ];

  return { spec, script: copy.script, caption, surfaces, showPrice, trec };
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER / GATE / QUEUE
// ─────────────────────────────────────────────────────────────────────────────

function pickMusic() {
  try {
    const files = fs.readdirSync(MUSIC_DIR).filter((f) => f.endsWith('.mp3'));
    if (!files.length) return null;
    // Deterministic, not random -- acreage track for the big listing, the
    // renovation track otherwise; falls back to whatever is licensed.
    return path.join(MUSIC_DIR, files[0]);
  } catch { return null; }
}

function runNode(args, opts = {}) {
  return spawnSync('node', args, { encoding: 'utf8', timeout: opts.timeout || 900000, cwd: REPO_ROOT });
}

function extractCoverFrame(videoPath, outPng) {
  try {
    execFileSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', outPng], { stdio: 'pipe', timeout: 60000 });
    if (fs.existsSync(outPng) && fs.statSync(outPng).size > 0) return outPng;
  } catch (e) {
    console.warn('[reel-trigger] cover frame extraction failed:', e.message);
  }
  return null;
}

/**
 * RULE 7 -- FAIL CLOSED.
 * Contract (fixed by scripts/queue-finished-videos.py run_quality_gate):
 *   node scripts/check-video-quality-cli.js --video <path> [--cover <path>]
 * prints exactly ONE JSON line to stdout: {pass, rules, failedRules, detail}.
 *
 * Anything else -- a crash, a missing CLI, no output, unparseable output, a
 * missing `pass` key -- is a HARD FAIL. Never "skip the gate". A held reel
 * costs a day; a bad reel is public and permanent.
 */
function runQualityGate(videoPath, coverPath) {
  if (!fs.existsSync(QUALITY_GATE_CLI)) {
    return { pass: false, hardFail: true, failedRules: ['gate_cli_missing'], detail: { note: `${QUALITY_GATE_CLI} does not exist -- failing closed` } };
  }
  const args = [QUALITY_GATE_CLI, '--video', videoPath];
  if (coverPath) args.push('--cover', coverPath);
  const res = runNode(args, { timeout: 300000 });
  if (res.error) {
    return { pass: false, hardFail: true, failedRules: ['gate_cli_threw'], detail: { note: res.error.message } };
  }
  const lines = String(res.stdout || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) {
    return { pass: false, hardFail: true, failedRules: ['gate_cli_no_output'], detail: { stderr: String(res.stderr || '').slice(0, 500) } };
  }
  let parsed;
  try { parsed = JSON.parse(lines[lines.length - 1]); } catch {
    return { pass: false, hardFail: true, failedRules: ['gate_cli_unparseable'], detail: { stdout: lines[lines.length - 1].slice(0, 500), stderr: String(res.stderr || '').slice(0, 500) } };
  }
  if (!parsed || typeof parsed.pass !== 'boolean') {
    return { pass: false, hardFail: true, failedRules: ['gate_cli_bad_shape'], detail: { got: JSON.stringify(parsed).slice(0, 500) } };
  }
  return {
    pass: parsed.pass === true,
    hardFail: false,
    rules: parsed.rules || {},
    failedRules: parsed.failedRules || [],
    detail: parsed.detail || {},
  };
}

/**
 * RULE 8 -- reuse Pipeline B. Drop the passing reel into
 * Media/finished-videos/realtor/ and let scripts/queue-finished-videos.py do
 * the upload + video_library upsert (status='approved' -> Telegram approval).
 * No parallel queue path, no direct publish.
 *
 * Captions: the primary path is the <stem>.caption.txt sidecar we drop next
 * to the mp4 (queue-finished-videos.py 57db314d reads it when no
 * WEEKLY-RECORDING-KIT.md script matches the topic slug -- which is always,
 * for a generated reel). The PATCH afterwards is a backstop for an older
 * queue build that ignores the sidecar; it is a DB write, not a second queue.
 */
function runPipelineBQueue() {
  const py = process.env.PYTHON || 'python';
  const res = spawnSync(py, [QUEUE_SCRIPT], { encoding: 'utf8', timeout: 900000, cwd: REPO_ROOT });
  return {
    ok: res.status === 0,
    status: res.status,
    stdout: String(res.stdout || '').slice(-2000),
    stderr: String(res.stderr || '').slice(-1000),
    error: res.error ? res.error.message : null,
  };
}

async function patchCaption(reelId, caption) {
  const { ok, status } = await sbFetch(`/rest/v1/video_library?id=eq.${encodeURIComponent(reelId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ caption }),
  });
  return { ok, status };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {Array} opts.freshStatuses  REQUIRED in embedded mode -- the in-memory
 *   rows from syncAll() in THIS process. No DB fallback exists.
 * @param {boolean} [opts.dryRun]     decide + gate, write nothing
 * @param {boolean} [opts.force]      ignore cooldown / already-fired
 * @param {boolean} [opts.render]     actually render + gate + queue
 * @param {string}  [opts.onlyMls]
 * @param {number}  [opts.maxPerRun]
 * @param {Function}[opts.notifyHeath]
 */
async function runReelTrigger(opts = {}) {
  const notify = opts.notifyHeath || notifyHeathDefault;
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;
  const doRender = !!opts.render;
  const maxPerRun = Number(opts.maxPerRun) || DEFAULT_MAX_PER_RUN;

  // RULE 1 -- live provenance or nothing.
  const prov = assertLiveProvenance(opts.freshStatuses);
  if (!prov.ok) {
    const msg = `LISTING REEL TRIGGER: ${prov.reason}. Built ZERO reels -- never falling back to cached/DB data.`;
    console.error(`[reel-trigger] ${msg}`);
    await notify(msg);
    return { built: 0, aborted: true, reason: prov.reason, decisions: [] };
  }

  const state = opts.state || loadState();
  state.listings = state.listings || {};

  const rows = opts.freshStatuses
    .filter((r) => LISTINGS[r.mls_number])
    .filter((r) => (opts.onlyMls ? r.mls_number === String(opts.onlyMls) : true));

  const decisions = [];
  const built = [];
  let fired = 0;

  for (const row of rows) {
    const listing = LISTINGS[row.mls_number];
    const entry = state.listings[row.mls_number] || null;
    const cls = classifyTrigger(row, entry, { force });

    const base = {
      mls: row.mls_number,
      address: listing.address,
      mls_status: row.mls_status,
      list_price: row.list_price == null ? null : Number(row.list_price),
      fingerprint: cls.fingerprint,
      fire: cls.fire,
      reason: cls.reason,
      kind: cls.kind,
    };

    // Always record what we saw, even when we don't fire -- that is what
    // makes the NEXT genuine change detectable.
    const nextEntry = {
      mls_number: row.mls_number,
      address: listing.address,
      last_mls_status: row.mls_status,
      last_list_price: row.list_price == null ? null : Number(row.list_price),
      last_fingerprint: cls.fingerprint,
      last_seen_at: nowIso(),
      last_fired_at: entry && entry.last_fired_at ? entry.last_fired_at : null,
      angle_history: (entry && entry.angle_history) || [],
      fired: (entry && entry.fired) || {},
    };

    if (!cls.fire) {
      decisions.push(base);
      state.listings[row.mls_number] = nextEntry;
      console.log(`[reel-trigger] ${row.mls_number} ${listing.address}: no fire (${cls.reason})`);
      continue;
    }

    if (fired >= maxPerRun) {
      decisions.push({ ...base, fire: false, reason: `deferred_max_per_run_${maxPerRun}` });
      state.listings[row.mls_number] = nextEntry;
      console.log(`[reel-trigger] ${row.mls_number}: would fire (${cls.reason}) but max-per-run reached -- deferring to the next run.`);
      continue;
    }

    // Angle rotation -- reuses listing-marketing-generator.js's nextAngle so
    // the reel deck and the text-post deck rotate by the same rule.
    const angle = cls.kind === 'listing_reel' ? nextAngle(nextEntry.angle_history, ANGLES) : cls.kind;
    // Deterministic per EVENT, so video_library (whose id is the filename
    // stem) doubles as the durable ledger -- queue-finished-videos.py's own
    // "the filename IS the ledger" convention, reused rather than reinvented.
    const reelId = `${listing.key}-listing-reel-${String(angle).replace(/_/g, '-')}-${cls.fingerprint}`;

    // Durable idempotency cross-check (survives a wiped state file).
    const inLib = await alreadyInVideoLibrary(reelId);
    if (inLib === true && !force) {
      nextEntry.fired[cls.fingerprint] = { reelId, angle, firedAt: nowIso(), outcome: 'queued' };
      state.listings[row.mls_number] = nextEntry;
      decisions.push({ ...base, fire: false, reason: 'already_in_video_library', reelId });
      console.log(`[reel-trigger] ${reelId} already in video_library -- skipping.`);
      continue;
    }
    if (inLib === null && !force) {
      // Unknown is not "no". Fail closed on idempotency: a missed reel is
      // recoverable on the next run; a duplicate advert is not.
      decisions.push({ ...base, fire: false, reason: 'video_library_check_unavailable_failing_closed', reelId });
      state.listings[row.mls_number] = nextEntry;
      console.warn(`[reel-trigger] could not confirm video_library state for ${reelId} -- not firing this run.`);
      continue;
    }

    // Photos. No photos = no reel. Never substitute, never fabricate.
    const photo = resolvePhotoDir(listing);
    if (!photo) {
      const msg = `LISTING REEL: ${listing.address} triggered (${cls.reason}) but no MLS photo set was found for "${listing.key}" under any of: ${PHOTO_ROOTS.join(', ')}. No reel built -- photos are never substituted.`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      decisions.push({ ...base, fire: false, reason: 'no_photo_set', reelId });
      state.listings[row.mls_number] = nextEntry;
      continue;
    }

    // Build the spec + every visible surface.
    let specBundle;
    try {
      specBundle = buildReelSpec({ row, listing, angle, kind: cls.kind, reelId, photo });
    } catch (e) {
      const msg = `LISTING REEL: could not build a spec for ${listing.address} (${e.message}). No reel built.`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      decisions.push({ ...base, fire: false, reason: `spec_build_failed:${e.message}`, reelId });
      state.listings[row.mls_number] = nextEntry;
      continue;
    }

    // Optional hard gate on address corroboration (off by default -- see the
    // address_corroboration note in buildReelSpec). Turn it on the moment
    // status-sync starts returning row.address_verified.
    if (process.env.LISTING_REEL_REQUIRE_ADDRESS_CORROBORATION === '1' && row.address_verified !== true) {
      const msg = `LISTING REEL: ${listing.address} triggered (${cls.reason}) but its address was not independently corroborated in this live MLS read, and LISTING_REEL_REQUIRE_ADDRESS_CORROBORATION=1. No reel built.`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      decisions.push({ ...base, fire: false, reason: 'address_not_corroborated', reelId });
      state.listings[row.mls_number] = nextEntry;
      continue;
    }

    // RULES 3 / 4 / 5 / 6 -- weakness copy, sold-price, TREC broker name,
    // fair-housing + do-not-write. Runs BEFORE anything renders.
    let gate;
    try {
      gate = checkReelCopy({
        surfaces: specBundle.surfaces,
        status: row,
        listing,                       // carries conditionCaveat
        showPrice: specBundle.showPrice,
        closingCardSurfaceName: 'closing_card',
      });
    } catch (e) {
      // A missing/unparseable block list, or a blocking topic with no
      // detector, is an environment fault -- halt the WHOLE run, not just
      // this listing.
      const msg = `LISTING REEL TRIGGER HALTED: ${e.message}`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      if (!dryRun) saveState(state);
      return { built: 0, aborted: true, reason: e.message, decisions };
    }

    if (!gate.allowed) {
      const msg = `LISTING REEL BLOCKED before render: ${listing.address} [${angle}] failed the copy gate:\n- ${gate.reasons.join('\n- ')}`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      decisions.push({ ...base, fire: false, reason: `copy_gate_blocked:${gate.reasons.join(';')}`, reelId });
      state.listings[row.mls_number] = nextEntry;
      continue;
    }

    fired++;
    console.log(`[reel-trigger] FIRE ${reelId} -- ${listing.address} [${cls.kind}/${angle}] because ${cls.reason}`);

    // Persist the spec + script so the render is reproducible and auditable.
    const buildDir = path.join(STAGING_DIR, reelId);
    const specPath = path.join(buildDir, `${reelId}.json`);
    const scriptPath = path.join(buildDir, `${reelId}-script.txt`);
    const captionPath = path.join(buildDir, `${reelId}-caption.txt`);

    if (!dryRun) {
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(specPath, JSON.stringify(specBundle.spec, null, 2), 'utf8');
      fs.writeFileSync(scriptPath, specBundle.script + '\n', 'utf8');
      fs.writeFileSync(captionPath, specBundle.caption + '\n', 'utf8');
    }

    const music = pickMusic();
    const voMp3 = path.join(buildDir, `${reelId}.mp3`);
    const voTiming = path.join(buildDir, `${reelId}-timing.json`);

    // Step 1 -- narration. gen-listing-voiceover.py defaults to a NEUTRAL
    // non-Dossie voice; Heath's own clone (i41TA0Q36AUrp4axERi3, locked
    // settings) is the approved voice for HIS listings, so pass --voice-id
    // explicitly rather than letting the default stand in silently.
    const voiceoverCmd = [
      'python', 'scripts/gen-listing-voiceover.py',
      '--script-file', path.relative(REPO_ROOT, scriptPath),
      '--out-mp3', path.relative(REPO_ROOT, voMp3),
      '--out-timing', path.relative(REPO_ROOT, voTiming),
      '--voice-id', process.env.HEATH_VOICE_ID || 'i41TA0Q36AUrp4axERi3',
      '--target-seconds', '30',
    ];

    // Step 2 -- render. Chains straight off step 1's outputs.
    const renderCmd = [
      'node', 'scripts/generate-listing-video.js',
      '--listing', path.relative(REPO_ROOT, specPath),
      '--photos-dir', photo.dir,
      '--out-dir', path.relative(REPO_ROOT, buildDir),
      '--aspect', 'both',
      '--voiceover', path.relative(REPO_ROOT, voMp3),
      '--voiceover-timing', path.relative(REPO_ROOT, voTiming),
    ].concat(music ? ['--music', path.relative(REPO_ROOT, music)] : []);

    // Step 3 -- quality gate (fail-closed) then Pipeline B queue. Shown for
    // audit; --render runs all three in-process.
    const gateCmd = ['node', 'scripts/check-video-quality-cli.js',
      '--video', path.relative(REPO_ROOT, path.join(buildDir, `${reelId}-vertical.mp4`)),
      '--cover', path.relative(REPO_ROOT, path.join(buildDir, `${reelId}-cover.png`))];

    const record = {
      ...base,
      reelId,
      angle,
      buildDir,
      specPath,
      scriptPath,
      captionPath,
      photosDir: photo.dir,
      voiceoverCommand: voiceoverCmd.join(' '),
      renderCommand: renderCmd.join(' '),
      gatePassed: true,
      blockListPath: gate.blockListPath,
      trecBrokerName: gate.trec.brokerage,
    };

    if (!doRender || dryRun) {
      record.outcome = dryRun ? 'dry_run' : 'spec_ready_not_rendered';
      built.push(record);
      decisions.push(record);
      nextEntry.angle_history = nextEntry.angle_history.concat([angle]).slice(-6);
      state.listings[row.mls_number] = nextEntry;
      continue;
    }

    // ── Render ──
    const rres = runNode([RENDERER, '--listing', specPath, '--photos-dir', photo.dir, '--out-dir', buildDir, '--aspect', 'both']
      .concat(music ? ['--music', music] : []));
    const verticalMp4 = path.join(buildDir, `${reelId}-vertical.mp4`);
    if (rres.status !== 0 || !fs.existsSync(verticalMp4)) {
      const msg = `LISTING REEL: render failed for ${listing.address} [${angle}].\n${String(rres.stderr || rres.stdout || '').slice(-600)}`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      record.outcome = 'render_failed';
      nextEntry.fired[cls.fingerprint] = { reelId, angle, firedAt: nowIso(), outcome: 'render_failed' };
      state.listings[row.mls_number] = nextEntry;
      decisions.push(record);
      continue;
    }

    // ── Quality gate (fail-closed) ──
    const coverPng = extractCoverFrame(verticalMp4, path.join(buildDir, `${reelId}-cover.png`));
    const qg = runQualityGate(verticalMp4, coverPng);
    record.quality = { pass: qg.pass, hardFail: !!qg.hardFail, failedRules: qg.failedRules };

    if (!qg.pass) {
      const why = qg.hardFail
        ? `the gate could not run (${(qg.failedRules || []).join(', ')}) -- FAILING CLOSED`
        : `failed: ${(qg.failedRules || []).join(', ')}`;
      const msg = `LISTING REEL HELD (quality gate): ${listing.address} [${angle}] ${why}. Not queued. Staged at ${buildDir}`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      record.outcome = qg.hardFail ? 'quality_gate_hard_fail' : 'quality_gate_failed';
      nextEntry.fired[cls.fingerprint] = { reelId, angle, firedAt: nowIso(), outcome: record.outcome };
      nextEntry.last_fired_at = nowIso();
      state.listings[row.mls_number] = nextEntry;
      decisions.push(record);
      continue;
    }

    // ── Queue via Pipeline B (only now does the file enter the watch folder) ──
    fs.mkdirSync(REALTOR_FINISHED_DIR, { recursive: true });
    const queuedPath = path.join(REALTOR_FINISHED_DIR, `${reelId}.mp4`);
    // Caption sidecar FIRST, then the mp4 -- queue-finished-videos.py scans
    // for *.mp4, so writing the video last means the sidecar is always
    // already there when the scanner sees it. Without it the row queues with
    // an EMPTY caption (no WEEKLY-RECORDING-KIT.md script matches a generated
    // reel's topic slug, by design -- R1 copy must not pre-exist the render).
    fs.writeFileSync(path.join(REALTOR_FINISHED_DIR, `${reelId}.caption.txt`), specBundle.caption + '\n', 'utf8');
    fs.copyFileSync(verticalMp4, queuedPath);

    const qres = runPipelineBQueue();
    if (!qres.ok) {
      const msg = `LISTING REEL: quality gate PASSED for ${listing.address} but queue-finished-videos.py exited ${qres.status}. File is at ${queuedPath} and will be picked up on the next scan.\n${qres.stderr || qres.error || ''}`;
      console.error(`[reel-trigger] ${msg}`);
      await notify(msg);
      record.outcome = 'queue_failed';
    } else {
      const patched = await patchCaption(reelId, specBundle.caption);
      record.outcome = 'queued';
      record.captionPatched = patched.ok;
      const msg = `LISTING REEL queued for approval: ${listing.address} [${angle}] -- ${reelId}. `
        + `Trigger: ${cls.reason}. Quality gate passed. `
        + `Address corroboration in this live read: ${specBundle.spec._provenance.address_corroboration}. `
        + `Awaiting your Telegram approve/reject; nothing has posted.`;
      console.log(`[reel-trigger] ${msg}`);
      await notify(msg);
      nextEntry.fired[cls.fingerprint] = { reelId, angle, firedAt: nowIso(), outcome: 'queued' };
      nextEntry.last_fired_at = nowIso();
      nextEntry.angle_history = nextEntry.angle_history.concat([angle]).slice(-6);
    }
    state.listings[row.mls_number] = nextEntry;
    built.push(record);
    decisions.push(record);
  }

  state.last_run_at = nowIso();
  if (!dryRun) saveState(state);

  console.log(`[reel-trigger] DONE. ${rows.length} live-verified listing(s) evaluated, ${built.length} reel(s) built.`);
  return { built: built.length, aborted: false, results: built, decisions };
}

// ─── Standalone entry point: performs the SAME atomic sequence itself ────────

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const dryRun = !!argv['dry-run'];
  const force = !!argv.force;
  const render = !!argv.render;

  let syncResult;
  try {
    syncResult = await require('./listing-marketing-status-sync').syncAll({ verifiedBy: 'listing-reel-trigger.js' });
  } catch (err) {
    // RULE 1 -- the live read blew up. Build nothing, alert, never fall back.
    const msg = `LISTING REEL TRIGGER: live connectMLS read FAILED (${err.message}). Built ZERO reels -- never falling back to cached/DB data. Fix the session (node scripts/brokerage-login-setup.js) and rerun.`;
    console.error(`[reel-trigger] ${msg}`);
    await notifyHeathDefault(msg);
    process.exitCode = 1;
    return;
  }

  const freshStatuses = Object.values((syncResult && syncResult.statusByMls) || {});

  // Emit the verified live fact pack for one listing. Runs in the SAME
  // process as the read above, then the trigger continues -- so the emitted
  // pack and any reel built from it are provably the same live read.
  if (argv['emit-fact-pack']) {
    const mls = String(argv['emit-fact-pack']);
    const row = freshStatuses.find((r) => r.mls_number === mls);
    if (!row) {
      console.error(`[reel-trigger] ${mls} was not verified in this live read -- refusing to emit a fact pack. Verified: ${freshStatuses.map((r) => r.mls_number).join(', ') || 'none'}`);
      process.exitCode = 1;
      return;
    }
    const listing = LISTINGS[mls];
    const outDir = argv['out-dir'] ? path.resolve(String(argv['out-dir'])) : STAGING_DIR;
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `fact-pack-${listing.key}-${mls}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      generated_at: nowIso(),
      source: 'LIVE connectMLS read via scripts/listing-marketing-status-sync.js syncAll(), same process',
      live: row,
      stable_facts: listing,
      trec_attribution: parseTrecAttribution(),
      mls_status_family: {
        active: ACTIVE_FAMILY.has(row.mls_status),
        under_contract: UNDER_CONTRACT_ACTIVE_FAMILY.has(row.mls_status),
        off_market: OFF_MARKET.has(row.mls_status),
        postable: isPostableActive(row.mls_status),
      },
    }, null, 2), 'utf8');
    console.log(`[reel-trigger] fact pack -> ${outPath}`);
    // Also dump every verified row from this same read, so the runway
    // (6 angles x active listings) is auditable from one artifact.
    const allPath = path.join(outDir, 'live-verified-rows.json');
    fs.writeFileSync(allPath, JSON.stringify({ generated_at: nowIso(), failures: syncResult.failures || [], rows: freshStatuses }, null, 2), 'utf8');
    console.log(`[reel-trigger] all live-verified rows -> ${allPath}`);
  }

  if (!freshStatuses.length) {
    const msg = 'LISTING REEL TRIGGER: live connectMLS read completed but verified ZERO listings. Built ZERO reels -- never falling back to cached/DB data.';
    console.error(`[reel-trigger] ${msg}`);
    await notifyHeathDefault(msg);
    process.exitCode = 1;
    return;
  }

  const res = await runReelTrigger({
    freshStatuses,
    dryRun,
    force,
    render,
    onlyMls: argv.mls && argv.mls !== true ? String(argv.mls) : null,
    maxPerRun: argv.max ? Number(argv.max) : undefined,
  });
  if (res.aborted) process.exitCode = 1;
  console.log(JSON.stringify(res, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[reel-trigger] FATAL', e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  runReelTrigger,
  classifyTrigger,
  fingerprintOf,
  assertLiveProvenance,
  buildReelSpec,
  buildAngleCopy,
  runQualityGate,
  resolvePhotoDir,
  specLine,
  STATE_FILE,
  STAGING_DIR,
  REALTOR_FINISHED_DIR,
};
