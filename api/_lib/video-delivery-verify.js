'use strict';

// api/_lib/video-delivery-verify.js
//
// Pure, unit-testable helpers for Pipeline B (video_library ->
// cron-post-videos.js -> Zernio) delivery verification.
//
// WHY THIS EXISTS (Carter, 2026-09-17)
// -------------------------------------------------------------------------
// Pipeline A (social_posts -> cron-publish-approved.js -> Zernio) has two
// verification crons covering it: cron-verify-posts.js (missed-window
// retry) and cron-verify-zernio-deliveries.js (confirms actual delivery +
// captures the platform URL). Pipeline B had NEITHER. cron-post-videos.js
// called Zernio, logged the result to the console and a Telegram message,
// and then threw the per-platform zernio_post_id away -- nothing was ever
// persisted to re-check later. A video could sit at status='posted' forever
// having actually failed on every platform and nobody would know.
//
// This module is deliberately free of network/Supabase calls so it can be
// tested without mocking fetch. The crons (cron-post-videos.js writes
// entries at post time; cron-verify-zernio-deliveries.js confirms them
// later) import these functions and do the I/O themselves.
//
// SCHEMA (video_library.zernio_deliveries, jsonb array, one entry/platform):
//   {
//     platform:        'facebook' | 'instagram' | 'tiktok' | ...
//     zernio_post_id:  string | null   -- null means Zernio gave us no id
//                                          to poll (see 'unconfirmable' below)
//     scheduled_for:   iso string | null
//     accepted_at:     iso string      -- when the POST /posts call returned ok
//     status:          'accepted' | 'confirmed' | 'failed' | 'post_rejected'
//     proof_level:     see PROOF_LEVELS below
//     platform_url:    string | null   -- real permalink, captured whenever we have one
//     verified_at:     iso string | null -- when Zernio's GET /posts/:id confirmed delivery
//     error:           string | null
//     alerted_at:      iso string | null -- last time we told Heath about this entry
//   }
//
// PROOF LEVELS -- never claim more than we actually confirmed:
//   'unconfirmed'              -- accepted by Zernio, not yet (or never) confirmed live
//   'zernio_confirmed_no_url'  -- Zernio's own record says delivered, but it
//                                 returned no public URL to independently check
//                                 (e.g. platforms that block logged-out viewing,
//                                 or Zernio simply doesn't expose one for that
//                                 platform). This is real proof -- Zernio's
//                                 system of record -- just not a URL a human
//                                 can click and confirm.
//   'zernio_confirmed_live_url' -- Zernio confirmed delivery AND gave a URL.
const PROOF_LEVELS = Object.freeze({
  UNCONFIRMED: 'unconfirmed',
  CONFIRMED_NO_URL: 'zernio_confirmed_no_url',
  CONFIRMED_LIVE_URL: 'zernio_confirmed_live_url',
});

// How long to wait after acceptance before an unresolved entry is worth
// bothering Heath about. Generous window -- video processing (esp. TikTok/
// YouTube transcode) can legitimately take a while; this is a "this looks
// dead" threshold, not a "this is late" one.
const DEFAULT_STALE_WINDOW_MS = 3 * 60 * 60 * 1000; // 3h

// Decide the honest proof level for a Zernio delivery-status check result.
// isLive / platformUrl come straight from checkZernioDeliveryStatus()'s
// { is_live, platform_url } — never invent a URL, never call something
// confirmed that Zernio hasn't actually reported as live.
function proofLevelFor({ isLive, platformUrl }) {
  if (!isLive) return PROOF_LEVELS.UNCONFIRMED;
  return platformUrl ? PROOF_LEVELS.CONFIRMED_LIVE_URL : PROOF_LEVELS.CONFIRMED_NO_URL;
}

// Build the entry recorded at post time (before any verification pass has
// run). `postResult` is whatever postToZernio() returned for this platform.
function buildDeliveryEntry({ platform, scheduledFor, postResult, nowIso }) {
  const now = nowIso || new Date().toISOString();
  if (!postResult || postResult.ok !== true) {
    return {
      platform,
      zernio_post_id: null,
      scheduled_for: scheduledFor || null,
      accepted_at: now,
      status: 'post_rejected',
      proof_level: PROOF_LEVELS.UNCONFIRMED,
      platform_url: null,
      verified_at: null,
      error: (postResult && postResult.error) || 'post failed',
      alerted_at: null,
    };
  }
  return {
    platform,
    zernio_post_id: postResult.zernio_post_id || null,
    scheduled_for: scheduledFor || null,
    accepted_at: now,
    // A 2xx with no post id is exactly as unconfirmable as a hard failure
    // for verification purposes — there is no id to poll — but it is not a
    // rejection, so keep the distinct label postToZernio already uses.
    status: postResult.unverified ? 'accepted_unverified' : 'accepted',
    proof_level: PROOF_LEVELS.UNCONFIRMED,
    // Record a URL immediately if Zernio happened to hand one back on the
    // accept call itself (some platform/response shapes do) — no need to
    // wait for the separate verify pass just because we usually have to.
    platform_url: postResult.platform_url || null,
    verified_at: null,
    error: null,
    alerted_at: null,
  };
}

// Merge freshly-built entries into an existing zernio_deliveries array,
// replacing any prior entry for the same platform. Pure — returns a new
// array, never mutates the input.
function mergeDeliveryEntries(existing, freshEntries) {
  const byPlatform = new Map((Array.isArray(existing) ? existing : []).map((e) => [e.platform, e]));
  for (const entry of freshEntries) {
    byPlatform.set(entry.platform, entry);
  }
  return Array.from(byPlatform.values());
}

// Patch a single entry within a zernio_deliveries array by platform. Pure.
function patchDeliveryEntry(deliveries, platform, patch) {
  return (Array.isArray(deliveries) ? deliveries : []).map((e) => (
    e.platform === platform ? { ...e, ...patch } : e
  ));
}

// True when an entry has gone unconfirmed for longer than the stale window
// and hasn't already been alerted on. Used both for "no zernio_post_id to
// poll" and "Zernio still says processing" cases.
function isDueForStaleAlert({ entry, nowIso, windowMs = DEFAULT_STALE_WINDOW_MS }) {
  if (!entry) return false;
  if (entry.verified_at) return false; // already confirmed — nothing to alert
  if (entry.status === 'failed') return false; // failures alert immediately elsewhere, not via staleness
  if (entry.alerted_at) return false; // already told Heath once — don't repeat every 30 min
  const acceptedAt = entry.accepted_at ? Date.parse(entry.accepted_at) : NaN;
  if (Number.isNaN(acceptedAt)) return false;
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  return (now - acceptedAt) >= windowMs;
}

// Entries that still need a Zernio check this run: have a zernio_post_id,
// no verified_at yet, and aren't already marked failed.
function entriesNeedingCheck(deliveries) {
  return (Array.isArray(deliveries) ? deliveries : []).filter(
    (e) => e && e.zernio_post_id && !e.verified_at && e.status !== 'failed',
  );
}

// Entries that were accepted with no zernio_post_id at all — Zernio gave us
// nothing to poll, so these can only ever be resolved by staleness alerting
// or a human checking the platform directly.
function entriesUnconfirmable(deliveries) {
  return (Array.isArray(deliveries) ? deliveries : []).filter(
    (e) => e && !e.zernio_post_id && !e.verified_at && e.status !== 'failed',
  );
}

module.exports = {
  PROOF_LEVELS,
  DEFAULT_STALE_WINDOW_MS,
  proofLevelFor,
  buildDeliveryEntry,
  mergeDeliveryEntries,
  patchDeliveryEntry,
  isDueForStaleAlert,
  entriesNeedingCheck,
  entriesUnconfirmable,
};
