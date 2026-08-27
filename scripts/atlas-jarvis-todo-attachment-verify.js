#!/usr/bin/env node
// scripts/atlas-jarvis-todo-attachment-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for jarvis_todos.attachments (2026-08-27): confirms a video
// attached via scripts/jarvis-todo-attach-file.js actually renders and plays
// inline on its to-do item in the Jarvis PWA TO-DO panel.
//
// Usage: node scripts/atlas-jarvis-todo-attachment-verify.js <BASE_URL> <todo_id>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const baseArg = process.argv[2];
const todoId = process.argv[3];
if (!baseArg || !todoId) {
  console.error('Usage: node scripts/atlas-jarvis-todo-attachment-verify.js <BASE_URL> <todo_id>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'jarvis-todo-attachment-2026-08-27');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

// Same pattern as scripts/carter-jarvis-today-panel-verify.js.
async function mintHeathSession() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  if (!hashedToken) throw new Error('generateLink returned no hashed_token');
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return { access_token: verifyData.access_token, refresh_token: verifyData.refresh_token, user: verifyData.user };
}

async function signIn(page) {
  const session = await mintHeathSession();
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, sessionObj }) => {
    const payload = {
      access_token: sessionObj.access_token,
      refresh_token: sessionObj.refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sessionObj.user,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return gateHidden && !!document.getElementById('jt-list');
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return gateHidden && !!document.getElementById('jt-list');
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  console.log(`[verify] navigating ${URL}`);
  const signedIn = await signIn(page);
  report('sign-in as heath.shepard@kw.com + TO-DO list present', signedIn);
  if (!signedIn) {
    await page.screenshot({ path: path.join(OUT, '00-signin-fail.png'), fullPage: true });
    await browser.close();
    process.exit(1);
  }

  // Wait for jarvis_todos to actually load (not "Nothing on the list").
  await page.waitForFunction(() => {
    const list = document.getElementById('jt-list');
    return list && list.children.length > 0 && !list.textContent.includes('Nothing on the list');
  }, { timeout: 20000 }).catch(() => {});

  const row = page.locator(`.jt-item[data-id="${todoId}"]`);
  const rowExists = await row.count().then((c) => c > 0).catch(() => false);
  report('test todo row found in TO-DO panel', rowExists);
  if (!rowExists) {
    await page.screenshot({ path: path.join(OUT, '01-row-not-found.png'), fullPage: true }).catch(() => {});
    await browser.close();
    const overall = results.every((r) => r.pass);
    fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, overall }, null, 2));
    process.exit(1);
  }

  const badge = row.locator('.jt-item-attach-badge');
  const badgeVisible = await badge.isVisible().catch(() => false);
  report('paperclip attachment badge visible on collapsed row', badgeVisible);

  // Expand the row.
  await row.locator('.jt-item-head').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '02-expanded.png'), fullPage: true }).catch(() => {});

  const video = row.locator('video.msg-attachment-video');
  const videoVisible = await video.isVisible().catch(() => false);
  report('video element rendered in expanded todo item', videoVisible);

  const videoSrc = await video.locator('source').getAttribute('src').catch(() => null);
  report('video source URL present', !!videoSrc, videoSrc ? videoSrc.slice(0, 80) + '...' : 'none');

  // Confirm the browser can actually load real video metadata from the
  // signed URL (duration > 0), not just that a <video> tag exists.
  const playCheck = await page.evaluate(async () => {
    const v = document.querySelector('.jt-item video.msg-attachment-video');
    if (!v) return { error: 'no video element' };
    await new Promise((resolve) => {
      if (v.readyState >= 1) return resolve();
      v.addEventListener('loadedmetadata', resolve, { once: true });
      setTimeout(resolve, 8000);
    });
    try {
      await v.play();
      await new Promise((r) => setTimeout(r, 600));
      const playing = !v.paused && v.currentTime > 0;
      v.pause();
      return { duration: v.duration, readyState: v.readyState, playing, currentTime: v.currentTime };
    } catch (e) {
      return { duration: v.duration, readyState: v.readyState, playError: String(e) };
    }
  });
  report(
    'video actually loads + plays (duration>0, currentTime advances)',
    playCheck && playCheck.duration > 0 && playCheck.playing === true,
    JSON.stringify(playCheck)
  );

  await page.screenshot({ path: path.join(OUT, '03-playing.png'), fullPage: true }).catch(() => {});
  await video.screenshot({ path: path.join(OUT, '04-video-element-only.png') }).catch(() => {});

  await browser.close();

  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, overall }, null, 2));
  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  console.log(`Page errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  console.log(`Screenshots: ${OUT}`);
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
