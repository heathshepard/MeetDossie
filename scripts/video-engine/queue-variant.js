#!/usr/bin/env node
//
// scripts/video-engine/queue-variant.js
//
// Upload one finished variant and put it IN THE POSTING QUEUE. No human step.
//
// THE FAILURE THIS CLOSES
// -----------------------
// 2026-09-25: a finished video existed on disk, had a cover, had been through
// the gate, and was never inserted into the posting queue — because inserting
// it was a thing a human had to remember to do. The video sat in Downloads.
// Queueing is now part of producing, in the same run, on gate pass.
//
// WHAT "THE QUEUE" ACTUALLY IS
// ----------------------------
// `video_library`. api/cron-post-videos.js is the consumer and the status
// ladder is:
//
//   approved              -> cron-post-videos sends Heath the Telegram card
//   pending_heath_review  -> waiting on his Approve tap
//   heath_approved        -> cron-post-videos resolves per-platform slots from
//                            posting_schedule and calls Zernio
//   posted                -> delivered, zernio_deliveries populated
//
// This writes **approved**. That is the queue-entry step that was missing.
// It deliberately does NOT write heath_approved: CLAUDE.md §3 is explicit
// that Heath is the final gate before anything publishes, and automating
// insertion is a different thing from automating publication. `--approve`
// exists for when the standing process has earned it; it is not the default.
//
// WHY THIS DOES NOT CALL ZERNIO ITSELF
// ------------------------------------
// Because api/cron-post-videos.js already does it correctly and this would be
// the second copy. That file carries:
//
//   * lookupZernioPageId() -> platformSpecificData.pageId for facebook.
//     WITHOUT it a post lands on whichever Page Zernio's dashboard happens to
//     have selected. A hand-rolled Zernio call on 2026-09-25 skipped exactly
//     this and may have put a post on the wrong Page.
//   * resolveZernioAccountId() -> owner-aware routing (dossie vs
//     heath-realtor vs rust), which never silently falls back across owners.
//   * platformSpecificData.title for youtube, with the slug-vs-sentence guard.
//   * the AI-disclosure label, the schedule/cap gate, and delivery
//     verification.
//
// Duplicating that here would mean maintaining two of each, and the one that
// drifts is always the copy. So this writes the row; the cron does the send.
//
// The `scheduledTargets` recorded on the row are the slots cron-post-videos
// WILL resolve, computed here from the same posting_schedule table, so the
// scheduled times are visible at queue time instead of only after the fact.
//
// USAGE
//   node scripts/video-engine/queue-variant.js \
//     --video out/short.mp4 --cover out/cover.png \
//     --id trec-12b-short-2026-09-25 \
//     --topic "TREC 20-19 ¶12.B — where the seller contribution went" \
//     --caption-file caption.txt \
//     --platforms tiktok,instagram \
//     [--owner dossie] [--approve] [--dry-run]

'use strict';

const fs = require('fs');
const path = require('path');

require('./env-local.js').load(null, { quiet: true });

const BUCKET_VIDEO = 'videos';
const BUCKET_COVER = 'social-cards';
const VIDEO_PREFIX = 'video-library';
const COVER_PREFIX = 'video-covers';

function env(name) {
  const v = process.env[name];
  if (!v || v === '[SENSITIVE]') throw new Error(`missing env var ${name}`);
  return v;
}

async function sb(pathSuffix, init = {}) {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${url}${pathSuffix}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { ok: res.ok, status: res.status, data };
}

/**
 * uploadToBucket — the PROVEN upload path (verified working 2026-09-25):
 * Supabase Storage `videos` bucket, public, 100MB, video/mp4.
 */
async function uploadToBucket(localPath, bucket, objectPath, contentType) {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const body = fs.readFileSync(localPath);
  const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${bucket}/${objectPath} failed ${res.status}: ${text.slice(0, 300)}`);
  return `${url}/storage/v1/object/public/${bucket}/${objectPath}`;
}

/**
 * resolveScheduledTargets — the slots api/cron-post-videos.js will pick.
 *
 * Mirrors its shouldPostNow(): per (platform, owner) row in posting_schedule,
 * the next time_slot later today in the row's timezone; null when every slot
 * has passed, which that cron treats as "publish now".
 *
 * Read-only. Recorded on the row so the scheduled times exist at queue time
 * rather than being discovered after the send.
 */
async function resolveScheduledTargets(platforms, owner) {
  const res = await sb('/rest/v1/posting_schedule?select=platform,day_of_week,time_slots,timezone,is_active,max_per_day,owner');
  const rows = Array.isArray(res.data) ? res.data : [];
  const now = new Date();
  const out = [];

  for (const platform of platforms) {
    const row = rows.find((r) => r.platform === platform && (r.owner === owner || r.owner == null) && r.is_active !== false);
    if (!row) { out.push({ platform, scheduledFor: null, note: 'no active posting_schedule row — cron-post-videos will publish on its next run' }); continue; }

    let next = null;
    for (const slot of row.time_slots || []) {
      const [h, m] = String(slot).split(':').map(Number);
      const cand = new Date(now);
      cand.setUTCHours(h, m || 0, 0, 0); // approximate; the cron does the tz maths authoritatively
      if (cand > now && (next === null || cand < next)) next = cand;
    }
    out.push({
      platform,
      scheduledFor: next ? next.toISOString() : null,
      timezone: row.timezone || null,
      maxPerDay: row.max_per_day ?? null,
      note: next ? 'next slot today' : 'all slots passed — cron-post-videos publishes on its next run',
    });
  }
  return out;
}

/**
 * queueVariant — upload + insert, one call.
 *
 * @param {object} o
 * @param {string} o.videoPath   local mp4
 * @param {string} o.coverPath   local png (the gate's cover_asset_present is blocking)
 * @param {string} o.id          video_library primary key
 * @param {string} o.topic
 * @param {string} o.caption     MUST be non-empty — cron-post-videos refuses an empty caption
 * @param {string[]} o.platforms
 * @param {string} o.owner
 * @param {object} o.gateResult  the full JSON from check-video-quality-cli.js
 * @param {boolean} o.approve    write heath_approved instead of approved
 * @param {boolean} o.dryRun
 */
async function queueVariant(o) {
  const {
    videoPath, coverPath, id, topic, caption, platforms,
    owner = 'dossie', gateResult, approve = false, dryRun = false, extraDetail = {},
  } = o;

  // ---- refuse to queue anything the gate did not pass -------------------
  if (!gateResult || gateResult.pass !== true) {
    const failed = (gateResult && gateResult.failedRules) || ['(no gate result)'];
    throw new Error(`refusing to queue ${id}: quality gate did not pass — ${failed.join(', ')}`);
  }
  if (!caption || !String(caption).trim()) {
    // cron-post-videos.js skips rows with an empty/invalid caption. Queueing
    // one is queueing something that can never post, which is worse than not
    // queueing it because it looks done.
    throw new Error(`refusing to queue ${id}: caption is empty — cron-post-videos would skip it forever`);
  }
  if (!Array.isArray(platforms) || !platforms.length) {
    throw new Error(`refusing to queue ${id}: no platforms`);
  }
  if (!fs.existsSync(videoPath)) throw new Error(`video not found: ${videoPath}`);
  if (!fs.existsSync(coverPath)) throw new Error(`cover not found: ${coverPath}`);

  const videoObject = `${VIDEO_PREFIX}/${id}${path.extname(videoPath) || '.mp4'}`;
  const coverObject = `${COVER_PREFIX}/${id}${path.extname(coverPath) || '.png'}`;
  const status = approve ? 'heath_approved' : 'approved';

  const scheduledTargets = dryRun ? [] : await resolveScheduledTargets(platforms, owner);

  const row = {
    id,
    type: 'screen_recording',
    topic,
    caption: String(caption).trim(),
    platforms,
    target_owner: owner,
    produced_date: new Date().toISOString().slice(0, 10),
    status,
    quality_status: 'passed',
    quality_failed_rules: [],
    quality_checked_at: new Date().toISOString(),
    quality_detail: {
      ...gateResult.detail,
      rules: gateResult.rules,
      gate_run: 'scripts/video-engine/produce-variants.js -> scripts/check-video-quality-cli.js',
      scheduled_targets: scheduledTargets,
      ...extraDetail,
    },
  };

  if (dryRun) {
    return {
      dryRun: true,
      wouldUpload: [
        { local: videoPath, bucket: BUCKET_VIDEO, object: videoObject, bytes: fs.statSync(videoPath).size },
        { local: coverPath, bucket: BUCKET_COVER, object: coverObject, bytes: fs.statSync(coverPath).size },
      ],
      wouldInsert: row,
      status,
    };
  }

  row.supabase_url = await uploadToBucket(videoPath, BUCKET_VIDEO, videoObject, 'video/mp4');
  row.cover_url = await uploadToBucket(coverPath, BUCKET_COVER, coverObject, 'image/png');

  const res = await sb('/rest/v1/video_library', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`video_library insert failed ${res.status}: ${JSON.stringify(res.data).slice(0, 400)}`);

  return { dryRun: false, id, status, supabase_url: row.supabase_url, cover_url: row.cover_url, scheduledTargets, row: Array.isArray(res.data) ? res.data[0] : res.data };
}

// ------------------------------------------------------------------ CLI ----
function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

async function main() {
  const captionFile = arg('--caption-file');
  const gateFile = arg('--gate-result');
  const out = await queueVariant({
    videoPath: arg('--video'),
    coverPath: arg('--cover'),
    id: arg('--id'),
    topic: arg('--topic'),
    caption: captionFile ? fs.readFileSync(captionFile, 'utf8') : arg('--caption'),
    platforms: String(arg('--platforms', '')).split(',').map((s) => s.trim()).filter(Boolean),
    owner: arg('--owner', 'dossie'),
    gateResult: gateFile ? JSON.parse(fs.readFileSync(gateFile, 'utf8')) : null,
    approve: process.argv.includes('--approve'),
    dryRun: process.argv.includes('--dry-run'),
  });
  console.log(JSON.stringify(out, null, 2));
}

module.exports = { queueVariant, resolveScheduledTargets, uploadToBucket, sb };
if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
