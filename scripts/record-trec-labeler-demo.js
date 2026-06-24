#!/usr/bin/env node
/**
 * record-trec-labeler-demo.js
 *
 * Captures a ~30s screen recording of the offline TREC labeler walkthrough.
 * Saves WebM via Playwright video capture, then ffmpeg → MP4.
 *
 * Steps:
 *   0-3s   Open labeler (already loaded via file:// URL)
 *   3-6s   Show first widget card (field + nearest labels + guess)
 *   6-10s  Press [1] Accept guess — show progress update
 *   10-14s Press [2] Correct — type "buyer_email" — Enter
 *   14-18s Press [3] Skip — show skipped tally
 *   18-22s Click Export JSON — file downloads
 *   22-26s Read downloaded JSON, show schema in browser overlay
 *   26-30s Persistent footer hint visible whole time
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const LABELER = 'file:///C:/Users/Heath%20Shepard/Desktop/trec-labeler.html';
const OUT_DIR = 'C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\Engineering\\demo-videos';
const FINAL_MP4 = path.join(OUT_DIR, '2026-06-19-offline-trec-labeler.mp4');
const VIDEO_DIR = path.join(OUT_DIR, '.playwright-tmp');
const DOWNLOADS_DIR = path.join(OUT_DIR, '.downloads-tmp');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function showBanner(page, text, ms = 0) {
  // injects a brief Sage-branded overlay at top so the captured video has narration cues
  await page.evaluate((t) => {
    let el = document.getElementById('sage-demo-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sage-demo-banner';
      el.style.cssText = [
        'position:fixed','top:60px','left:50%','transform:translateX(-50%)',
        'z-index:9999','background:#1A1A2E','color:#F5E6E0',
        'padding:10px 22px','border-radius:8px','font-family:"Cormorant Garamond",serif',
        'font-size:22px','font-weight:600','letter-spacing:0.5px',
        'box-shadow:0 4px 18px rgba(0,0,0,0.25)',
        'border-bottom:3px solid #C9A96E','max-width:80vw','text-align:center'
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  if (ms > 0) await sleep(ms);
}

async function hideBanner(page) {
  await page.evaluate(() => {
    const el = document.getElementById('sage-demo-banner');
    if (el) el.remove();
  });
}

(async () => {
  // Prep dirs
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(VIDEO_DIR)) fs.rmSync(VIDEO_DIR, { recursive: true, force: true });
  fs.mkdirSync(VIDEO_DIR, { recursive: true });
  if (fs.existsSync(DOWNLOADS_DIR)) fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  console.log('[sage] launching chromium with video recording…');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 720 } },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  // --- 0-3s: open labeler ---
  console.log('[sage] segment 1: opening labeler');
  await page.goto(LABELER, { waitUntil: 'networkidle' });
  // wait until first widget renders (sanity)
  await page.waitForSelector('.card .field-name', { timeout: 5000 });
  await showBanner(page, 'Step 1 — Open trec-labeler.html', 0);
  await sleep(3000);

  // --- 3-6s: show first widget card ---
  console.log('[sage] segment 2: show first widget');
  await showBanner(page, 'Step 2 — Widget card: field, nearest labels, Atlas guess');
  // ensure the card is fully visible — scroll to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(3000);

  // --- 6-10s: press [1] Accept guess ---
  console.log('[sage] segment 3: press 1 to Accept');
  await showBanner(page, 'Step 3 — Press [1] Accept guess');
  await sleep(800);
  await page.keyboard.press('1');
  await sleep(3200);

  // --- 10-14s: press [2] Correct + type "buyer_email" + Enter ---
  console.log('[sage] segment 4: press 2 to Correct, type buyer_email');
  await showBanner(page, 'Step 4 — Press [2] Correct, type "buyer_email", Enter');
  await sleep(600);
  await page.keyboard.press('2');
  // wait for the correct-form input to appear & focus
  await page.waitForSelector('#correctInput', { timeout: 3000 });
  await page.focus('#correctInput');
  // typing slowly so it reads on video
  await page.keyboard.type('buyer_email', { delay: 90 });
  await sleep(700);
  await page.keyboard.press('Enter');
  await sleep(1500);

  // --- 14-18s: press [3] Skip ---
  console.log('[sage] segment 5: press 3 to Skip');
  await showBanner(page, 'Step 5 — Press [3] Skip — tally updates');
  await sleep(800);
  await page.keyboard.press('3');
  await sleep(3200);

  // --- 18-22s: click Export JSON ---
  console.log('[sage] segment 6: Export JSON');
  await showBanner(page, 'Step 6 — Click Export JSON');
  await sleep(800);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#exportBtn'),
  ]);
  const downloadName = download.suggestedFilename();
  const downloadPath = path.join(DOWNLOADS_DIR, downloadName);
  await download.saveAs(downloadPath);
  console.log('[sage] download saved:', downloadPath);
  await sleep(2500);

  // --- 22-26s: show downloaded JSON contents in an overlay (simulates "open in text editor") ---
  console.log('[sage] segment 7: show downloaded JSON schema');
  const jsonText = fs.readFileSync(downloadPath, 'utf-8');
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch (e) { parsed = { _raw: jsonText.slice(0, 500) }; }
  const preview = {
    form: parsed.form,
    labeled_at: parsed.labeled_at,
    counts: parsed.counts,
    labels: Array.isArray(parsed.labels) ? parsed.labels.slice(0, 3) : parsed.labels,
  };
  await hideBanner(page);
  await page.evaluate(({ name, previewStr }) => {
    let el = document.getElementById('sage-json-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sage-json-overlay';
      el.style.cssText = [
        'position:fixed','top:0','left:0','width:100%','height:100%',
        'z-index:10000','background:rgba(26,26,46,0.96)','color:#F5E6E0',
        'padding:40px 80px','overflow:auto','font-family:Consolas,Menlo,monospace',
        'font-size:14px','line-height:1.55','box-sizing:border-box'
      ].join(';');
      document.body.appendChild(el);
    }
    el.innerHTML =
      '<div style="font-family:\'Cormorant Garamond\',serif;font-size:26px;color:#C9A96E;margin-bottom:8px;">Downloaded: ' + name + '</div>' +
      '<div style="font-family:\'Cormorant Garamond\',serif;font-size:18px;color:#D4A0A0;margin-bottom:24px;">Schema: form / labeled_at / counts / labels[]</div>' +
      '<pre style="white-space:pre-wrap;margin:0;color:#F5E6E0;">' + previewStr + '</pre>';
  }, { name: downloadName, previewStr: JSON.stringify(preview, null, 2) });
  await sleep(4000);

  // --- 26-30s: footer hint visible whole time (banner restored) ---
  console.log('[sage] segment 8: footer hint persistence');
  // remove overlay so footer is visible
  await page.evaluate(() => {
    const o = document.getElementById('sage-json-overlay');
    if (o) o.remove();
  });
  await showBanner(page, 'Persistent footer hint: press [1]-[4] to label without mouse');
  // highlight the footer
  await page.evaluate(() => {
    const f = document.querySelector('.hotkey-footer');
    if (f) {
      f.style.outline = '3px solid #C9A96E';
      f.style.outlineOffset = '4px';
      f.style.boxShadow = '0 0 32px rgba(201,169,110,0.6)';
      f.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  await sleep(4000);

  // --- close & finalize video ---
  console.log('[sage] closing context to flush video…');
  await context.close();
  await browser.close();

  // find the webm
  const webms = fs.readdirSync(VIDEO_DIR).filter(f => f.endsWith('.webm'));
  if (webms.length === 0) {
    console.error('[sage] ERROR: no webm produced');
    process.exit(1);
  }
  const webmPath = path.join(VIDEO_DIR, webms[0]);
  console.log('[sage] webm captured:', webmPath, '(' + fs.statSync(webmPath).size + ' bytes)');

  // convert webm -> mp4 (H.264, AAC silent, 30fps, faststart)
  console.log('[sage] converting webm → mp4 via ffmpeg…');
  const ffmpegArgs = [
    '-y',
    '-i', webmPath,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    '-movflags', '+faststart',
    '-an', // no audio
    FINAL_MP4,
  ];
  const ff = spawnSync('ffmpeg', ffmpegArgs, { stdio: 'inherit' });
  if (ff.status !== 0) {
    console.error('[sage] ffmpeg failed, status', ff.status);
    process.exit(1);
  }

  // probe duration
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    FINAL_MP4,
  ], { encoding: 'utf-8' });
  const duration = (probe.stdout || '').trim();

  console.log('[sage] FINAL MP4:', FINAL_MP4);
  console.log('[sage] DURATION:', duration, 'sec');
  console.log('[sage] SIZE:', fs.statSync(FINAL_MP4).size, 'bytes');

  // cleanup tmp
  try { fs.rmSync(VIDEO_DIR, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true }); } catch (e) {}
})().catch(err => {
  console.error('[sage] FATAL:', err);
  process.exit(1);
});
