#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-10 weekly-recording-kit fixes to
 * scripts/queue-finished-videos.py (docs/WEEKLY-RECORDING-KIT.md GAP 1-3).
 *
 * THE BUGS
 * --------
 * 1. TARGET_STEMS hardcoded a 5-filename May allowlist — any new .mp4
 *    dropped for the weekly kit was silently skipped.
 * 2. Caption auto-generation always appended "meetdossie.com/founding" —
 *    founding closed 2026-08-04.
 * 3. Selfie clips defaulted to platforms=[tiktok,instagram] only, silently
 *    dropping Facebook.
 *
 * THE FIX
 * -------
 * Watch-folder scan (any new .mp4, no allowlist), caption sourced only from
 * docs/WEEKLY-RECORDING-KIT.md's own "Post caption:" lines (empty + Telegram
 * flag if unmatched — never a template), selfie default now includes
 * facebook, and realtor clips (Media/finished-videos/realtor/) get
 * target_owner='heath-realtor' with their own platform default.
 *
 * TESTS (local mock PostgREST + Storage — a fixture kit doc so this test is
 * NOT coupled to next week's real kit content — ZERO production access):
 *   1. WATCH-FOLDER: a filename that was never in the old TARGET_STEMS
 *      allowlist still gets queued.
 *   2. IDEMPOTENCY: running the scanner twice does not re-upsert anything
 *      the second time.
 *   3. CAPTION FROM KIT: a Dossie clip whose slug matches a fixture script
 *      gets that script's exact "Post caption:" text, not a generated one.
 *   4. UNMATCHED CAPTION FLAGGED: a clip with no matching script ships with
 *      an EMPTY caption (never a stale/template one) and prints a flag.
 *   5. SELFIE PLATFORM DEFAULT: a Dossie selfie row's platforms include
 *      facebook (not just tiktok/instagram).
 *   6. REALTOR ROUTING: a clip dropped in realtor/ gets
 *      target_owner='heath-realtor' and the realtor platform default
 *      (facebook+instagram, no tiktok).
 *
 * Run manually:
 *   node scripts/regression-queue-finished-videos.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

const REPO = path.join(__dirname, '..');

// ── Fixture kit doc — stable, independent of next week's real content ───────
const FIXTURE_KIT_DOC = `
## THIS WEEK'S SCRIPTS

### MEET DOSSIE PAGE

**1. STORY**

> [HOOK] Some hook.

Post caption: \`Fixture dossie caption one.\`

---

**2. COST MATH**

> [HOOK] Some hook.

Post caption: \`Fixture dossie caption two.\`

---

### HEATH'S REALTOR PAGE

**3. TREC EXPLAINER**

> [HOOK] Some hook.

Post caption: \`Fixture realtor caption one. Heath Shepard, REALTOR - Keller Williams City-View.\`

---

## FILE NAMING

Dossie clips go in \`Media/finished-videos/\`:
- \`regr-story-selfie-2026-09-10.mp4\`
- \`regr-cost-math-selfie-2026-09-10.mp4\`

Realtor clips go in \`Media/finished-videos/realtor/\` (a subfolder):
- \`regr-trec-explainer-realtor-selfie-2026-09-10.mp4\`
`;

function makeDummyMp4(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from('not a real mp4 but small'));
}

// ── Mock Supabase (PostgREST + Storage) ──────────────────────────────────────
function startMockSupabase() {
  const state = { ids: new Set(), upserts: [], uploads: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/rest/v1/video_library') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([...state.ids].map((id) => ({ id }))));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/rest/v1/video_library') {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        if (body && body.id) {
          state.ids.add(body.id);
          state.upserts.push(body);
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('');
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/storage/v1/object/')) {
        state.uploads.push(url.pathname);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Key: url.pathname }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

// --------------------------------------------------------------------- main
(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-finished-videos-regr-'));
  const finishedDir = path.join(tmpRoot, 'finished-videos');
  const realtorDir = path.join(finishedDir, 'realtor');
  const kitDocPath = path.join(tmpRoot, 'WEEKLY-RECORDING-KIT.md');
  fs.writeFileSync(kitDocPath, FIXTURE_KIT_DOC);

  // Test 1 fixture: a filename that was NEVER in the old TARGET_STEMS
  // allowlist (which only knew 5 specific May 2026 filenames).
  makeDummyMp4(path.join(finishedDir, 'regr-story-selfie-2026-09-10.mp4'));       // matches fixture caption 1
  makeDummyMp4(path.join(finishedDir, 'regr-cost-math-selfie-2026-09-10.mp4'));   // matches fixture caption 2
  makeDummyMp4(path.join(finishedDir, 'regr-unmatched-topic-selfie-2026-09-10.mp4')); // no matching script
  makeDummyMp4(path.join(realtorDir, 'regr-trec-explainer-realtor-selfie-2026-09-10.mp4')); // realtor, matches fixture caption 3

  const { server, state } = await startMockSupabase();
  const port = server.address().port;

  const env = {
    ...process.env,
    QUEUE_VIDEOS_DIR: finishedDir,
    WEEKLY_KIT_PATH: kitDocPath,
    SUPABASE_URL: `http://127.0.0.1:${port}`,
    SUPABASE_SERVICE_ROLE_KEY: 'regr-dummy-key',
  };
  // Blank (not delete) — the script's load_env_file() uses setdefault(), so
  // a DELETED key would get silently repopulated from the real .env.local
  // and this test would fire a real Telegram send / hang on a real network
  // call from a sandboxed environment. An empty string already "exists" in
  // os.environ, so setdefault leaves it alone.
  env.TELEGRAM_BOT_TOKEN = '';
  env.TELEGRAM_MARKETING_BOT_TOKEN = '';

  // IMPORTANT: async execFile, not execFileSync — the mock Supabase server
  // lives in THIS same Node process. A *Sync child-process call blocks
  // Node's event loop, so the server could never actually respond to the
  // python child and the whole thing would deadlock.
  async function runScanner() {
    try {
      const { stdout } = await execFile('python3', [path.join(REPO, 'scripts', 'queue-finished-videos.py')], { env });
      return stdout;
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  const out1 = await runScanner();
  console.log(out1);

  console.log('Test 1: watch-folder ingest (no TARGET_STEMS allowlist)');
  check('all 4 dropped files got upserted on first run', () => {
    assert.strictEqual(state.upserts.length, 4, `expected 4 upserts, got ${state.upserts.length}: ${JSON.stringify(state.upserts.map((u) => u.id))}`);
  });
  check('regr-unmatched-topic-selfie (never in any allowlist) was queued', () => {
    assert.ok(state.ids.has('regr-unmatched-topic-selfie-2026-09-10'),
      'a novel filename with no historical allowlist entry was NOT queued — watch-folder scan is still allowlisted');
  });

  console.log('\nTest 3: caption sourced from the kit doc, not a template');
  check('regr-story-selfie caption matches fixture kit caption 1 exactly', () => {
    const row = state.upserts.find((u) => u.id === 'regr-story-selfie-2026-09-10');
    assert.ok(row, 'row not found');
    assert.strictEqual(row.caption, 'Fixture dossie caption one.', `got: ${row.caption}`);
  });
  check('regr-cost-math-selfie caption matches fixture kit caption 2 exactly', () => {
    const row = state.upserts.find((u) => u.id === 'regr-cost-math-selfie-2026-09-10');
    assert.ok(row, 'row not found');
    assert.strictEqual(row.caption, 'Fixture dossie caption two.', `got: ${row.caption}`);
  });
  check('no caption anywhere contains a founding CTA', () => {
    const offender = state.upserts.find((u) => /founding/i.test(u.caption || ''));
    assert.ok(!offender, `caption contains a founding CTA: ${JSON.stringify(offender)}`);
  });

  console.log('\nTest 4: unmatched topic ships with an EMPTY caption and is flagged, not a stale template');
  check('regr-unmatched-topic-selfie caption is empty', () => {
    const row = state.upserts.find((u) => u.id === 'regr-unmatched-topic-selfie-2026-09-10');
    assert.ok(row, 'row not found');
    assert.strictEqual(row.caption, '', `expected empty caption, got: "${row.caption}"`);
  });
  check('scanner printed a flag/WARN for the unmatched topic', () => {
    assert.ok(/no matching script/i.test(out1) && /regr-unmatched-topic-selfie/.test(out1),
      'expected a WARN mentioning "no matching script" and the filename in stdout');
  });

  console.log('\nTest 5: selfie platform default includes facebook');
  check('Dossie selfie row platforms include facebook (not just tiktok/instagram)', () => {
    const row = state.upserts.find((u) => u.id === 'regr-story-selfie-2026-09-10');
    assert.ok(row, 'row not found');
    assert.ok(Array.isArray(row.platforms) && row.platforms.includes('facebook'),
      `platforms did not include facebook: ${JSON.stringify(row.platforms)}`);
  });

  console.log('\nTest 6: realtor routing');
  check('realtor clip got target_owner=heath-realtor', () => {
    const row = state.upserts.find((u) => u.id === 'regr-trec-explainer-realtor-selfie-2026-09-10');
    assert.ok(row, 'row not found');
    assert.strictEqual(row.target_owner, 'heath-realtor', `got: ${row.target_owner}`);
  });
  check('realtor clip platform default is facebook+instagram, no tiktok', () => {
    const row = state.upserts.find((u) => u.id === 'regr-trec-explainer-realtor-selfie-2026-09-10');
    assert.ok(row, 'row not found');
    assert.deepStrictEqual([...row.platforms].sort(), ['facebook', 'instagram'], `got: ${JSON.stringify(row.platforms)}`);
  });
  check('realtor clip caption carries the brokerage name (kit caption, untouched)', () => {
    const row = state.upserts.find((u) => u.id === 'regr-trec-explainer-realtor-selfie-2026-09-10');
    assert.ok(row, 'row not found');
    assert.ok(/Keller Williams City-View/.test(row.caption), `got: ${row.caption}`);
  });
  check('Dossie rows are all target_owner=dossie', () => {
    const dossieRows = state.upserts.filter((u) => u.id !== 'regr-trec-explainer-realtor-selfie-2026-09-10');
    assert.ok(dossieRows.every((r) => r.target_owner === 'dossie'), `got: ${JSON.stringify(dossieRows.map((r) => r.target_owner))}`);
  });

  console.log('\nTest 2: idempotency — second run must not re-upsert anything');
  const upsertsBeforeRerun = state.upserts.length;
  const out2 = await runScanner();
  console.log(out2);
  check('second run performed zero new upserts', () => {
    assert.strictEqual(state.upserts.length, upsertsBeforeRerun,
      `expected no new upserts on re-run, upserts went from ${upsertsBeforeRerun} to ${state.upserts.length}`);
  });
  check('second run reports all 4 files already in DB', () => {
    const skipCount = (out2.match(/SKIP \(already in DB\)/g) || []).length;
    assert.strictEqual(skipCount, 4, `expected 4 SKIP lines, got ${skipCount}:\n${out2}`);
  });

  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
