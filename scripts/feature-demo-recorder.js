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

// ─── Scene action handlers ────────────────────────────────────────────────────

async function runScene(page, scene, scriptCfg) {
  const action = scene.action;
  switch (action) {
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
      await moveToElement(page, emailLocator);
      await clickRobust(emailLocator);
      await emailLocator.fill(scriptCfg.demo_account || 'demo@meetdossie.com');
      const passLocator = page.locator(scene.password_selector || "input[type='password']").first();
      await passLocator.waitFor({ state: 'visible' });
      await moveToElement(page, passLocator);
      await clickRobust(passLocator);
      await passLocator.fill(DEMO_PASSWORD);
      const submit = page.locator(scene.submit_selector || "button[type='submit']").first();
      await submit.waitFor({ state: 'visible' });
      await moveToElement(page, submit);
      await clickRobust(submit);
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
    recordVideo: { dir: RAW_DIR, size: viewport },
    // Pre-grant notification permission so a scene that clicks "Enable risk
    // alerts" (RiskAlertsToggle.jsx's real Notification.requestPermission()
    // call) resolves to 'granted' immediately instead of hanging on a
    // permission prompt headless Chromium never surfaces interactively.
    permissions: ['notifications'],
  });

  // Stamp the recording session start so we can find the new webm afterward.
  const sessionStart = Date.now();
  const page = await context.newPage();

  try {
    for (let i = 0; i < scriptCfg.scenes.length; i++) {
      const scene = scriptCfg.scenes[i];
      console.log(`\n[recorder] scene ${i + 1}/${scriptCfg.scenes.length}`);
      try {
        await runScene(page, scene, scriptCfg);
      } catch (err) {
        console.error(`[recorder] scene ${i + 1} failed: ${err.message}`);
        // Continue rest of timeline — we'd rather ship a slightly-flawed video
        // than abandon the whole take. The merge step trims to voiceover length.
      }
    }
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

  if (!webms.length) throw new Error('No new .webm found in raw/ after recording.');

  // Rename to a stable name so the merger can find it without ambiguity
  const stableName = scriptCfg.filename.replace(/\.mp4$/i, '.webm');
  const stablePath = path.join(RAW_DIR, stableName);
  if (fs.existsSync(stablePath)) fs.unlinkSync(stablePath);
  fs.renameSync(webms[0].full, stablePath);

  console.log(`\n[recorder] Raw recording: ${stablePath}`);
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
