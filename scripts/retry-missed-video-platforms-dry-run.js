#!/usr/bin/env node
'use strict';

// scripts/retry-missed-video-platforms-dry-run.js
//
// DRY RUN ONLY. Never calls Zernio's POST /posts. Never writes to
// video_library. Prints exactly what a real retry pass would re-post, and
// nothing more, so Heath can review before anything is built to actually
// fire it.
//
// WHY THIS EXISTS (Atlas, 2026-09-30 — video partial-delivery investigation)
// -------------------------------------------------------------------------
// Measured live against video_library: rows targeting multiple platforms in
// a single row (dossie_trec_p12b_contribution-dossie-multi,
// dossie_trec_p8_disclosure-dossie-multi, dossie-trec-p22-addenda-resort-
// heath-2026-09-29, dossie_trec_p8_disclosure-dossie-catchup, and others)
// were marked status='posted' with zernio_deliveries covering only SOME of
// their targeted platforms — the rest were gated out by an already-
// exhausted daily cap (shared with the text/carousel pipeline,
// api/cron-publish-approved.js) or by Twitter's posting_schedule row being
// permanently inactive for every owner except 'rust', and left NO record on
// the row at all. See api/_lib/video-delivery-verify.js's buildSkipEntry()
// and the 20260930e_video_library_posted_partial_status.sql migration —
// those fix it GOING FORWARD (new rows land in 'posted_partial' with an
// explicit gate_skipped entry per missed platform). This script finds the
// BACKLOG of rows that predate that fix, where a missed platform is only
// detectable as "platform in video_library.platforms with NO corresponding
// entry in video_library.zernio_deliveries at all."
//
// RETRY SAFETY (memory feedback_never-retry-an-unverified-send.md — a send
// reporting failure may have actually gone out; one retry once triple-
// texted a real client):
//
//   - "Never attempted" platforms (no zernio_deliveries entry whatsoever)
//     are the ONLY ones this script marks RETRY_ELIGIBLE. The absence proof
//     here is a CODE-LEVEL guarantee, not a live Zernio query: every single
//     platform cron-post-videos.js actually calls postToZernio() for gets a
//     buildDeliveryEntry() merged into zernio_deliveries in the SAME code
//     path, unconditionally, whether that call succeeded, failed, or came
//     back unverified (see buildDeliveryEntry() — every branch returns an
//     entry). There is no route in that file from "we called Zernio for
//     this platform" to "no entry exists for it." An absent entry is
//     therefore proof the call was never made at all, not an ambiguous or
//     lost result. Flagged in the report as INFERRED-BY-CODE-REVIEW, not
//     MEASURED, because this script does not (and today cannot — Zernio's
//     API in this codebase only exposes GET /posts/:id, never a "list posts
//     for this account/date range" endpoint) independently re-verify
//     against Zernio's own records.
//   - Any platform that DOES have an entry but with status 'post_rejected'
//     or 'failed' (Zernio WAS called and the result is ambiguous/negative)
//     is marked NEEDS_VERIFICATION, never RETRY_ELIGIBLE — this script
//     takes no position on whether those actually posted or not.
//   - This script performs NO writes, NO Zernio calls, and is safe to run
//     repeatedly. Firing an actual retry is a SEPARATE, not-yet-built step
//     Heath must explicitly authorize.
//
// Usage: node scripts/retry-missed-video-platforms-dry-run.js [--json]
//
// Auth: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read-only queries only).

const fs = require('fs');
const path = require('path');

// Load .env.local the same way every other local script in this repo does
// (CLAUDE.md §15's approved local-curl pattern needs real env vars; this
// repo's .env.local carries a leading BOM per env-local-bom-breaks-first-
// var.md, stripped below).
function loadEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  let text = fs.readFileSync(envPath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\r$/, '');
  }
}
loadEnvLocal();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseFetch(pathSuffix) {
  const res = await fetch(`${SUPABASE_URL}${pathSuffix}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Real attempt = any status other than a status this script itself never
// invents. ANY entry at all (accepted, accepted_unverified, confirmed,
// confirmed_no_url, post_rejected, failed, gate_skipped) means
// cron-post-videos.js at least resolved a decision for that platform — only
// a TOTALLY ABSENT entry means "never even gated, upstream of any record."
// (In practice every gate-skip going forward writes a 'gate_skipped' entry
// too — see buildSkipEntry() — so this script's RETRY_ELIGIBLE bucket is
// specifically the pre-fix backlog that has no entry of any kind.)
// UNTRACKED_LEGACY handling (Atlas 2026-09-30 — caught by this script's own
// dry run against live data). api/_lib/video-delivery-verify.js's own file
// header dates Pipeline B's delivery-tracking to 2026-09-17: "Pipeline B had
// NEITHER [verification cron]... a video could sit at status='posted'
// forever having actually failed on every platform and nobody would know."
// Measured live: EVERY video_library row with posted_date <= 2026-09-16 has
// zernio_deliveries = [] (empty array) for its ENTIRE platforms list, not
// just some — including rows from May 2026, long stable in production. That
// pattern means "this row predates delivery-tracking entirely," not "every
// platform on it silently failed." Treating an empty-array row as N
// platform-level misses would have made this script recommend retrying
// ~40 platform-slots across 23 rows going back to May, almost certainly
// videos that already posted successfully and simply have no record of it.
// A row only enters the real RETRY_ELIGIBLE bucket below if its
// zernio_deliveries array is non-empty (proving cron-post-videos.js's
// tracking-aware code path actually ran on it) AND a specific targeted
// platform is still missing from that non-empty array.
function classifyRow(deliveries) {
  return Array.isArray(deliveries) && deliveries.length > 0;
}

function classifyPlatform(platform, deliveries) {
  const entry = (deliveries || []).find((e) => e && e.platform === platform);
  if (!entry) return { status: 'RETRY_ELIGIBLE', reason: 'row has delivery-tracking data for other platforms, but none for this one — never reached postToZernio()' };
  if (entry.status === 'gate_skipped') return { status: 'RETRY_ELIGIBLE', reason: `explicitly gate-skipped: ${entry.error || 'no reason recorded'}` };
  if (entry.status === 'post_rejected' || entry.status === 'failed') {
    return { status: 'NEEDS_VERIFICATION', reason: `Zernio WAS called and result was ${entry.status} (${entry.error || 'no error text'}) — cannot assume absence without a live Zernio check; do not retry blind` };
  }
  // accepted / accepted_unverified / confirmed / confirmed_no_url — a real
  // attempt exists and it looks like it worked or is still resolving.
  return { status: 'ALREADY_DELIVERED_OR_PENDING', reason: `entry status='${entry.status}'${entry.platform_url ? ` (${entry.platform_url})` : ''}` };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — check .env.local');
    process.exit(1);
  }

  const { data, ok } = await supabaseFetch(
    '/rest/v1/video_library?status=in.(posted,posted_partial)'
    + '&select=id,topic,target_owner,platforms,zernio_deliveries,posted_date,caption,supabase_url'
    + '&order=posted_date.desc&limit=500',
  );
  if (!ok || !Array.isArray(data)) {
    console.error('Failed to query video_library:', data);
    process.exit(1);
  }

  const rows = [];
  const untrackedLegacy = [];
  for (const row of data) {
    if (!Array.isArray(row.platforms) || row.platforms.length === 0) continue;
    const deliveries = Array.isArray(row.zernio_deliveries) ? row.zernio_deliveries : [];

    if (!classifyRow(deliveries)) {
      // Predates delivery-tracking (see UNTRACKED_LEGACY comment above) —
      // cannot tell miss from untracked success. Reported separately,
      // EXCLUDED from retry totals.
      untrackedLegacy.push({ id: row.id, posted_date: row.posted_date, targeted_platforms: row.platforms });
      continue;
    }

    const perPlatform = row.platforms.map((p) => ({ platform: p, ...classifyPlatform(p, deliveries) }));
    const retryEligible = perPlatform.filter((p) => p.status === 'RETRY_ELIGIBLE');
    const needsVerification = perPlatform.filter((p) => p.status === 'NEEDS_VERIFICATION');
    if (retryEligible.length === 0 && needsVerification.length === 0) continue; // fully accounted for, skip
    rows.push({
      id: row.id,
      topic: row.topic,
      target_owner: row.target_owner || 'dossie',
      posted_date: row.posted_date,
      supabase_url: row.supabase_url,
      caption_preview: (row.caption || '').slice(0, 80),
      targeted_platforms: row.platforms,
      retry_eligible: retryEligible,
      needs_verification: needsVerification,
      already_delivered_or_pending: perPlatform.filter((p) => p.status === 'ALREADY_DELIVERED_OR_PENDING'),
    });
  }

  const asJson = process.argv.includes('--json');
  if (asJson) {
    console.log(JSON.stringify({ generated_at: new Date().toISOString(), dry_run: true, rows, untracked_legacy_excluded: untrackedLegacy }, null, 2));
    return;
  }

  console.log('=== DRY RUN — video partial-delivery retry candidates ===');
  console.log('NO Zernio calls made. NO video_library writes. Read-only against live data.\n');
  console.log(`Scanned video_library status in (posted, posted_partial): found ${data.length} row(s) total.`);
  console.log(`  ${untrackedLegacy.length} row(s) predate delivery-tracking (posted_date <= 2026-09-16, zernio_deliveries=[]) — EXCLUDED, cannot distinguish miss from untracked success.`);
  console.log(`  ${rows.length} row(s) have delivery-tracking data AND a real gap worth reporting.\n`);

  let totalRetryEligible = 0;
  let totalNeedsVerification = 0;

  for (const r of rows) {
    console.log(`--- ${r.id} [${r.target_owner}] ---`);
    console.log(`    topic: ${r.topic || '(none)'}`);
    console.log(`    posted_date: ${r.posted_date}`);
    console.log(`    targeted: [${r.targeted_platforms.join(', ')}]`);
    if (r.retry_eligible.length) {
      totalRetryEligible += r.retry_eligible.length;
      console.log(`    RETRY_ELIGIBLE (${r.retry_eligible.length}): would re-post to ${r.retry_eligible.map((p) => p.platform).join(', ')}`);
      for (const p of r.retry_eligible) console.log(`        - ${p.platform}: ${p.reason}`);
    }
    if (r.needs_verification.length) {
      totalNeedsVerification += r.needs_verification.length;
      console.log(`    NEEDS_VERIFICATION (${r.needs_verification.length}) — NOT retry-eligible without a live Zernio check:`);
      for (const p of r.needs_verification) console.log(`        - ${p.platform}: ${p.reason}`);
    }
    console.log('');
  }

  console.log('=== SUMMARY ===');
  console.log(`Rows with a real, tracking-confirmed gap: ${rows.length}`);
  console.log(`Platform-slots RETRY_ELIGIBLE (would re-post if authorized): ${totalRetryEligible}`);
  console.log(`Platform-slots NEEDS_VERIFICATION (flagged, not retried): ${totalNeedsVerification}`);
  console.log(`Rows EXCLUDED as untracked legacy (predate 2026-09-17 tracking, not counted above): ${untrackedLegacy.length}`);
  console.log('\nNothing was posted. This script only reports. Firing a real retry is a separate, not-yet-built, Heath-authorized step.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
