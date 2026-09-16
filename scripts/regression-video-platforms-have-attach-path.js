#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-16 "YouTube has no attach path" bug.
 *
 * THE BUG
 * -------
 * A platform can be video-only (no card/text fallback — publishing it
 * requires a real video attached to a row) via either of two independent
 * pipelines:
 *
 *   Pipeline A (retired 2026-06-30): api/cron-generate-posts.js sets
 *   video_required=true on a social_posts row, and api/cron-render-videos.js
 *   attaches a per-post Creatomate render. Creatomate has been out of
 *   credits (402) since 2026-06-30 — this pipeline is permanently dead.
 *
 *   Pipeline B (live): scripts/queue-finished-videos.py tags a real,
 *   already-rendered clip with a platforms[] array and inserts it into
 *   video_library; api/cron-post-videos.js posts video_library rows to
 *   Zernio for each platform in that array, using api/cron-post-videos.js's
 *   ZERNIO_ACCOUNTS map to resolve the account id.
 *
 * instagram and tiktok were fully migrated to Pipeline B on 2026-09-09/15.
 * youtube's Zernio account + posting_schedule were fixed live on 2026-09-16
 * (78c1c876) so Pipeline B COULD post to it — but nothing upstream
 * (cron-generate-posts.js, cron-render-videos.js, queue-finished-videos.py)
 * was updated to match: cron-generate-posts.js kept generating a youtube
 * row on the dead Pipeline A path, cron-render-videos.js didn't skip it (so
 * it would retry a dead vendor call), and queue-finished-videos.py never
 * tagged any clip with 'youtube' (so Pipeline B had nothing to post even
 * though it was newly able to). One dead row shipped before this was caught
 * (docs: 2026-09-16 YouTube attach-path incident).
 *
 * THE INVARIANT THIS LOCKS
 * -------------------------
 * Pipeline A is CATEGORICALLY dead, not conditionally dead — Creatomate has
 * returned 402 (out of credits) since 2026-06-30 and nobody has re-funded
 * it. Checking only "is cron-render-videos.js not skipping this platform"
 * is NOT sufficient to call Pipeline A a real path — that check alone still
 * passes on youtube's pre-fix state (video_required=true, not skipped, and
 * yet zero videos ever attached, because the vendor call itself always
 * fails). So this test requires BOTH:
 *
 *   1. cron-generate-posts.js's VIDEO_REQUIRED_PLATFORMS is EMPTY — no
 *      platform may depend on Pipeline A at all anymore. Any non-empty
 *      entry here is an automatic fail, full stop.
 *
 *   2. Every platform in the video-only universe has a REAL Pipeline B
 *      path: queue-finished-videos.py's classify_video() can tag at least
 *      one video lane with that platform AND cron-post-videos.js's
 *      DEFAULT_PLATFORMS includes it AND its ZERNIO_ACCOUNTS entry is a
 *      literal, resolvable account id (no process.env indirection, no
 *      null).
 *
 * A platform failing either check is a silent dead end: rows will generate
 * (or accept video) but nothing will ever attach media to them.
 *
 * Source-level on purpose (same technique as
 * regression-zernio-account-ids-resolvable.js): the defect lived in four
 * separately-edited constants going out of sync with each other, which is
 * invisible to any test that mocks a single file in isolation.
 *
 * Run manually:
 *   node scripts/regression-video-platforms-have-attach-path.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const GEN_SRC = fs.readFileSync(path.join(REPO, 'api', 'cron-generate-posts.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.join(REPO, 'api', 'cron-render-videos.js'), 'utf8');
const POST_SRC = fs.readFileSync(path.join(REPO, 'api', 'cron-post-videos.js'), 'utf8');
const QUEUE_SRC = fs.readFileSync(path.join(REPO, 'scripts', 'queue-finished-videos.py'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

// ── Generic "const X = new Set([...])" / "const X = [...]" extractor ──────
function extractSetOrArray(src, constName, file) {
  const marker = `const ${constName} =`;
  const i = src.indexOf(marker);
  assert.ok(i !== -1, `could not find "${marker}" in ${file}`);
  const open = src.indexOf('[', i);
  const close = src.indexOf(']', open);
  assert.ok(open !== -1 && close !== -1, `could not delimit ${constName} literal in ${file}`);
  const body = src.slice(open + 1, close);
  return [...body.matchAll(/'([a-z]+)'|"([a-z]+)"/g)].map((m) => m[1] || m[2]);
}

const VIDEO_REQUIRED_PLATFORMS = extractSetOrArray(GEN_SRC, 'VIDEO_REQUIRED_PLATFORMS', 'cron-generate-posts.js');
const GENERATION_DISABLED_PLATFORMS = extractSetOrArray(GEN_SRC, 'GENERATION_DISABLED_PLATFORMS', 'cron-generate-posts.js');
const SKIP_RENDER_PLATFORMS = extractSetOrArray(RENDER_SRC, 'SKIP_RENDER_PLATFORMS', 'cron-render-videos.js');

// ── cron-post-videos.js: DEFAULT_PLATFORMS + ZERNIO_ACCOUNTS (same technique
//    as regression-zernio-account-ids-resolvable.js) ────────────────────────
function extractBlock(src, startMarker, file) {
  const i = src.indexOf(startMarker);
  assert.ok(i !== -1, `could not find ${startMarker} in ${file}`);
  const afterEq = i + startMarker.length;
  const braceAt = src.indexOf('{', afterEq);
  const brackAt = src.indexOf('[', afterEq);
  const useBracket = brackAt !== -1 && (braceAt === -1 || brackAt < braceAt);
  const open = useBracket ? brackAt : braceAt;
  const close = src.indexOf(useBracket ? ']' : '}', open);
  assert.ok(open !== -1 && close !== -1, `could not delimit literal after ${startMarker} in ${file}`);
  return src.slice(open, close + 1);
}

const defaultPlatformsBlock = extractBlock(POST_SRC, 'const DEFAULT_PLATFORMS =', 'cron-post-videos.js');
const DEFAULT_PLATFORMS = [...defaultPlatformsBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

const accountsBlock = extractBlock(POST_SRC, 'const ZERNIO_ACCOUNTS =', 'cron-post-videos.js');
const ZERNIO_ACCOUNTS = {};
for (const line of accountsBlock.split('\n')) {
  const stripped = line.replace(/\/\/.*$/, '').trim();
  const m = stripped.match(/^([a-z]+):\s*(.+?),?$/);
  if (m) ZERNIO_ACCOUNTS[m[1]] = m[2].replace(/,$/, '').trim();
}

function zernioResolvable(platform) {
  const rhs = ZERNIO_ACCOUNTS[platform];
  if (rhs === undefined) return false;
  if (/process\.env\./.test(rhs)) return false;
  if (/\bnull\b/.test(rhs)) return false;
  return /^'([0-9a-f]{24})'$/.test(rhs);
}

// ── queue-finished-videos.py: union of every platform any classify_video()
//    lane can tag a clip with (Pipeline B's actual feed into video_library) ─
function extractPyListLiterals(src) {
  const platforms = new Set();
  for (const m of src.matchAll(/\[([^\]]*)\]/g)) {
    const inner = m[1];
    // Only literal string lists — skip anything referencing a variable name
    // (e.g. list(DOSSIE_SELFIE_PLATFORMS) has no '[' body to match here).
    for (const sm of inner.matchAll(/"([a-z]+)"/g)) platforms.add(sm[1]);
  }
  return platforms;
}
const PY_INLINE_LISTS = extractPyListLiterals(QUEUE_SRC.slice(QUEUE_SRC.indexOf('def classify_video')));
// DOSSIE_SELFIE_PLATFORMS is referenced via list(DOSSIE_SELFIE_PLATFORMS) in
// classify_video(), not inlined — pull its own literal separately.
const dossieSelfieBlock = extractBlock(QUEUE_SRC.replace(/#.*$/gm, ''), 'DOSSIE_SELFIE_PLATFORMS =', 'queue-finished-videos.py');
for (const m of dossieSelfieBlock.matchAll(/"([a-z]+)"/g)) PY_INLINE_LISTS.add(m[1]);
const PIPELINE_B_PLATFORMS = PY_INLINE_LISTS;

console.log('Video-required platforms have an attach path\n');

check('all four source files parsed non-vacuously', () => {
  assert.ok(SKIP_RENDER_PLATFORMS.length >= 2, `SKIP_RENDER_PLATFORMS parsed ${SKIP_RENDER_PLATFORMS.length}`);
  assert.ok(GENERATION_DISABLED_PLATFORMS.length >= 2, `GENERATION_DISABLED_PLATFORMS parsed ${GENERATION_DISABLED_PLATFORMS.length}`);
  assert.ok(DEFAULT_PLATFORMS.length >= 5, `DEFAULT_PLATFORMS parsed ${DEFAULT_PLATFORMS.length}`);
  assert.ok(PIPELINE_B_PLATFORMS.size >= 3, `PIPELINE_B_PLATFORMS parsed ${PIPELINE_B_PLATFORMS.size}`);
});

// The universe of "ever video-only" platforms: anything that shows up in any
// of the three exclusion/requirement sets. Locked with an explicit minimum
// membership check so a future edit can't shrink this to {} and pass
// vacuously.
const VIDEO_ONLY_UNIVERSE = new Set([
  ...VIDEO_REQUIRED_PLATFORMS,
  ...GENERATION_DISABLED_PLATFORMS,
  ...SKIP_RENDER_PLATFORMS,
]);

check('video-only platform universe includes instagram, tiktok, youtube', () => {
  for (const p of ['instagram', 'tiktok', 'youtube']) {
    assert.ok(VIDEO_ONLY_UNIVERSE.has(p), `expected "${p}" in the derived video-only universe: ${[...VIDEO_ONLY_UNIVERSE]}`);
  }
});

check('Pipeline A (per-post Creatomate render) is fully retired — VIDEO_REQUIRED_PLATFORMS is empty', () => {
  assert.strictEqual(
    VIDEO_REQUIRED_PLATFORMS.length, 0,
    `VIDEO_REQUIRED_PLATFORMS still contains ${JSON.stringify(VIDEO_REQUIRED_PLATFORMS)} — Creatomate has been ` +
    `dead (402) since 2026-06-30; any platform depending on it can never actually get a video attached, ` +
    `no matter what cron-render-videos.js's skip list says. Route it through Pipeline B instead.`,
  );
});

for (const platform of VIDEO_ONLY_UNIVERSE) {
  check(`${platform} has a real Pipeline B attach path`, () => {
    assert.ok(
      PIPELINE_B_PLATFORMS.has(platform),
      `queue-finished-videos.py's classify_video() never tags any lane with "${platform}" — Pipeline B has ` +
      `nothing to feed it, even if cron-post-videos.js can post it.`,
    );
    assert.ok(
      DEFAULT_PLATFORMS.includes(platform),
      `"${platform}" is not in cron-post-videos.js's DEFAULT_PLATFORMS — a video_library row tagged for it ` +
      `would still never get targeted at post time.`,
    );
    assert.ok(
      zernioResolvable(platform),
      `"${platform}"'s ZERNIO_ACCOUNTS entry (${ZERNIO_ACCOUNTS[platform]}) is missing, null, or a ` +
      `process.env fallback — exactly the defect that kept youtube at zero posts for ~4 months ` +
      `(regression-zernio-account-ids-resolvable.js covers this too; failing here means the two ` +
      `tests have drifted apart).`,
    );
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
