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
//   DEMO_PASSWORD = DossieDemo-VaIiAt6Bab  (Sarah Whitley demo account)

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

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab';
const RAW_DIR = path.join(__dirname, '..', 'Media', 'feature-demos', 'raw');
fs.mkdirSync(RAW_DIR, { recursive: true });

// ─── Mouse helpers ────────────────────────────────────────────────────────────

async function moveToElement(page, element) {
  const box = await element.boundingBox();
  if (!box) return;
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  await page.mouse.move(targetX, targetY, { steps: 20 });
  await page.waitForTimeout(180);
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
      await emailLocator.click();
      await emailLocator.fill(scriptCfg.demo_account || 'demo@meetdossie.com');
      const passLocator = page.locator(scene.password_selector || "input[type='password']").first();
      await passLocator.waitFor({ state: 'visible' });
      await moveToElement(page, passLocator);
      await passLocator.click();
      await passLocator.fill(DEMO_PASSWORD);
      const submit = page.locator(scene.submit_selector || "button[type='submit']").first();
      await submit.waitFor({ state: 'visible' });
      await moveToElement(page, submit);
      await submit.click();
      break;
    }
    case 'wait_for_text': {
      console.log(`  [scene] wait_for_text -> "${scene.text}"`);
      await page.waitForSelector(`text=${scene.text}`, { timeout: scene.timeout || 15000 });
      break;
    }
    case 'click_text': {
      console.log(`  [scene] click_text -> "${scene.text}"`);
      const loc = page.getByText(scene.text, { exact: scene.exact === true }).first();
      await loc.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      await moveToElement(page, loc);
      await loc.click();
      break;
    }
    case 'click_selector': {
      console.log(`  [scene] click_selector -> ${scene.selector}`);
      const loc = page.locator(scene.selector).first();
      await loc.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      await moveToElement(page, loc);
      await loc.click();
      break;
    }
    case 'type_into': {
      console.log(`  [scene] type_into -> ${scene.selector}`);
      const loc = page.locator(scene.selector).first();
      await loc.waitFor({ state: 'visible', timeout: scene.timeout || 10000 });
      await loc.focus();
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
      await close.click();
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
      await card.click();
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
  const browser = await chromium.launch({
    headless: false,
    slowMo: slowmo,
    args: [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
  });
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: RAW_DIR, size: viewport },
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
