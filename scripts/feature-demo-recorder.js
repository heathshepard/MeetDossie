'use strict';

// scripts/feature-demo-recorder.js
//
// Playwright recorder for Dossie feature-demo videos. Drives the production
// Dossie app at https://meetdossie.com/app using the seeded demo account
// (Sarah Whitley, demo@meetdossie.com) and records 1080p webm/mp4.
//
// Input: a scene-script JSON file under scripts/feature-demo-scenes/.
// Output: raw .webm in Media/feature-demos/raw/ — converted to MP4 by
// feature-demo-merge.js.
//
// Usage:
//   node scripts/feature-demo-recorder.js scripts/feature-demo-scenes/first-dossier-desktop.json
//
// Env vars (from .env.local):
//   DEMO_PASSWORD = $DEMO_PASSWORD  (Sarah Whitley demo account)

const fs = require('fs');
const path = require('path');

// ─── Env loader ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const RAW_DIR = path.join(__dirname, '..', 'Media', 'feature-demos', 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

// ─── Session-mint helper (for mid-recording account switches) ────────────────
//
// Same magiclink-mint pattern as scripts/carter-jarvis-typed-text-bridge-
// bridge-verify.js and friends, generalized to any email + reusable mid-scene
// (the "switch_account" action below) rather than only at sign-in. Needed for
// the 2026-08-23 TC-role beat: showing the SAME roster/dossier data through a
// different member's restricted (no admin controls) view means actually
// becoming that user, not narrating over a screenshot.
async function mintSessionFor(email) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink failed for ${email}: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  if (!hashedToken) throw new Error(`generateLink returned no hashed_token for ${email}`);
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed for ${email}: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return { access_token: verifyData.access_token, refresh_token: verifyData.refresh_token, user: verifyData.user };
}

// ─── Mouse helpers ────────────────────────────────────────────────────────────

async function moveToElement(page, element) {
  const box = await element.boundingBox();
  if (!box) return;
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  await page.mouse.move(targetX, targetY, { steps: 20 });
  await page.waitForTimeout(180);
}

// Some elements on meetdossie.com/app never pass Playwright's "stable"
// actionability check (a CSS transition keeps recomputing their box), which
// hangs a plain .click() indefinitely. Try a normal click first (best for
// realistic recorded interaction); fall back to a forced click so the scene
// doesn't stall the whole recording.
async function clickRobust(loc, opts = {}) {
  try {
    await loc.click({ timeout: 6000, ...opts });
  } catch {
    await loc.click({ force: true, timeout: 6000, ...opts });
  }
}

async function smoothScrollBy(page, y) {
  await page.evaluate((yy) => window.scrollBy({ top: yy, behavior: 'smooth' }), y);
}

// ─── Fatal scene errors ───────────────────────────────────────────────────────
//
// The per-scene loop in record() deliberately SWALLOWS scene failures ("we'd
// rather ship a slightly-flawed video than abandon the whole take"). That is
// the right default for a missed hover or an unstable click — and it is
// exactly what shipped 35 seconds of Dossie's login page, twice: sign-in
// silently failed, every later scene threw against a page that was still the
// sign-in form, each threw quietly, and the recorder reported DONE over a
// video of nothing but the login screen (see api/_lib/verify-video-quality.js's
// opening_not_login_or_empty rule, added for those two files).
//
// A FatalSceneError is the narrow exception: it means the recording's
// premise is false, so no amount of later footage can rescue the take. It is
// re-thrown out of the scene loop, the partial .webm is deleted, and the
// process exits non-zero and loud. Nothing "continues on" from here.
class FatalSceneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalSceneError';
    this.fatal = true;
  }
}

// Reads the same authenticated-session evidence the app itself runs on:
// dossie-app.jsx persists the Supabase session under the localStorage key
// 'supabase.auth.token' (not the sb-<ref>-auth-token library default — see
// the switch_account handler below). Three independent signals, because any
// one alone has a false-positive mode: a stale token can outlive its session,
// a missing password field can just mean the form hasn't rendered yet, and a
// signed-in chrome element can be server-rendered shell.
async function readAuthState(page) {
  return page.evaluate(() => {
    let token = null;
    try {
      const raw = localStorage.getItem('supabase.auth.token');
      if (raw) {
        const parsed = JSON.parse(raw);
        const session = parsed && parsed.currentSession ? parsed.currentSession : parsed;
        if (session && session.access_token) {
          token = { email: (session.user && session.user.email) || null, expires_at: session.expires_at || null };
        }
      }
    } catch (_) { /* unparseable == not signed in */ }
    const passwordField = document.querySelector("input[type='password']");
    const passwordVisible = !!passwordField && !!passwordField.offsetParent;
    const bodyText = document.body ? document.body.innerText : '';
    return {
      token,
      passwordVisible,
      hasSignOut: /sign\s*out/i.test(bodyText),
      sample: bodyText.slice(0, 200),
    };
  });
}

// ─── Scene action handlers ────────────────────────────────────────────────────

async function runScene(page, scene, scriptCfg, ctx = {}) {
  const action = scene.action;
  switch (action) {
    case 'assert_signed_in': {
      // HARD GATE — the one scene that is allowed to kill the take.
      //
      // Also stamps ctx.contentStartMs: the offset, from the first recorded
      // frame, at which the signed-in product UI was actually on screen.
      // feature-demo-merge.js seeks past everything before it, so the final
      // mp4 opens on real UI instead of the browser's white startup frame and
      // the sign-in form. That matters beyond taste — the quality gate takes
      // frame 0 as the video's cover asset and grades frames 0.0s/1.5s with
      // opening_not_login_or_empty, so an untrimmed take cannot pass.
      const expectedEmail = (scene.email || scriptCfg.demo_account || 'demo@meetdossie.com').toLowerCase();
      const timeout = scene.timeout || 30000;
      const deadline = Date.now() + timeout;
      let state = null;
      console.log(`  [scene] assert_signed_in -> waiting for a real ${expectedEmail} session (<=${timeout}ms)`);
      while (Date.now() < deadline) {
        state = await readAuthState(page).catch(() => null);
        if (state && state.token && !state.passwordVisible && state.hasSignOut) break;
        await page.waitForTimeout(500);
      }
      if (!state || !state.token) {
        throw new FatalSceneError(
          `NOT SIGNED IN after ${timeout}ms — no usable Supabase session in localStorage. ` +
          `Page still shows: "${(state && state.sample ? state.sample : '(unreadable)').replace(/\s+/g, ' ').slice(0, 160)}". ` +
          `Refusing to film an unauthenticated app: this is the exact failure that shipped 35s of the login screen twice. ` +
          `Check DEMO_PASSWORD in .env.local and that ${expectedEmail} can still sign in.`
        );
      }
      if (state.passwordVisible) {
        throw new FatalSceneError('A password field is still VISIBLE — the sign-in form is on screen, so the session is not in effect yet. Aborting rather than filming it.');
      }
      if (!state.hasSignOut) {
        throw new FatalSceneError('Session token present but no signed-in chrome rendered (no "Sign Out" anywhere on the page) — the app has not actually entered its authenticated state. Aborting.');
      }
      const actual = (state.token.email || '').toLowerCase();
      if (actual !== expectedEmail) {
        throw new FatalSceneError(
          `WRONG ACCOUNT — signed in as "${actual || '(no email on session)'}" but this scene expects "${expectedEmail}". ` +
          `Refusing to record: a feature demo must never be filmed against a real customer's data.`
        );
      }
      // Give the authenticated first paint a beat to settle before marking it
      // as the trim point, so the trimmed opening frame is rendered UI rather
      // than a half-painted transition.
      await page.waitForTimeout(scene.settle_ms || 1200);
      ctx.contentStartMs = Date.now() - ctx.sessionStart;
      console.log(`  [scene] assert_signed_in -> OK, ${actual}; content starts at +${ctx.contentStartMs}ms`);
      break;
    }
    case 'navigate': {
      console.log(`  [scene] navigate -> ${scene.url}`);
      await page.goto(scene.url, { waitUntil: scene.wait_until || 'domcontentloaded', timeout: 30000 });
      break;
    }
    case 'login_if_visible': {
      const emailLocator = page.locator(scene.email_selector || "input[type='email']").first();
      const visible = await emailLocator.isVisible({ timeout: 5000 }).catch(() => false);
      if (!visible) {
        console.log('  [scene] login_if_visible -> already logged in, skip');
        break;
      }
      console.log('  [scene] login_if_visible -> signing in');

      // The auth card boots in MAGIC-LINK mode: the password input is rendered
      // conditionally and the submit control reads "Email Me a Magic Link" with
      // no type="submit" attribute. The old selectors here
      // (input[type=password] / button[type=submit]) therefore matched nothing,
      // the wait threw, the per-scene catch in record() swallowed it, and the
      // recorder happily filmed the whole timeline against the login page —
      // that is exactly how feature-demo-stage-checklist-desktop-2026-09-07
      // shipped as 35s of sign-in screen on 2026-09-15.
      // Flip to password mode first, the same way every other working script in
      // this repo does (see scripts/carter-verify-team-nav.js).
      const pwToggle = page.getByRole('button', { name: /^password$/i });
      if (await pwToggle.count()) {
        await clickRobust(pwToggle.first());
      }

      await moveToElement(page, emailLocator);
      await clickRobust(emailLocator);
      await emailLocator.fill(scriptCfg.demo_account || 'demo@meetdossie.com');

      const passLocator = page.locator(scene.password_selector || "input[type='password']").first();
      await passLocator.waitFor({ state: 'visible', timeout: 10000 });
      await moveToElement(page, passLocator);
      await clickRobust(passLocator);
      if (!DEMO_PASSWORD) {
        throw new Error('DEMO_PASSWORD is not set — cannot sign in. Refusing to record an unauthenticated take.');
      }
      await passLocator.fill(DEMO_PASSWORD);

      const submit = scene.submit_selector
        ? page.locator(scene.submit_selector).first()
        : page.getByRole('button', { name: /^sign in$/i }).first();
      await submit.waitFor({ state: 'visible', timeout: 10000 });
      await moveToElement(page, submit);
      await clickRobust(submit);

      // Sign-in MUST actually complete. Without this assertion a failed login
      // is invisible until a human watches the finished video (or, as on
      // 2026-09-15, until it is already live on Facebook).
      await emailLocator.waitFor({ state: 'detached', timeout: 20000 }).catch(async () => {
        const stillThere = await emailLocator.isVisible().catch(() => false);
        if (stillThere) {
          throw new Error(
            'sign-in did not complete — the email field is still on screen after submitting. '
            + 'Refusing to record a take of the login page.',
          );
        }
      });
      console.log('  [scene] login_if_visible -> signed in');
      break;
    }
    case 'wait_for_text': {
      console.log(`  [scene] wait_for_text -> "${scene.text}"`);
      await page.waitForSelector(`text=${scene.text}`, { timeout: scene.timeout || 15000 });
      break;
    }
    case 'wait_for_text_gone': {
      // Waits for a transient state indicator (e.g. a chat "Thinking..."
      // bubble) to disappear — the inverse of wait_for_text. Added for the
      // team-sales-demo-2 recording (2026-08-23), which needs to wait out a
      // real LLM chat response before moving on, and has no stable
      // className/testid to hook a "response arrived" check to instead.
      console.log(`  [scene] wait_for_text_gone -> "${scene.text}"`);
      const loc = page.getByText(scene.text, { exact: scene.exact === true }).first();
      await loc.waitFor({ state: 'hidden', timeout: scene.timeout || 30000 }).catch(() => {
        console.log(`    (still visible after timeout — continuing anyway)`);
      });
      break;
    }
    case 'switch_account': {
      // Mid-recording context switch to a different real account (mints a
      // fresh session, overwrites the storageKey dossie-app.jsx actually
      // reads, reloads). See carter-email-integration-merge-verify.js for
      // why the key is 'supabase.auth.token', not the sb-<ref>-auth-token
      // library default.
      console.log(`  [scene] switch_account -> ${scene.email}`);
      const session = await mintSessionFor(scene.email);
      await page.evaluate(({ key, sessionObj }) => {
        localStorage.setItem(key, JSON.stringify({
          access_token: sessionObj.access_token, refresh_token: sessionObj.refresh_token,
          token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: sessionObj.user,
        }));
      }, { key: 'supabase.auth.token', sessionObj: session });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    }
    case 'select_option': {
      console.log(`  [scene] select_option -> ${scene.selector} = "${scene.label}"`);
      const loc = page.locator(scene.selector).first();
      await loc.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      await moveToElement(page, loc);
      await loc.selectOption({ label: scene.label });
      break;
    }
    case 'click_button_in_row': {
      // Scopes a click to the specific roster/list row containing row_text,
      // then clicks button_text within that row — needed once a page has
      // multiple identical-text buttons (e.g. every roster row has its own
      // "Remove" button). TeamView.jsx's roster rows are role="button" divs.
      console.log(`  [scene] click_button_in_row -> row="${scene.row_text}" button="${scene.button_text}"`);
      const row = page.locator('[role="button"]').filter({ hasText: scene.row_text }).first();
      await row.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      const btn = row.getByText(scene.button_text, { exact: scene.exact === true }).first();
      await moveToElement(page, btn);
      await clickRobust(btn);
      break;
    }
    case 'click_text': {
      console.log(`  [scene] click_text -> "${scene.text}"`);
      const loc = page.getByText(scene.text, { exact: scene.exact === true }).first();
      await loc.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      await moveToElement(page, loc);
      await clickRobust(loc);
      break;
    }
    case 'click_selector': {
      console.log(`  [scene] click_selector -> ${scene.selector}`);
      const loc = page.locator(scene.selector).first();
      await loc.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      await moveToElement(page, loc);
      await clickRobust(loc);
      break;
    }
    case 'type_into': {
      console.log(`  [scene] type_into -> ${scene.selector}`);
      const loc = page.locator(scene.selector).first();
      await loc.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      await loc.focus();
      // clear_first: needed for pre-filled controlled inputs (e.g. the
      // rename field, which starts populated with the current org name) —
      // without it, typing just appends after the existing value.
      if (scene.clear_first) {
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Backspace');
      }
      // Use page.keyboard so we get realistic per-char typing
      await page.keyboard.type(scene.value, { delay: scene.delay_ms || 60 });
      break;
    }
    case 'press_escape': {
      console.log('  [scene] press_escape');
      await page.keyboard.press('Escape');
      break;
    }
    case 'click_close_modal': {
      console.log('  [scene] click_close_modal');
      const close = page.locator('button[aria-label="Close"]').first();
      const visible = await close.isVisible({ timeout: 3000 }).catch(() => false);
      if (!visible) {
        console.log('    no close button visible — skipping');
        break;
      }
      await moveToElement(page, close);
      await clickRobust(close);
      break;
    }
    case 'press_key': {
      console.log(`  [scene] press_key -> ${scene.key}`);
      await page.keyboard.press(scene.key);
      break;
    }
    case 'scroll_by': {
      console.log(`  [scene] scroll_by -> ${scene.y}px`);
      await smoothScrollBy(page, scene.y);
      break;
    }
    case 'scroll_to_top': {
      console.log('  [scene] scroll_to_top');
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
      break;
    }
    case 'scroll_to_deadlines': {
      // Try to find a "Deadlines" or "TREC" section header inside the dossier detail view
      console.log('  [scene] scroll_to_deadlines');
      const target = page.getByText(/deadlines|trec/i).first();
      const present = await target.isVisible({ timeout: 3000 }).catch(() => false);
      if (present) {
        await target.scrollIntoViewIfNeeded();
      } else {
        await smoothScrollBy(page, 400);
      }
      break;
    }
    case 'hover_first_deadline': {
      console.log('  [scene] hover_first_deadline');
      const candidates = [
        page.getByText(/option period/i).first(),
        page.getByText(/financing/i).first(),
        page.getByText(/closing/i).first(),
      ];
      for (const cand of candidates) {
        const ok = await cand.isVisible({ timeout: 1500 }).catch(() => false);
        if (ok) {
          await moveToElement(page, cand);
          await cand.hover();
          return;
        }
      }
      console.log('    no deadline label found — skipping hover');
      break;
    }
    case 'hover_pipeline_first_card':
    case 'hover_pipeline_nth_card': {
      const idx = action === 'hover_pipeline_first_card' ? 0 : (scene.index || 0);
      console.log(`  [scene] hover_pipeline card index=${idx}`);
      // Pipeline grid -> stage column -> deal card. Deal cards are the inline-
      // styled <div> children of the column that contain a text node. We use
      // the .pipeline-grid class as the anchor.
      const card = page.locator('.pipeline-grid > div > div').filter({ hasText: /\S/ }).nth(idx);
      const visible = await card.isVisible({ timeout: 3000 }).catch(() => false);
      if (!visible) {
        console.log('    no pipeline card matched — skipping');
        break;
      }
      await moveToElement(page, card);
      await card.hover();
      break;
    }
    case 'click_pipeline_first_card': {
      console.log('  [scene] click_pipeline_first_card');
      const card = page.locator('.pipeline-grid > div > div').filter({ hasText: /\S/ }).first();
      const visible = await card.isVisible({ timeout: 3000 }).catch(() => false);
      if (!visible) {
        console.log('    no pipeline card matched — skipping click');
        break;
      }
      await moveToElement(page, card);
      await clickRobust(card);
      break;
    }
    case 'final_pause': {
      console.log('  [scene] final_pause (let last frame breathe)');
      break;
    }
    default:
      console.warn(`  [scene] UNKNOWN action: ${action} — skipping`);
  }

  if (scene.pause) await page.waitForTimeout(scene.pause);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function record(scriptPath) {
  const scriptCfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  console.log(`[recorder] Loaded scene script: ${scriptCfg.name} (${scriptCfg.form_factor})`);

  const viewport = scriptCfg.viewport || { width: 1920, height: 1080 };
  // device_scale_factor decouples CSS viewport from recorded pixels. A vertical
  // 1080x1920 scene used to set viewport to the OUTPUT size, which put the page
  // above the 768px mobile breakpoint and recorded the DESKTOP layout. With
  // { viewport: 540x960, device_scale_factor: 2 } the page renders the real
  // mobile UI and the video still comes out 1080x1920 physical pixels.
  // output_size overrides the recorded size explicitly if ever needed.
  const deviceScaleFactor = scriptCfg.device_scale_factor || 1;
  const outputSize = scriptCfg.output_size || {
    width: viewport.width * deviceScaleFactor,
    height: viewport.height * deviceScaleFactor,
  };

  // ── Framing preflight (added 2026-09-16) ─────────────────────────────────
  //
  // On 2026-09-15 two scenes recorded at viewport 1920x1080 with no
  // output_size shipped straight to Facebook/LinkedIn/Twitter as 1920x1080
  // files. Facebook renders those surfaces as vertical Reels, so it
  // letterboxed our 16:9 footage into a 9:16 frame — roughly 80% black.
  // NOTHING between the recorder and Zernio ever reframes the video: there is
  // no scale/pad/crop step anywhere in feature-demo-merge.js or
  // feature-demo-publish.js. Whatever size is recorded here is what the
  // platform receives, so this is the only place the shape can be guaranteed.
  //
  // A scene that genuinely wants a landscape take (an internal sales-demo
  // walkthrough, say) opts out explicitly with "allow_non_vertical": true.
  //
  // ORIENTATION SOURCE OF TRUTH (fixed 2026-09-17). This preflight originally
  // carried its own list with 'facebook' counted as a vertical surface — the
  // identical mistake commit 4a28c6ca fixed in feature-demo-publish.js but
  // did not fix here, leaving the recorder and the gate disagreeing about the
  // same scene JSON. Result: a desktop 16:9 demo bound for
  // facebook/twitter/linkedin was REFUSED at capture for being exactly the
  // shape docs/FEATURE-VIDEO-DAILY-PLAN.md §1 specifies for those surfaces,
  // so the only way to record one was to set allow_non_vertical and skip the
  // framing check entirely. Both ends now call the same
  // classifyOrientation(), so a scene is graded against one ruleset from
  // capture through publish, and each lane keeps a real framing check.
  const { classifyOrientation } = require(path.join(__dirname, '..', 'api', '_lib', 'verify-video-quality.js'));
  let orientation;
  try {
    orientation = classifyOrientation(scriptCfg.orientation, scriptCfg.platforms);
  } catch (err) {
    // No platforms at all (or an unrecognized set) keeps the historical
    // default: this recorder has only ever produced vertical-first content.
    if (!Array.isArray(scriptCfg.platforms) || !scriptCfg.platforms.length) orientation = 'vertical';
    else throw new Error(`[recorder] REFUSING to record "${scriptCfg.name}": ${err.message}`);
  }
  console.log(`[recorder] orientation: ${orientation} (platforms ${JSON.stringify(scriptCfg.platforms || '(none)')})`);

  if (scriptCfg.allow_non_vertical !== true) {
    const ratio = outputSize.width / outputSize.height;
    const target = orientation === 'vertical' ? 9 / 16 : 16 / 9;
    if (Math.abs(ratio - target) > 0.02) {
      throw new Error(
        `[recorder] REFUSING to record "${scriptCfg.name}": recorded size would be `
        + `${outputSize.width}x${outputSize.height} (aspect ${ratio.toFixed(4)}), not `
        + `${orientation === 'vertical' ? '9:16' : '16:9'}.\n`
        + `  Platforms ${JSON.stringify(scriptCfg.platforms || '(default)')} classify as ${orientation}.\n`
        + (orientation === 'vertical'
          ? '  Fix the scene JSON to capture vertically, e.g.\n'
            + '    "viewport": { "width": 540, "height": 960 }, "device_scale_factor": 2,\n'
            + '    "is_mobile": true, "has_touch": true\n'
            + '  (and no "output_size" override), which records the real mobile UI at 1080x1920.\n'
          : '  Fix the scene JSON to capture landscape, e.g. "viewport": { "width": 1920, "height": 1080 } '
            + 'with no "output_size" override.\n')
        + '  If an off-spec take is genuinely intended, set "allow_non_vertical": true.',
      );
    }
    const minHeight = orientation === 'vertical' ? 1920 : 1080;
    if (outputSize.height < minHeight) {
      throw new Error(
        `[recorder] REFUSING to record "${scriptCfg.name}": recorded size `
        + `${outputSize.width}x${outputSize.height} is below the `
        + `${orientation === 'vertical' ? '1080x1920' : '1920x1080'} delivery resolution.\n`
        + '  This is usually an "output_size" override cancelling out device_scale_factor — '
        + 'drop "output_size" and let viewport x device_scale_factor produce the delivery size.',
      );
    }
  }
  console.log(`[recorder] recording at ${outputSize.width}x${outputSize.height} `
    + `(viewport ${viewport.width}x${viewport.height} @ dsf ${deviceScaleFactor})`);

  const slowmo = scriptCfg.slowmo_ms || 400;

  const { chromium } = require('playwright');
  // Headless by default — this recorder runs fine without a real display
  // (Playwright's recordVideo captures composited frames via CDP, not a
  // screen grab, so headless output is pixel-identical to headed). Set
  // HEADFUL=1 to watch it run on a machine that actually has a display.
  const headless = process.env.HEADFUL !== '1';
  const browser = await chromium.launch({
    headless,
    slowMo: slowmo,
  });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    // Real phone emulation for mobile-form-factor scenes (touch events, mobile
    // UA hints) — opt-in via scene JSON so existing desktop scenes are untouched.
    isMobile: scriptCfg.is_mobile === true,
    hasTouch: scriptCfg.has_touch === true || scriptCfg.is_mobile === true,
    recordVideo: { dir: RAW_DIR, size: outputSize },
    // Pre-grant notification permission so a scene that clicks "Enable risk
    // alerts" (RiskAlertsToggle.jsx's real Notification.requestPermission()
    // call) resolves to 'granted' immediately instead of hanging on a
    // permission prompt headless Chromium never surfaces interactively.
    permissions: ['notifications'],
  });

  // Stamp the recording session start so we can find the new webm afterward.
  const sessionStart = Date.now();
  const page = await context.newPage();
  // Shared mutable scene context. assert_signed_in stamps contentStartMs here.
  const ctx = { sessionStart, contentStartMs: null };
  let aborted = null;

  try {
    for (let i = 0; i < scriptCfg.scenes.length; i++) {
      const scene = scriptCfg.scenes[i];
      console.log(`\n[recorder] scene ${i + 1}/${scriptCfg.scenes.length}`);
      try {
        await runScene(page, scene, scriptCfg, ctx);
      } catch (err) {
        // A FatalSceneError means the take's premise is false (not signed in,
        // wrong account). No later footage can rescue it — stop filming now.
        if (err && err.fatal) {
          throw new Error(`[recorder] ABORTING take: ${err.message}`);
        }
        console.error(`[recorder] scene ${i + 1} failed: ${err.message}`);
        // Continue rest of timeline — we'd rather ship a slightly-flawed video
        // than abandon the whole take. The merge step trims to voiceover length.
        //
        // EXCEPT auth: if sign-in failed there is no app behind the login card,
        // so every remaining scene films the sign-in page. Continuing produces a
        // take that is 100% wrong, not "slightly flawed" — that is precisely how
        // the 2026-09-15 stage-checklist/close-day videos shipped. Abort instead.
        if (scene.action === 'login_if_visible') {
          throw new Error(
            `[recorder] ABORTING take: authentication failed (${err.message}). `
            + 'Every subsequent scene would record the login page.',
          );
        }
      }
    }
  } catch (err) {
    aborted = err;
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Find the .webm that Playwright created during this session
  const webms = fs.readdirSync(RAW_DIR)
    .filter((f) => f.endsWith('.webm'))
    .map((f) => {
      const full = path.join(RAW_DIR, f);
      return { full, name: f, mtime: fs.statSync(full).mtimeMs };
    })
    .filter((r) => r.mtime >= sessionStart - 1000)
    .sort((a, b) => b.mtime - a.mtime);

  // An aborted take's partial .webm is footage of the failure. Delete it here
  // rather than leaving it on disk where a later merge/publish could pick it
  // up believing it's a finished recording.
  if (aborted) {
    for (const w of webms) fs.promises.unlink(w.full).catch(() => {});
    throw aborted;
  }

  if (!webms.length) throw new Error('No new .webm found in raw/ after recording.');

  // Rename to a stable name so the merger can find it without ambiguity
  const stableName = scriptCfg.filename.replace(/\.mp4$/i, '.webm');
  const stablePath = path.join(RAW_DIR, stableName);
  if (fs.existsSync(stablePath)) fs.unlinkSync(stablePath);
  fs.renameSync(webms[0].full, stablePath);

  // Sidecar for feature-demo-merge.js: where the real, signed-in content
  // begins. Written even when null (no assert_signed_in scene) so the merge
  // step can tell "this take declared no trim point" apart from "the sidecar
  // is missing because the recorder predates this".
  const metaPath = `${stablePath}.meta.json`;
  fs.writeFileSync(metaPath, `${JSON.stringify({
    scene_script: path.basename(scriptPath),
    recorded_at: new Date(sessionStart).toISOString(),
    content_start_ms: ctx.contentStartMs,
  }, null, 2)}\n`);

  console.log(`\n[recorder] Raw recording: ${stablePath}`);
  console.log(`[recorder] content_start_ms=${ctx.contentStartMs === null ? 'null (no assert_signed_in scene)' : ctx.contentStartMs}`);
  return stablePath;
}

if (require.main === module) {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error('Usage: node scripts/feature-demo-recorder.js <scene-script.json>');
    process.exit(1);
  }
  record(path.resolve(scriptPath))
    .then((p) => {
      console.log(`\nDONE: ${p}`);
    })
    .catch((err) => {
      console.error(`[recorder] FATAL: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { record };
