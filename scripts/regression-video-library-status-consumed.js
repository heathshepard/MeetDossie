#!/usr/bin/env node
'use strict';

/**
 * Regression test: every video_library row a producer INSERTS must land on
 * a status that at least one consumer actually SELECTs (or an explicitly
 * documented exception) — same shape as
 * scripts/regression-telegram-gate-approval-jobs-allowlisted.js's approval-
 * job scan.
 *
 * THE FAILURE (why this test exists)
 * -----------------------------------
 * On 2026-09-18, activation-forensics review found FOUR gate-passed
 * video_library rows sitting unnotified for up to two days:
 *   - realtor-r1-23-nopalito-shortform-2026-09-16  (pending_heath_review)
 *   - dossie-d1-cap7-2026-09-17                    (pending_heath_review)
 *   - dossie-d1-ask-deadline-mobile-2026-09-16     (pending_heath_review)
 *   - feature-demo-morning-brief-desktop-2026-09-17 (ready)
 * The table had FOUR different pre-approval statuses in play at once
 * (ready / pending_approval / pending_heath_review / approved) because
 * different producers were never reconciled against what
 * api/cron-post-videos.js's approval cron actually SELECTs. Each drift was
 * found by a human reading code, one at a time — exactly the failure mode
 * scripts/regression-telegram-gate-approval-jobs-allowlisted.js's header
 * describes for the sibling telegram-gate incident.
 *
 * THE FIX
 * -------
 * 'approved' is now the ONE canonical status every ingestion producer
 * writes on a quality-gate pass (see api/cron-post-videos.js's "REVIEW GATE
 * FLOW" comment for the full chain). This test scans every producer file
 * (anything that POSTs/upserts a NEW row into video_library) for the
 * literal status string(s) it can write, and every consumer file (anything
 * that reads video_library filtered by status) for the literal status
 * string(s) it selects. Any producer-written status that is neither
 * selected by a consumer nor in the explicit KNOWN_EXCEPTIONS allowlist
 * below (with a real reason) fails the build.
 *
 * This is a pure static-source scan: zero network access, zero production
 * access, zero mocking required.
 *
 * Run manually:
 *   node scripts/regression-video-library-status-consumed.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SCAN_DIRS = ['api', 'scripts'];

// Statuses a producer legitimately writes that are NOT picked up by a
// status=eq./status=in. consumer query, each with a real, checked reason —
// not a rubber stamp. Any NEW unlisted orphan still fails the build.
const KNOWN_EXCEPTIONS = {
  draft: {
    writer: 'scripts/generate-talking-head-video.js',
    reason: "Ledger-only row for the talking-head pipeline (scripts/TALKING-HEAD-WORKFLOW.md step 5) -- "
      + 'Heath is notified directly by a plain (no-button) Telegram video send in the SAME script at insert '
      + 'time, not by any later cron reading video_library.status. Distinct from the queue-finished-videos.py '
      + "Pipeline B chain this test otherwise guards. KNOWN GAP (not fixed here): nothing ever advances a "
      + "'draft' row automatically -- flagged to Heath in the 2026-09-18 status-unification report, left "
      + 'as-is pending an explicit decision rather than silently changed.',
  },
};

function listFilesRecursive(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, exts));
    } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

// Every quoted string literal found in the RHS of a `status: ...` /
// `"status": ...` assignment, up to the next top-level comma or closing
// brace. Captures both plain ('approved') and ternary
// (cond ? 'approved' : 'quality_hold') shapes in one pass.
// Negative lookbehind excludes a DIFFERENT column that merely ends in
// "status" (quality_status, render_status, etc.) — without it,
// `quality_status: qualityPassed ? 'approved' : 'quality_hold'` would
// falsely attribute 'quality_hold' as a SECOND, ambiguous video_library
// `status` value when it is really the unrelated quality_status column.
// RHS capture stops at a newline/semicolon too, not just `,`/`}` — a
// single-line `console.log('  status: ' + sj.status)` (no object-literal
// key at all, just the substring "status: " inside a log message)
// otherwise lets the unbounded capture run on for several unrelated lines
// and pick up whatever quoted string happens to appear next.
const STATUS_RHS_RE = /(?<![\w])["']?status["']?\s*:\s*([^,}\n;]+)/g;
const STRING_LITERAL_RE = /['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;

// A call into a DIFFERENT table's own PATCH/update helper wrapping this
// specific `status:` match -- i.e. some OTHER table's row is being built
// right there instead, even though the file overall (and even a wider
// window around this match) is a genuine video_library producer. Add to
// this list as other multi-table producer files (like
// scripts/produce-skits.py, which also PATCHes skit_queue via
// patch_skit_queue() in the same file/function as its video_library writer
// call two statements later) come up.
const OTHER_TABLE_CALL_MARKERS = ['patch_skit_queue('];
const DISAMBIGUATION_WINDOW_CHARS = 120;

function extractWrittenStatuses(source) {
  const found = new Set();
  let m;
  STATUS_RHS_RE.lastIndex = 0;
  while ((m = STATUS_RHS_RE.exec(source))) {
    // Disambiguate against a sibling table's own PATCH call wrapping this
    // SPECIFIC match in a tight preceding window -- a much narrower/more
    // precise signal than "some other table is mentioned nearby", which
    // would itself false-positive against an unrelated function whose NAME
    // merely contains 'video_library' as a substring (e.g. Python's
    // _register_video_library_with_caption() a few statements later).
    const winStart = Math.max(0, m.index - DISAMBIGUATION_WINDOW_CHARS);
    const precedingWindow = source.slice(winStart, m.index);
    const wrappedByOtherTableCall = OTHER_TABLE_CALL_MARKERS.some((t) => precedingWindow.includes(t));
    if (wrappedByOtherTableCall) continue;

    const rhs = m[1];
    let sm;
    STRING_LITERAL_RE.lastIndex = 0;
    while ((sm = STRING_LITERAL_RE.exec(rhs))) {
      found.add(sm[1]);
    }
  }
  return found;
}

// `status=eq.<value>` and `status=in.(a,b,c)` against a video_library
// PostgREST query — scoped to lines that also mention video_library so an
// unrelated table's status filter (social_posts, comment_opportunities,
// etc.) is never counted as "consuming" a video_library status.
const EQ_RE = /status=eq\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
const IN_RE = /status=in\.\(([a-zA-Z0-9_,]+)\)/g;

function extractConsumedStatuses(source) {
  const found = new Set();
  for (const line of source.split('\n')) {
    if (!line.includes('video_library')) continue;
    let m;
    EQ_RE.lastIndex = 0;
    while ((m = EQ_RE.exec(line))) found.add(m[1]);
    IN_RE.lastIndex = 0;
    while ((m = IN_RE.exec(line))) {
      for (const v of m[1].split(',')) found.add(v.trim());
    }
  }
  return found;
}

(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  const jsFiles = SCAN_DIRS.flatMap((d) => listFilesRecursive(path.join(REPO, d), ['.js']));
  const pyFiles = SCAN_DIRS.flatMap((d) => listFilesRecursive(path.join(REPO, d), ['.py']));
  const allFiles = [...jsFiles, ...pyFiles].filter((f) => !path.basename(f).startsWith('regression-'));

  // Producers: files that POST/upsert a NEW row into video_library
  // (on_conflict=id or a bare POST) -- NOT files that only PATCH an
  // existing row as part of the approval lifecycle (cron-post-videos.js,
  // api/_lib/verify-video-quality.js, api/cron-video-approval.js's
  // skit_queue-only Part 2). Those lifecycle transitions are intentional
  // and reviewed separately -- this test is about INGESTION-TIME status
  // choices only. api/telegram-webhook.js is a special case: it is ONE
  // giant multi-table callback handler, so function-level block scoping
  // alone is not tight enough (a 'method: POST' sendMessage call ten
  // branches away from a video_library PATCH would otherwise false-match).
  // A NEARBY-LINE window inside each function block is the real signal:
  // the POST/on_conflict marker must appear within POST_PROXIMITY_LINES of
  // the specific video_library reference, not just somewhere in the same
  // (possibly huge) block.
  const ON_CONFLICT_RE = /\/rest\/v1\/video_library\?on_conflict=id/;
  const POST_METHOD_RE = /method:\s*['"]POST['"]/;
  const VIDEO_LIBRARY_URL_RE = /rest\/v1\/video_library/;
  // Tight on purpose: a real producer's `method: 'POST'` sits within 1-2
  // lines of its video_library reference in every producer in this repo
  // (same fetch() options object). 4 was chosen over a looser value after
  // it produced a real false positive: api/cron-weekly-content-
  // scheduler.js's READ-ONLY video_library inventory query sat ~10 lines
  // above an unrelated sendTelegram() POST call and was wrongly flagged a
  // producer at that distance.
  const POST_PROXIMITY_LINES = 4;

  /** @type {Map<string, {status: string, files: string[]}>} */
  const writtenByStatus = new Map();
  const producerFiles = [];

  for (const file of allFiles) {
    const rel = path.relative(REPO, file);
    const source = fs.readFileSync(file, 'utf8');
    if (!VIDEO_LIBRARY_URL_RE.test(source)) continue;

    // Pure file-level line-proximity scan (no function-block scoping): a
    // giant multi-table handler like api/telegram-webhook.js has ONE
    // function spanning nearly the whole file, so block-scoping alone
    // isn't tight enough -- an unrelated 'method: POST' Telegram send ten
    // branches away from a video_library PATCH would otherwise false-match
    // if the whole block were scanned. A real POST/on_conflict marker must
    // sit within POST_PROXIMITY_LINES of the SPECIFIC video_library
    // reference, and only that local window's 'status:' literals count.
    const lines = source.split('\n');
    let isProducer = false;

    for (let i = 0; i < lines.length; i += 1) {
      const onConflictHere = ON_CONFLICT_RE.test(lines[i]);
      if (!lines[i].includes('video_library') && !onConflictHere) continue;

      const windowStart = Math.max(0, i - POST_PROXIMITY_LINES);
      const windowEnd = Math.min(lines.length, i + POST_PROXIMITY_LINES);
      const window = lines.slice(windowStart, windowEnd).join('\n');
      if (!onConflictHere && !POST_METHOD_RE.test(window)) continue;

      isProducer = true;
    }

    if (!isProducer) continue;
    producerFiles.push(rel);

    // Extraction scope: a producing call site's `row`/body object is very
    // often built a few statements EARLIER in a DIFFERENT function than
    // the one issuing the actual fetch() (e.g. scripts/feature-demo-
    // publish.js's `publish()` builds `row` with a `status:` ternary, then
    // passes it to a separate `upsertVideoLibrary(row)` that does the
    // fetch) -- real call-graph tracing is out of scope for a static
    // regex scan. Once a file is confirmed a genuine video_library
    // producer by the tight per-line proximity check above (which is what
    // keeps a giant multi-table file like api/telegram-webhook.js OUT of
    // this list entirely), extracting from the WHOLE FILE is safe: every
    // producer file in this repo is a small, single-purpose script/route,
    // not a multi-branch handler, so there is no sibling status literal
    // left to contaminate the result.
    for (const status of extractWrittenStatuses(source)) {
      if (!writtenByStatus.has(status)) writtenByStatus.set(status, { status, files: [] });
      const entry = writtenByStatus.get(status);
      if (!entry.files.includes(rel)) entry.files.push(rel);
    }
  }

  console.log(`\nScanned ${allFiles.length} files under api/, scripts/. Found ${producerFiles.length} producer file(s) that POST/upsert into video_library:`);
  for (const f of producerFiles) console.log(`  ${f}`);
  console.log(`\nDistinct status literal(s) written: ${[...writtenByStatus.keys()].sort().join(', ')}`);

  // Consumers: every status any file actually SELECTs for video_library.
  const consumed = new Set();
  for (const file of allFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (!VIDEO_LIBRARY_URL_RE.test(source)) continue;
    for (const status of extractConsumedStatuses(source)) consumed.add(status);
  }
  console.log(`Distinct status literal(s) consumed:      ${[...consumed].sort().join(', ')}\n`);

  // ---- Sanity controls: prove the scan itself works before trusting it --
  check('sanity: scan finds a KNOWN producer (scripts/queue-finished-videos.py)', () => {
    assert.ok(producerFiles.includes('scripts/queue-finished-videos.py'),
      'queue-finished-videos.py must be detected as a video_library producer -- if not, the scan itself is broken');
  });
  check("sanity: 'approved' is both written and consumed (the canonical status)", () => {
    assert.ok(writtenByStatus.has('approved'), "'approved' must be a written status -- if not, the scan is broken");
    assert.ok(consumed.has('approved'), "'approved' must be a consumed status -- if not, the scan is broken");
  });
  check("sanity: a PATCH-only lifecycle file (api/cron-post-videos.js) is NOT counted as a producer", () => {
    assert.ok(!producerFiles.includes('api/cron-post-videos.js'),
      'api/cron-post-videos.js only PATCHes existing rows through the approval lifecycle -- it must not be swept into the producer scan as a false positive');
  });

  // ---- The actual gate: every written status must be consumed or excepted
  console.log('\nEvery written status must be consumed by a real query, or in KNOWN_EXCEPTIONS:\n');
  for (const [status, { files }] of writtenByStatus) {
    check(`'${status}' (written by ${files.join(', ')}) is consumed or excepted`, () => {
      if (consumed.has(status)) return;
      const exception = KNOWN_EXCEPTIONS[status];
      assert.ok(exception,
        `'${status}' is written by ${files.join(', ')} but no consumer query selects it, and it is not in ` +
        `KNOWN_EXCEPTIONS in this file. Either make a consumer read status=eq.${status}, change the producer ` +
        `to write an already-consumed status ('approved' is canonical -- see api/cron-post-videos.js's ` +
        `"REVIEW GATE FLOW" comment), or add a KNOWN_EXCEPTIONS entry with a real, checked reason.`);
    });
  }

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS — every video_library status a producer writes is consumed by a real query (or a documented exception)');
  process.exit(0);
})().catch((err) => {
  console.error('RESULT: FAIL (harness crash)', err);
  process.exit(1);
});
