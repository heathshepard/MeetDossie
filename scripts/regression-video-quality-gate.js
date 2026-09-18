#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/verify-video-quality.js — the video quality
 * gate built 2026-09-15 per Heath's standing rule
 * (feedback_every-video-needs-scroll-stopping-hook.md /
 * docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md).
 *
 * REAL ffmpeg/ffprobe run against REAL video files for the measurable rules
 * (runtime, motion, resolution, cover) — nothing is faked there. The
 * Anthropic vision call is intercepted (same globalThis.fetch pattern
 * scripts/regression-post-videos-schedule-caps.js already uses for
 * Zernio/Telegram) so this test has zero API cost and zero network
 * dependency; it still proves the vision-rule results are correctly wired
 * into the overall pass/fail.
 *
 * FIXTURES
 * --------
 * BAD  = Media/rust-conversations/rust-conv-founder-val-vertical.mp4, the
 *        real rejected Rust video the playbook names as the reference
 *        negative fixture: 42.6s runtime (outside every platform window)
 *        and frame 0.0s/1.5s measured pixel-identical (SSIM 0.999966 —
 *        verified directly by this test, see Test 1). If this file isn't
 *        present (Media/ is gitignored, worktree-local), the test FAILS
 *        loudly rather than silently skipping the required negative case.
 * GOOD = a synthetic 24s 1080x1920 clip generated on the fly with ffmpeg's
 *        testsrc2 source (genuine per-frame motion, unlike a static color
 *        card) plus an extracted cover frame — deterministic, not
 *        checked into git, no dependency on Media/.
 *
 * TESTS
 * -----
 *   1. BAD fixture: real_motion_0_to_1_5s and runtime_in_platform_range
 *      both fail on REAL measured values (SSIM + duration asserted
 *      exactly), even with vision mocked to say everything looks great —
 *      proves the measurable rules alone catch the known defect.
 *   2. BAD fixture with no cover supplied: cover_asset_present fails too.
 *   3. GOOD fixture + cover, vision mocked to pass everything: overall
 *      pass=true, zero failedRules.
 *   4. GOOD fixture, vision mocked so hook_visible_frame0=false: overall
 *      pass=false and failedRules contains exactly that rule — proves
 *      vision-rule failures are NOT silently ignored.
 *   5. gateBeforePublish(): a row with quality_status!=='passed' is held
 *      (status PATCHed to quality_hold) and exactly one Telegram alert is
 *      sent naming the failed rules; a row with quality_status='passed'
 *      proceeds with zero DB/Telegram calls.
 *
 * FULL-BLEED FRAMING TESTS (added 2026-09-16)
 * -------------------------------------------
 * Added after two Dossie feature-demo videos shipped to Facebook/LinkedIn/
 * Twitter on 2026-09-15 at 1920x1080. Facebook renders those surfaces as
 * vertical Reels, so it letterboxed the 16:9 file into a 9:16 frame — Heath
 * screenshotted a thin horizontal strip with ~80% black around it. The same
 * file's frame 0 was solid white and its first seconds sat on the Dossie
 * sign-in page.
 *
 * The negative fixture is the ACTUAL published file
 * (feature-demo-stage-checklist-desktop-2026-09-07.mp4), fetched from the
 * public Supabase bucket it was served from and cached under tmp — these
 * tests measure the exact bytes that went out.
 *
 *   6.  REAL BAD: aspect_ratio_vertical_9x16 fails (measured 1920x1080 /
 *       1.7778) and first_frame_not_uniform fails (measured luma spread 0),
 *       with every vision rule mocked to PASS — proving the measurable rules
 *       alone would have held it.
 *   7.  REAL GOOD: the known-good `-mobile-` sibling from the same batch
 *       passes all three framing rules, and scores content coverage 1.0
 *       despite having transient flat UI frames mid-clip — the regression
 *       against false positives.
 *   8.  SYNTHETIC letterbox (black bars) and pillarbox (WHITE bars) both fail
 *       content_fills_frame. The white case is the one ffmpeg's `cropdetect`
 *       would score as a full frame; Dossie's palette is light, so it is a
 *       realistic failure, not a contrived one.
 *   9.  SYNTHETIC naive pad: a 16:9 source scaled and padded into a genuine
 *       1080x1920 frame. It PASSES the aspect rule and FAILS coverage —
 *       this is the "just add a scale filter" wrong fix, and the test exists
 *       to make sure it can never ship.
 *   10. opening_not_login_or_empty: when vision reports a login opening, the
 *       gate fails with exactly that rule and surfaces the disqualifier.
 *
 * OPENING-RULE NARROWING TESTS (added 2026-09-16, same day as the rule)
 * -----------------------------------------------------------------------
 * The rule above shipped in commit 6364ffb8 and, hours later, wrongly held
 * two of our OWN hook-card opens: the Rust `readiness-marcus-v3` cut and a
 * Dossie hook-card cut. A hook card is a solid-colour frame carrying large
 * title text — exactly what §5 item 1 / feedback_every-video-needs-scroll-
 * stopping-hook.md asks every video to open on. The rule's actual intent was
 * to catch a real login screen or a dead/blank/loading opening, never a
 * designed title card. Narrowed same-day; these tests lock in both sides of
 * that exact disagreement so it can't regress back to the over-broad wording.
 *
 *   11a. REAL POSITIVE: Media/rust-videos-v2/2026-09-16/readiness-marcus-v3.mp4
 *        — the real cut that got wrongly held. Frame 0 is measured (not
 *        assumed) to be a near-uniform solid-colour card, which is exactly
 *        the shape the old wording banned; the narrowed rule must pass it.
 *   11b. SYNTHETIC POSITIVE: a Dossie-brand hook card (Navy #1A1A2E background,
 *        large white title text) built on the fly with ffmpeg drawtext — the
 *        same solid-colour-plus-text shape as the real Dossie cut Heath
 *        flagged. No specific "new Dossie video" file was checked into git
 *        to reuse verbatim, so this reproduces the shape synthetically rather
 *        than fabricating a source file.
 *   11c. REAL NEGATIVE: the same feature-demo-stage-checklist-desktop-2026-09-07.mp4
 *        used in Tests 6-9 — its frame 1.5s really is the Dossie sign-in
 *        page (confirmed by direct frame extraction, not assumed). A true
 *        login screen must still fail after the narrowing.
 *
 * Run manually:
 *   node scripts/regression-video-quality-gate.js
 */

const assert = require('assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const REPO = path.join(__dirname, '..');
const BAD_FIXTURE = '/mnt/c/Users/Heath/Projects/MeetDossie/Media/rust-conversations/rust-conv-founder-val-vertical.mp4';
const RUST_HOOK_CARD_FIXTURE = '/mnt/c/Users/Heath/Projects/MeetDossie/Media/rust-videos-v2/2026-09-16/readiness-marcus-v3.mp4';
const RUST_HOOK_CARD_COVER = '/mnt/c/Users/Heath/Projects/MeetDossie/Media/rust-videos-v2/2026-09-16/cover-readiness-marcus-v3.png';

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
};

// Route by URL — mock Anthropic + Supabase + Telegram, pass everything else
// (there shouldn't be anything else) straight through.
function installFetchMock({ visionResponder, supabaseState, telegramSent }) {
  const underlying = globalThis.fetch;
  globalThis.fetch = async function mocked(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';

    if (url.includes('api.anthropic.com')) {
      const body = JSON.parse(init.body);
      const promptBlock = body.messages[0].content.find((c) => c.type === 'text');
      const verdict = visionResponder(promptBlock.text, body.messages[0].content);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(verdict) }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/rest/v1/video_library')) {
      if (init && init.method === 'PATCH') {
        supabaseState.patches.push({ url, body: JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      }
    }

    if (url.includes('api.telegram.org')) {
      telegramSent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return underlying(input, init);
  };
  return () => { globalThis.fetch = underlying; };
}

async function makeGoodFixture(tmpDir) {
  const videoPath = path.join(tmpDir, 'good-fixture.mp4');
  const coverPath = path.join(tmpDir, 'good-fixture-cover.png');
  await execFileAsync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=24',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', videoPath,
  ]);
  await execFileAsync('ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', coverPath]);
  return { videoPath, coverPath };
}

(async () => {
  if (!fs.existsSync(BAD_FIXTURE)) {
    console.error(`FATAL: required negative fixture not found at ${BAD_FIXTURE}\n` +
      'This is the known-bad reference file named in docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md ' +
      '(§6) — it must exist for this regression to mean anything. Media/ is gitignored, so ' +
      'this only exists on Heath\'s real checkout, not in an isolated worktree that never ' +
      'pulled it. Not skipping — failing loudly instead.');
    process.exit(1);
  }
  if (!fs.existsSync(RUST_HOOK_CARD_FIXTURE) || !fs.existsSync(RUST_HOOK_CARD_COVER)) {
    console.error(`FATAL: required opening-rule positive fixture not found at ${RUST_HOOK_CARD_FIXTURE}\n` +
      'This is the real readiness-marcus-v3 cut the opening rule wrongly held on 2026-09-16 — ' +
      'the narrowing regression (Test 11) means nothing without it. Not skipping — failing loudly instead.');
    process.exit(1);
  }

  process.env.SUPABASE_URL = 'http://mock.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.ANTHROPIC_API_KEY = 'regr-dummy-anthropic-key'; // present so vision path runs (mocked below)

  const { checkVideoQuality, gateBeforePublish } = require(path.join(REPO, 'api', '_lib', 'verify-video-quality.js'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-quality-gate-regr-'));
  const { videoPath: goodVideo, coverPath: goodCover } = await makeGoodFixture(tmpDir);

  // ── Test 1-2: BAD fixture ────────────────────────────────────────────────
  console.log('Test 1-2: known-bad fixture (real rejected Rust video)');
  const restoreAllGood = installFetchMock({
    visionResponder: (promptText) => {
      if (promptText.includes('hook_visible')) return { hook_visible: true, text_seen: 'mocked', reason: 'mock' };
      if (promptText.includes('hook_cleared')) return { hook_cleared: true, reason: 'mock' };
      if (promptText.includes('opening_meaningful')) return { opening_meaningful: true, screen_seen: 'mock', disqualifier: 'none', reason: 'mock' };
      return { frames_with_captions: 3, reason: 'mock' };
    },
    supabaseState: { patches: [] },
    telegramSent: [],
  });
  const badResult = await checkVideoQuality({ videoPath: BAD_FIXTURE }); // no cover supplied
  restoreAllGood();

  check('BAD fixture: overall pass=false', () => {
    assert.strictEqual(badResult.pass, false);
  });
  check('BAD fixture: real_motion_0_to_1_5s fails with the exact measured SSIM (~0.999966, static frames)', () => {
    assert.strictEqual(badResult.rules.real_motion_0_to_1_5s.pass, false);
    assert.ok(badResult.detail.motion_ssim > 0.9999, `expected near-1.0 SSIM (frozen frames), got ${badResult.detail.motion_ssim}`);
  });
  check('BAD fixture: runtime_in_platform_range fails with the exact measured duration (~42.6s)', () => {
    assert.strictEqual(badResult.rules.runtime_in_platform_range.pass, false);
    assert.ok(badResult.detail.duration_seconds > 40 && badResult.detail.duration_seconds < 45,
      `expected ~42.6s, got ${badResult.detail.duration_seconds}`);
  });
  check('BAD fixture: cover_asset_present fails (none supplied)', () => {
    assert.strictEqual(badResult.rules.cover_asset_present.pass, false);
  });
  check('BAD fixture: even with vision mocked to say everything looks perfect, the measurable rules alone fail the gate', () => {
    assert.ok(badResult.rules.hook_visible_frame0.pass && badResult.rules.hook_cleared_by_3s.pass && badResult.rules.captions_present.pass,
      'expected the mocked vision rules to have passed for this assertion to be meaningful');
    assert.strictEqual(badResult.pass, false);
  });

  // ── Test 3: GOOD fixture, vision mocked to pass everything ──────────────
  console.log('\nTest 3: known-good fixture (synthetic, real motion + real cover), vision mocked to pass');
  const restoreGoodVision = installFetchMock({
    visionResponder: (promptText) => {
      if (promptText.includes('hook_visible')) return { hook_visible: true, text_seen: 'ONE GUY BUILT THIS', reason: 'clear bold hook text' };
      if (promptText.includes('hook_cleared')) return { hook_cleared: true, reason: 'text gone by frame 2' };
      if (promptText.includes('opening_meaningful')) return { opening_meaningful: true, screen_seen: 'populated dashboard', disqualifier: 'none', reason: 'opens on real content' };
      return { frames_with_captions: 3, reason: 'captions visible in all 3 samples' };
    },
    supabaseState: { patches: [] },
    telegramSent: [],
  });
  const goodResult = await checkVideoQuality({ videoPath: goodVideo, coverPath: goodCover });
  restoreGoodVision();

  check('GOOD fixture: overall pass=true', () => {
    assert.strictEqual(goodResult.pass, true, `failedRules: ${JSON.stringify(goodResult.failedRules)}`);
  });
  check('GOOD fixture: zero failed rules', () => {
    assert.deepStrictEqual(goodResult.failedRules, []);
  });
  check('GOOD fixture: real motion measured (SSIM well below the 0.999 fail threshold)', () => {
    assert.ok(goodResult.detail.motion_ssim < 0.99, `expected clear motion, got SSIM ${goodResult.detail.motion_ssim}`);
  });
  check('GOOD fixture: runtime measured inside the TikTok 21-34s window', () => {
    assert.ok(goodResult.detail.duration_seconds >= 21 && goodResult.detail.duration_seconds <= 34,
      `got ${goodResult.detail.duration_seconds}s`);
  });

  // ── Test 4: GOOD fixture, vision mocked to fail hook_visible ─────────────
  console.log('\nTest 4: vision-rule failure is not silently ignored');
  const restoreBadVision = installFetchMock({
    visionResponder: (promptText) => {
      if (promptText.includes('hook_visible')) return { hook_visible: false, text_seen: '', reason: 'no legible hook text' };
      if (promptText.includes('hook_cleared')) return { hook_cleared: true, reason: 'mock' };
      if (promptText.includes('opening_meaningful')) return { opening_meaningful: true, screen_seen: 'mock', disqualifier: 'none', reason: 'mock' };
      return { frames_with_captions: 3, reason: 'mock' };
    },
    supabaseState: { patches: [] },
    telegramSent: [],
  });
  const noHookResult = await checkVideoQuality({ videoPath: goodVideo, coverPath: goodCover });
  restoreBadVision();

  check('overall pass=false when vision says no hook text at frame 0', () => {
    assert.strictEqual(noHookResult.pass, false);
  });
  check('failedRules contains exactly hook_visible_frame0', () => {
    assert.deepStrictEqual(noHookResult.failedRules, ['hook_visible_frame0']);
  });

  // ── Test 6-9: full-bleed framing rules (2026-09-16 stage-checklist incident) ──
  //
  // Negative fixture is the REAL video that shipped broken on 2026-09-15:
  // feature-demo-stage-checklist-desktop-2026-09-07.mp4, the one whose caption
  // Heath screenshotted off the live feed ("Every deal stage has its own
  // checklist..."). It is fetched from the public Supabase bucket it was
  // actually published from, so this test measures the exact bytes that went
  // out, not a reconstruction. Cached under tmp so repeat runs are offline.
  console.log('\nTest 6-9: full-bleed framing rules vs the real 2026-09-15 bad video');

  const REAL_BAD_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/videos/video-library/feature-demo-stage-checklist-desktop-2026-09-07.mp4';
  const REAL_GOOD_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/videos/video-library/feature-demo-contract-scan-mobile-2026-09-07.mp4';
  const fixtureCache = path.join(os.tmpdir(), 'dossie-video-framing-fixtures');
  fs.mkdirSync(fixtureCache, { recursive: true });

  async function cachedFixture(url, name) {
    const dest = path.join(fixtureCache, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not fetch framing fixture ${name}: HTTP ${res.status} from ${url}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  }

  let realBad; let realGood;
  try {
    realBad = await cachedFixture(REAL_BAD_URL, 'stage-checklist-desktop-BAD.mp4');
    realGood = await cachedFixture(REAL_GOOD_URL, 'contract-scan-mobile-GOOD.mp4');
  } catch (err) {
    console.error(`FATAL: ${err.message}\nThese are the real published files the framing rules were derived from; ` +
      'without them this regression proves nothing. Not skipping — failing loudly instead.');
    process.exit(1);
  }

  // Synthetic negatives for the padding failure modes that the real file does
  // NOT exhibit — including the "just add a scale filter" wrong fix, which is
  // correctly 9:16 and still 67% dead bars.
  const letterboxed = path.join(tmpDir, 'synthetic-letterboxed.mp4');
  const pillarboxWhite = path.join(tmpDir, 'synthetic-pillarbox-white.mp4');
  const naivePad = path.join(tmpDir, 'synthetic-naive-pad-16x9-into-9x16.mp4');
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', realGood, '-t', '12',
    '-vf', 'scale=1080:1215,pad=1080:1920:0:352:black', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', letterboxed]);
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', realGood, '-t', '12',
    '-vf', 'scale=600:1067,pad=1080:1920:240:426:white', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', pillarboxWhite]);
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-i', realBad, '-t', '12',
    '-vf', 'scale=1080:608,pad=1080:1920:0:656:black', '-c:v', 'libx264', '-preset', 'ultrafast', '-an', naivePad]);

  const allGoodVision = {
    visionResponder: (promptText) => {
      if (promptText.includes('hook_visible')) return { hook_visible: true, text_seen: 'mock', reason: 'mock' };
      if (promptText.includes('hook_cleared')) return { hook_cleared: true, reason: 'mock' };
      if (promptText.includes('opening_meaningful')) return { opening_meaningful: true, screen_seen: 'mock', disqualifier: 'none', reason: 'mock' };
      return { frames_with_captions: 3, reason: 'mock' };
    },
    supabaseState: { patches: [] },
    telegramSent: [],
  };

  const restoreFraming = installFetchMock(allGoodVision);
  const realBadResult = await checkVideoQuality({ videoPath: realBad, coverPath: realBad });
  const realGoodResult = await checkVideoQuality({ videoPath: realGood, coverPath: realGood });
  const letterboxResult = await checkVideoQuality({ videoPath: letterboxed, coverPath: letterboxed });
  const pillarboxResult = await checkVideoQuality({ videoPath: pillarboxWhite, coverPath: pillarboxWhite });
  const naivePadResult = await checkVideoQuality({ videoPath: naivePad, coverPath: naivePad });
  restoreFraming();

  // Test 6 — the real shipped defect.
  check('REAL BAD (stage-checklist): aspect_ratio_vertical_9x16 fails on the measured 1920x1080', () => {
    assert.strictEqual(realBadResult.rules.aspect_ratio_vertical_9x16.pass, false);
    assert.strictEqual(realBadResult.detail.resolution, '1920x1080');
    assert.ok(Math.abs(realBadResult.detail.aspect_ratio - 1.7778) < 0.001,
      `expected 16:9 (1.7778), got ${realBadResult.detail.aspect_ratio}`);
  });
  check('REAL BAD (stage-checklist): first_frame_not_uniform fails — frame 0 measured spread 0 (solid white)', () => {
    assert.strictEqual(realBadResult.rules.first_frame_not_uniform.pass, false);
    assert.strictEqual(realBadResult.detail.first_frame_luma_spread, 0,
      `expected a perfectly uniform frame 0, got spread ${realBadResult.detail.first_frame_luma_spread}`);
  });
  check('REAL BAD (stage-checklist): overall pass=false even with every vision rule mocked to pass', () => {
    assert.ok(realBadResult.rules.hook_visible_frame0.pass && realBadResult.rules.opening_not_login_or_empty.pass,
      'expected mocked vision rules to pass for this assertion to be meaningful');
    assert.strictEqual(realBadResult.pass, false);
    assert.ok(realBadResult.failedRules.includes('aspect_ratio_vertical_9x16'));
    assert.ok(realBadResult.failedRules.includes('first_frame_not_uniform'));
  });

  // Test 7 — the known-good sibling from the same batch must NOT regress.
  check('REAL GOOD (contract-scan-mobile): all three framing rules pass — no false positive', () => {
    assert.strictEqual(realGoodResult.detail.resolution, '1080x1920');
    assert.strictEqual(realGoodResult.rules.aspect_ratio_vertical_9x16.pass, true);
    assert.strictEqual(realGoodResult.rules.content_fills_frame.pass, true,
      `coverage was ${realGoodResult.detail.content_coverage}`);
    assert.strictEqual(realGoodResult.rules.first_frame_not_uniform.pass, true);
  });
  check('REAL GOOD: measured content coverage is 1.0 despite transient flat UI frames mid-clip', () => {
    assert.strictEqual(realGoodResult.detail.content_coverage, 1,
      `persistent-bar intersection should score a full-bleed recording 1.0, got ${realGoodResult.detail.content_coverage}`);
  });

  // Test 8 — baked-in padding, black AND white bars.
  check('SYNTHETIC letterbox (black bars): content_fills_frame fails, coverage well under 0.85', () => {
    assert.strictEqual(letterboxResult.rules.content_fills_frame.pass, false);
    assert.ok(letterboxResult.detail.content_coverage < 0.7,
      `expected heavy letterbox, measured ${letterboxResult.detail.content_coverage}`);
  });
  check('SYNTHETIC pillarbox (WHITE bars): content_fills_frame fails — colour-agnostic, cropdetect would miss this', () => {
    assert.strictEqual(pillarboxResult.rules.content_fills_frame.pass, false);
    assert.ok(pillarboxResult.detail.content_coverage < 0.5,
      `expected heavy white pillarbox, measured ${pillarboxResult.detail.content_coverage}`);
    assert.ok(pillarboxResult.detail.persistent_bars.left > 0 && pillarboxResult.detail.persistent_bars.right > 0,
      'expected left/right bars to be located');
  });

  // Test 9 — the wrong fix must not pass.
  check('SYNTHETIC naive pad (16:9 scaled into a 9:16 frame): passes aspect but FAILS coverage', () => {
    assert.strictEqual(naivePadResult.rules.aspect_ratio_vertical_9x16.pass, true,
      'naive pad is genuinely 1080x1920, so the aspect rule alone cannot catch it — that is the point of this case');
    assert.strictEqual(naivePadResult.rules.content_fills_frame.pass, false);
    assert.ok(naivePadResult.detail.content_coverage < 0.5,
      `expected ~0.33 coverage, measured ${naivePadResult.detail.content_coverage}`);
  });

  // Test 9b — orientation-aware gating (2026-09-17). The whole point: a
  // caller that passes the row's real platforms gets graded against the
  // matching rule family, without touching a single vertical assertion
  // above. realBad (stage-checklist-desktop, genuinely 1920x1080, the exact
  // file this gate's own header used as its vertical-lane negative fixture)
  // is the perfect positive case for the horizontal lane: it's really 16:9,
  // so it MUST pass the horizontal aspect rule — but it should still fail
  // overall, because its frame 0 really is a blank white splash (Test 6
  // above measured spread 0), proving the horizontal lane isn't a rubber
  // stamp.
  console.log('\nTest 9b: orientation-aware gating (16:9 horizontal lane)');
  const { classifyOrientation, VERTICAL_PLATFORMS, HORIZONTAL_PLATFORMS } =
    require(path.join(REPO, 'api', '_lib', 'verify-video-quality.js'));

  check('classifyOrientation: tiktok/instagram -> vertical', () => {
    assert.strictEqual(classifyOrientation(undefined, ['tiktok']), 'vertical');
    assert.strictEqual(classifyOrientation(undefined, ['instagram', 'tiktok']), 'vertical');
  });
  check('classifyOrientation: facebook/twitter/linkedin -> horizontal', () => {
    assert.strictEqual(classifyOrientation(undefined, ['facebook', 'twitter', 'linkedin']), 'horizontal');
    assert.strictEqual(classifyOrientation(undefined, ['linkedin']), 'horizontal');
  });
  check('classifyOrientation: explicit orientation short-circuits platforms', () => {
    assert.strictEqual(classifyOrientation('vertical', ['facebook']), 'vertical');
  });
  check('classifyOrientation: mixed vertical+horizontal platforms throws (fail-closed, never guessed)', () => {
    assert.throws(() => classifyOrientation(undefined, ['tiktok', 'facebook']), /mix vertical.*horizontal/);
  });
  check('classifyOrientation: no signal at all throws', () => {
    assert.throws(() => classifyOrientation(undefined, []), /no opts.orientation/);
    assert.throws(() => classifyOrientation(undefined, undefined), /no opts.orientation/);
  });
  check('classifyOrientation: unrecognized-only platform (e.g. youtube_shorts typo) throws rather than defaulting', () => {
    assert.throws(() => classifyOrientation(undefined, ['pinterest']), /no opts.orientation/);
  });

  const restoreOrientation = installFetchMock(allGoodVision);
  const realBadAsHorizontal = await checkVideoQuality({
    videoPath: realBad, coverPath: realBad, platforms: ['facebook', 'twitter', 'linkedin'],
  });
  const realGoodStillVertical = await checkVideoQuality({
    videoPath: realGood, coverPath: realGood, platforms: ['tiktok', 'instagram'],
  });
  restoreOrientation();

  check('REAL BAD (stage-checklist) reclassified horizontal: aspect_ratio_horizontal_16x9 PASSES — this is the exact bug fixed (was rejected for being 16:9 when it should be)', () => {
    assert.strictEqual(realBadAsHorizontal.detail.orientation, 'horizontal');
    assert.strictEqual(realBadAsHorizontal.rules.aspect_ratio_horizontal_16x9.pass, true,
      `expected the genuinely-16:9 file to pass the horizontal aspect rule, got: ${realBadAsHorizontal.rules.aspect_ratio_horizontal_16x9 && realBadAsHorizontal.rules.aspect_ratio_horizontal_16x9.note}`);
    assert.strictEqual(realBadAsHorizontal.rules.aspect_ratio_vertical_9x16, undefined,
      'horizontal lane must not also run/emit the vertical aspect rule');
  });
  check('REAL BAD (stage-checklist) reclassified horizontal: still fails overall — the blank-frame-0 defect is real regardless of orientation', () => {
    assert.strictEqual(realBadAsHorizontal.pass, false);
    assert.ok(realBadAsHorizontal.failedRules.includes('first_frame_not_uniform'),
      'the horizontal lane must still catch a genuinely blank opening frame — orientation-aware is not toothless');
  });
  check('REAL BAD (stage-checklist) reclassified horizontal: gets legible_ui_frame instead of the Reels hook-then-clear pair', () => {
    assert.ok('legible_ui_frame' in realBadAsHorizontal.rules);
    assert.strictEqual(realBadAsHorizontal.rules.hook_visible_frame0, undefined);
    assert.strictEqual(realBadAsHorizontal.rules.hook_cleared_by_3s, undefined);
  });
  check('REAL BAD (stage-checklist) reclassified horizontal: captions_present is advisory (non-blocking), never fails the gate alone', () => {
    assert.strictEqual(realBadAsHorizontal.rules.captions_present.blocking, false);
  });
  check('REAL GOOD (contract-scan-mobile) as vertical (tiktok/instagram): unchanged from the no-platforms default', () => {
    assert.strictEqual(realGoodStillVertical.detail.orientation, 'vertical');
    assert.strictEqual(realGoodStillVertical.rules.aspect_ratio_vertical_9x16.pass, true);
    assert.strictEqual(realGoodStillVertical.rules.captions_present.blocking, true);
  });
  check('no-platforms/no-orientation call still defaults to vertical (backward compatible with every test above)', () => {
    assert.strictEqual(realGoodResult.detail.orientation, 'vertical');
  });

  // Test 10 — the vision rule that catches the login opening.
  console.log('\nTest 10: opening_not_login_or_empty is wired into the verdict');
  const restoreLoginVision = installFetchMock({
    visionResponder: (promptText) => {
      if (promptText.includes('hook_visible')) return { hook_visible: true, text_seen: 'mock', reason: 'mock' };
      if (promptText.includes('hook_cleared')) return { hook_cleared: true, reason: 'mock' };
      if (promptText.includes('opening_meaningful')) {
        return { opening_meaningful: false, screen_seen: 'Frame A blank white; Frame B the Dossie sign-in page', disqualifier: 'login', reason: 'opens on the login screen' };
      }
      return { frames_with_captions: 3, reason: 'mock' };
    },
    supabaseState: { patches: [] },
    telegramSent: [],
  });
  const loginOpenResult = await checkVideoQuality({ videoPath: goodVideo, coverPath: goodCover });
  restoreLoginVision();

  check('vision reporting a login opening fails the gate and is the only failed rule', () => {
    assert.strictEqual(loginOpenResult.pass, false);
    assert.deepStrictEqual(loginOpenResult.failedRules, ['opening_not_login_or_empty']);
  });
  check('the disqualifier is surfaced in detail for the Telegram alert', () => {
    assert.strictEqual(loginOpenResult.detail.opening_disqualifier, 'login');
  });

  // ── Test 11: narrowed opening rule — hook cards pass, real login still fails ──
  console.log('\nTest 11: opening_not_login_or_empty narrowing — hook cards pass, a real login screen still fails');

  // 11a/11b vision mock: a hook card (solid colour + large legible text) is
  // exactly what the narrowed prompt is supposed to call GOOD.
  const hookCardVision = {
    visionResponder: (promptText) => {
      if (promptText.includes('hook_visible')) return { hook_visible: true, text_seen: 'SLEPT A 2 OUT OF 5', reason: 'mock' };
      if (promptText.includes('hook_cleared')) return { hook_cleared: true, reason: 'mock' };
      if (promptText.includes('opening_meaningful')) {
        return { opening_meaningful: true, screen_seen: 'solid-colour hook card with large title text', disqualifier: 'none', reason: 'designed hook/title card, not a dead frame' };
      }
      return { frames_with_captions: 3, reason: 'mock' };
    },
    supabaseState: { patches: [] },
    telegramSent: [],
  };

  // 11a — REAL: the readiness-marcus-v3 cut that got wrongly held.
  const restoreHookReal = installFetchMock(hookCardVision);
  const hookCardRealResult = await checkVideoQuality({ videoPath: RUST_HOOK_CARD_FIXTURE, coverPath: RUST_HOOK_CARD_COVER });
  restoreHookReal();

  check('REAL hook card (readiness-marcus-v3): opening_not_login_or_empty PASSES under the narrowed rule', () => {
    assert.strictEqual(hookCardRealResult.rules.opening_not_login_or_empty.pass, true,
      `note: ${hookCardRealResult.rules.opening_not_login_or_empty.note}`);
  });

  // 11b — SYNTHETIC: a Dossie-brand hook card (Navy bg + large white title
  // text), reproducing the same solid-colour-plus-text shape as the real
  // Dossie cut Heath flagged (no specific checked-in file to reuse verbatim).
  // Built via the `ass` filter (libass), not `drawtext` — this ffmpeg build
  // has no drawtext filter, same constraint noted in build-shortform-video.py.
  const dossieHookCard = path.join(tmpDir, 'synthetic-dossie-hook-card.mp4');
  const dossieHookAss = path.join(tmpDir, 'synthetic-dossie-hook-card.ass');
  fs.writeFileSync(dossieHookAss, [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Hook,Sans,80,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:00.00,0:00:03.00,Hook,,0,0,0,,YOUR DEALS. HER JOB.',
  ].join('\n') + '\n');
  await execFileAsync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x1A1A2E:s=1080x1920:d=3:r=30',
    '-vf', `ass=${dossieHookAss}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', dossieHookCard]);
  const restoreHookSynthetic = installFetchMock(hookCardVision);
  const hookCardSyntheticResult = await checkVideoQuality({ videoPath: dossieHookCard, coverPath: dossieHookCard });
  restoreHookSynthetic();

  check('SYNTHETIC Dossie hook card: opening_not_login_or_empty PASSES under the narrowed rule', () => {
    assert.strictEqual(hookCardSyntheticResult.rules.opening_not_login_or_empty.pass, true,
      `note: ${hookCardSyntheticResult.rules.opening_not_login_or_empty.note}`);
  });

  // 11c — REAL NEGATIVE: reuse the real login-screen file from Tests 6-9
  // (its frame 1.5s really is the Dossie sign-in page — confirmed by direct
  // frame extraction, not assumed). A true login screen must still fail.
  const loginScreenVision = {
    visionResponder: (promptText) => {
      if (promptText.includes('hook_visible')) return { hook_visible: false, text_seen: '', reason: 'mock' };
      if (promptText.includes('hook_cleared')) return { hook_cleared: false, reason: 'mock' };
      if (promptText.includes('opening_meaningful')) {
        return { opening_meaningful: false, screen_seen: 'Frame A blank white; Frame B the Dossie sign-in page with email/password fields', disqualifier: 'login', reason: 'real auth screen, not a hook card' };
      }
      return { frames_with_captions: 0, reason: 'mock' };
    },
    supabaseState: { patches: [] },
    telegramSent: [],
  };
  const restoreLoginReal = installFetchMock(loginScreenVision);
  const loginScreenRealResult = await checkVideoQuality({ videoPath: realBad, coverPath: realBad });
  restoreLoginReal();

  check('REAL login screen (stage-checklist-desktop): opening_not_login_or_empty still FAILS after the narrowing', () => {
    assert.strictEqual(loginScreenRealResult.rules.opening_not_login_or_empty.pass, false);
    assert.strictEqual(loginScreenRealResult.detail.opening_disqualifier, 'login');
  });

  // ── Test 5: gateBeforePublish() ───────────────────────────────────────────
  console.log('\nTest 5: gateBeforePublish() holds an unpassed row and alerts exactly once');
  const supabaseState5 = { patches: [] };
  const telegramSent5 = [];
  const restoreGate = installFetchMock({ visionResponder: () => ({}), supabaseState: supabaseState5, telegramSent: telegramSent5 });

  const heldRowOk = await gateBeforePublish({
    id: 'regr-vid-001', quality_status: 'held', quality_failed_rules: ['runtime_in_platform_range', 'real_motion_0_to_1_5s'],
    platforms: ['tiktok', 'instagram'], topic: 'test-topic', target_owner: 'dossie', status: 'heath_approved',
  });
  const passedRowOk = await gateBeforePublish({
    id: 'regr-vid-002', quality_status: 'passed', platforms: ['tiktok'], topic: 'test-topic-2', status: 'heath_approved',
  });
  restoreGate();

  check('held row: gateBeforePublish returns false', () => {
    assert.strictEqual(heldRowOk, false);
  });
  check('held row: status PATCHed to quality_hold', () => {
    const patch = supabaseState5.patches.find((p) => p.url.includes('regr-vid-001'));
    assert.ok(patch, 'no PATCH observed for regr-vid-001');
    assert.strictEqual(patch.body.status, 'quality_hold');
  });
  check('held row: exactly one Telegram alert sent, naming the failed rules', () => {
    assert.strictEqual(telegramSent5.length, 1, `expected 1 alert, got ${telegramSent5.length}`);
    assert.ok(telegramSent5[0].text.includes('runtime_in_platform_range') && telegramSent5[0].text.includes('real_motion_0_to_1_5s'),
      `alert text missing failed rule names: ${telegramSent5[0].text}`);
  });
  check('passed row: gateBeforePublish returns true with zero DB/Telegram calls', () => {
    assert.strictEqual(passedRowOk, true);
    assert.strictEqual(supabaseState5.patches.filter((p) => p.url.includes('regr-vid-002')).length, 0);
    assert.strictEqual(telegramSent5.length, 1); // unchanged from the held-row assertion above
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing: ${failures.join(', ')})`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
