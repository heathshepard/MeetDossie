#!/usr/bin/env node
'use strict';

// scripts/regression-daily-video-cycle.js
//
// Regression for the end-to-end daily video cycle (2026-09-18), covering the
// three things that were enforced rather than remembered:
//
//   A. build-shortform-video.py REFUSES an incomplete production — no voice,
//      no CTA card on screen, no cover, or captions that resolve to nothing.
//   B. scripts/_lib/video-lanes.js never emits a mixed-orientation platform
//      array, which is what made the quality gate fail closed on every lane.
//   C. scripts/queue-finished-videos.py's own default lanes are single-shape,
//      and the `-desktop-` naming lane routes to the horizontal family for
//      every owner rather than only for Dossie.
//
// Pure/offline: no network, no ffmpeg render, no Supabase. The builder cases
// shell out to python3 and assert on the refusal text, the same pattern
// scripts/regression-shortform-brand-guardrails.js already uses.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const BUILDER = path.join(REPO, 'scripts', 'build-shortform-video.py');
const QUEUE_PY = path.join(REPO, 'scripts', 'queue-finished-videos.py');

const { splitLanes, familyOf, VERTICAL_PLATFORMS, HORIZONTAL_PLATFORMS } = require('./_lib/video-lanes.js');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${(e && e.message) || e}`);
    fail++;
  }
}

// ── A. builder refusals ─────────────────────────────────────────────────────

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-'));

/** Run the builder against a spec and return its stderr (it must never render). */
function buildStderr(spec) {
  const specPath = path.join(tmp, `spec-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec), 'utf8');
  // Media/ is gitignored, so a worktree has the code and none of the music
  // beds. Without this pin the brand's default bed is "not found" and THAT
  // refusal fires first, masking the case under test. Points at the one real
  // library, exactly as scripts/run-daily-video-supply.cmd does in production.
  const mediaRoot = process.env.DOSSIE_MEDIA_ROOT || '/mnt/c/Users/Heath/Projects/MeetDossie/Media';
  const r = spawnSync('python3', [BUILDER, '--spec', specPath,
    '--out', path.join(tmp, 'out.mp4'), '--work', path.join(tmp, 'work')],
  { encoding: 'utf8', env: { ...process.env, DOSSIE_MEDIA_ROOT: mediaRoot } });
  return { status: r.status, stderr: (r.stderr || '') + (r.stdout || '') };
}

// Real (empty) files so the missing-input reasons do NOT fire in the cases
// that are testing something else — the refusal reports EVERY problem it finds
// at once, so a fixture that is broken in two ways proves nothing about one.
const DUMMY_MP3 = path.join(tmp, 'a.mp3');
const DUMMY_TIMING = path.join(tmp, 'a.json');
fs.writeFileSync(DUMMY_MP3, '');
fs.writeFileSync(DUMMY_TIMING, '{}');

/** A spec that is complete except for whatever the test removes. */
function completeDossieSpec() {
  return {
    brand: 'dossie',
    fontsdir: path.join(REPO, 'public', 'fonts'),
    frames_json: path.join(tmp, 'frames.json'),
    cards: {
      // The hook is deliberately NOT the CTA template: the CTA check asks
      // whether the brand's cta.card is on screen, and a fixture whose hook is
      // also cta-dossie.html satisfies it by accident.
      hook: { html_inline: '<!doctype html><html><body style="background:#1A1A2E;color:#F5E6E0"><h1>Hook</h1></body></html>' },
      cta: { template: 'cta-dossie.html', vars: {} },
    },
    cover_card: 'hook',
    segments: [{ name: 'cta', kind: 'card', pngs: [['cta', 2.2]] }],
    voice: [{ speaker: 'Dossie', voice_id: 'lxYfHSkYm1EzQzGhdbfc', at: 0, mp3: DUMMY_MP3, timing: DUMMY_TIMING, text: 'hello' }],
  };
}

check('refuses a spec with NO voiceover (the "silent output" defect)', () => {
  const spec = completeDossieSpec();
  spec.voice = [];
  const { status, stderr } = buildStderr(spec);
  assert.notStrictEqual(status, 0, 'builder must exit non-zero');
  assert.ok(/REFUSING to build: incomplete production/.test(stderr), 'expected the full-production refusal');
  assert.ok(/no 'voice' clips/.test(stderr), `expected the voice reason, got: ${stderr.slice(0, 400)}`);
});

check('refuses a spec with NO cover_card', () => {
  const spec = completeDossieSpec();
  delete spec.cover_card;
  const { status, stderr } = buildStderr(spec);
  assert.notStrictEqual(status, 0);
  assert.ok(/no 'cover_card'/.test(stderr), `expected the cover reason, got: ${stderr.slice(0, 400)}`);
});

check('refuses a CTA card that is declared but never shown on screen', () => {
  const spec = completeDossieSpec();
  // Card still declared; the segment that displayed it is gone, so it would
  // render to a PNG nobody ever sees.
  spec.segments = [{ name: 'hookseg', kind: 'card', pngs: [['hook', 2.0]] }];
  const { status, stderr } = buildStderr(spec);
  assert.notStrictEqual(status, 0);
  assert.ok(/never referenced by a\s*\n?\s*'card' segment|never referenced by a 'card' segment/.test(stderr),
    `expected the unreferenced-CTA reason, got: ${stderr.slice(0, 600)}`);
});

check('refuses voice clips whose mp3/timing files are not on disk', () => {
  const spec = completeDossieSpec();
  spec.voice[0].mp3 = path.join(tmp, 'does-not-exist.mp3');
  spec.voice[0].timing = path.join(tmp, 'does-not-exist.json');
  const { status, stderr } = buildStderr(spec);
  assert.notStrictEqual(status, 0);
  assert.ok(/mp3 not on disk/.test(stderr) && /character-timing JSON not on disk/.test(stderr),
    `expected both missing-file reasons, got: ${stderr.slice(0, 500)}`);
});

check('the brand-safety refusals still fire BEFORE the completeness refusal', () => {
  // Ordering matters: "this copy is a fiduciary problem" must not be masked by
  // "this spec is incomplete". The realtor brand forbids weakness signals.
  const spec = {
    brand: 'heath-realtor',
    fontsdir: path.join(REPO, 'public', 'fonts'),
    frames_json: path.join(tmp, 'frames.json'),
    cards: {},
    segments: [],
    voice: [],
    post_caption: 'Motivated seller, bring me all offers',
  };
  const { status, stderr } = buildStderr(spec);
  assert.notStrictEqual(status, 0);
  assert.ok(/forbidden copy found/.test(stderr),
    `the copy refusal must win, got: ${stderr.slice(0, 400)}`);
});

// ── B. lane splitting ───────────────────────────────────────────────────────

check('no platform is in both orientation families', () => {
  const both = VERTICAL_PLATFORMS.filter((p) => HORIZONTAL_PLATFORMS.includes(p));
  assert.deepStrictEqual(both, [], `platforms in both families: ${both.join(', ')}`);
});

check('youtube is VERTICAL (Shorts is what this pipeline publishes)', () => {
  assert.strictEqual(familyOf('youtube'), 'vertical',
    'queue-finished-videos.py tags youtube on the vertical lanes; the gate must agree or the array is mixed');
});

check('splitLanes never returns a mixed array, on the exact list that used to break', () => {
  const { vertical, horizontal, unknown } = splitLanes(['facebook', 'instagram', 'tiktok', 'youtube']);
  assert.deepStrictEqual(vertical.sort(), ['instagram', 'tiktok', 'youtube']);
  assert.deepStrictEqual(horizontal, ['facebook']);
  assert.deepStrictEqual(unknown, []);
  for (const p of vertical) assert.ok(!horizontal.includes(p));
});

check('an unrecognised platform is surfaced, never silently dropped', () => {
  const { unknown } = splitLanes(['instagram', 'threads']);
  assert.deepStrictEqual(unknown, ['threads'],
    'a platform nobody classified is a config bug and must be reported, not swallowed');
});

// ── C. queue scanner lanes ──────────────────────────────────────────────────

const queueSrc = fs.readFileSync(QUEUE_PY, 'utf8');

function pyList(name) {
  const m = new RegExp(`^${name}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(queueSrc);
  if (!m) throw new Error(`could not find ${name} in queue-finished-videos.py`);
  return m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

for (const name of ['DOSSIE_SELFIE_PLATFORMS', 'REALTOR_SELFIE_PLATFORMS', 'RUST_PLATFORMS']) {
  check(`${name} is single-shape (this is what failed the gate closed)`, () => {
    const { vertical, horizontal } = splitLanes(pyList(name));
    assert.ok(!(vertical.length > 0 && horizontal.length > 0),
      `${name} mixes orientations: vertical=[${vertical}] horizontal=[${horizontal}] — `
      + 'classifyOrientation() throws on this and every rule then fails closed');
  });
}

for (const name of ['DOSSIE_DESKTOP_PLATFORMS', 'REALTOR_DESKTOP_PLATFORMS', 'RUST_DESKTOP_PLATFORMS']) {
  check(`${name} is horizontal-only`, () => {
    const { vertical, horizontal } = splitLanes(pyList(name));
    assert.strictEqual(vertical.length, 0, `${name} contains a vertical platform`);
    assert.ok(horizontal.length > 0, `${name} is empty`);
  });
}

check('the -desktop- naming lane is handled for EVERY owner, not just Dossie', () => {
  assert.ok(/if stem\.endswith\("-desktop"\) or "-desktop-" in stem:/.test(queueSrc),
    'classify_video must branch on the desktop suffix before the per-owner returns, otherwise a '
    + 'realtor or rust 16:9 cut gets tagged with that owner\'s VERTICAL platform list');
  const desktopIdx = queueSrc.indexOf('"-desktop-" in stem:');
  const realtorIdx = queueSrc.indexOf('if owner == "heath-realtor":');
  assert.ok(desktopIdx > 0 && desktopIdx < realtorIdx,
    'the desktop branch must come BEFORE the per-owner early returns');
});

// ── result ──────────────────────────────────────────────────────────────────
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\n${pass}/${pass + fail} daily-video-cycle cases passed`);
process.exit(fail === 0 ? 0 : 1);
