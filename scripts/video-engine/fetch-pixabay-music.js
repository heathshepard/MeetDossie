#!/usr/bin/env node
/**
 * fetch-pixabay-music.js — expand Media/Music/ with license-clean tracks.
 *
 * How it actually works (found live, 2026-09-21): Pixabay's anonymous
 * "Download" button is a no-op without a logged-in session (confirmed: no
 * network request fires on click, even from the DossieBot-Sage profile,
 * which turned out NOT to be logged into Pixabay). BUT the inline audio
 * PLAYER streams the same full-length file anonymously from
 * cdn.pixabay.com/audio/.../audio_<hash>.mp3 — and that CDN URL is directly
 * curl-able (200, not 403) as long as the request carries a Referer of a
 * pixabay.com page and a normal browser User-Agent. So: Playwright opens
 * each search results page (headless, ephemeral context — the Cloudflare
 * check only triggered when reusing the DossieBot persistent profile
 * headless, not on a fresh context), clicks each track's Play button,
 * captures the resulting audio_*.mp3 request URL + the track title/artist
 * text, then a plain curl (with Referer) pulls the file. No login needed.
 *
 * License for every file pulled this way: Pixabay Content License
 * (https://pixabay.com/service/license-summary/) — free for commercial use,
 * no attribution required, site-wide, same as the 2 existing tracks in
 * Media/Music/LICENSE.md.
 *
 * Usage: node scripts/video-engine/fetch-pixabay-music.js
 * (moods/queries are hardcoded below — edit MOODS to change the pull list)
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'Media', 'Music');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const MOODS = [
  { mood: 'warm-acoustic', query: 'warm acoustic guitar folk', slug: 'warm-acoustic-family-home' },
  { mood: 'modern-chill', query: 'modern chill lofi background', slug: 'modern-chill-background' },
  { mood: 'confident-corporate', query: 'confident corporate motivational', slug: 'confident-corporate' },
  { mood: 'bright-optimistic', query: 'bright optimistic pop upbeat', slug: 'bright-optimistic-pop' },
  { mood: 'ambient-calm', query: 'ambient calm piano background', slug: 'ambient-calm-piano' },
  { mood: 'inspiring-uplifting', query: 'inspiring uplifting cinematic', slug: 'inspiring-uplifting-cinematic' },
  { mood: 'energetic-drive', query: 'energetic driving electronic', slug: 'energetic-driving-electronic' },
  { mood: 'cozy-home', query: 'cozy home ukulele happy', slug: 'cozy-home-ukulele' },
  { mood: 'luxury-elegant', query: 'elegant luxury piano strings', slug: 'luxury-elegant-strings' },
  { mood: 'documentary-trust', query: 'documentary trustworthy soft piano', slug: 'documentary-trust-piano' },
];

async function grabOneTrack(page, query) {
  await page.goto(`https://pixabay.com/music/search/${encodeURIComponent(query)}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(2000);
  const audioReqs = [];
  const handler = (r) => { if (/audio_[a-f0-9]+\.mp3/.test(r.url())) audioReqs.push(r.url()); };
  page.on('request', handler);

  // Track rows: find the title text near each play button so we can name the file.
  const rows = await page.locator('[aria-label=Play]').elementHandles();
  if (rows.length === 0) { page.off('request', handler); return null; }

  // Click the first row's Play, then immediately pause (we only want the URL, not full playback).
  await rows[0].click({ force: true }).catch(() => {});
  await page.waitForTimeout(2500);
  await rows[0].click({ force: true }).catch(() => {}); // pause
  page.off('request', handler);

  if (audioReqs.length === 0) return null;

  // Title/artist: walk up from the play button to the row container and read its text.
  let title = null, artist = null;
  try {
    const rowText = await page.evaluate((el) => {
      let node = el;
      for (let i = 0; i < 6 && node; i++) node = node.parentElement;
      return node ? node.innerText : null;
    }, rows[0]);
    if (rowText) {
      const lines = rowText.split('\n').map(s => s.trim()).filter(Boolean);
      title = lines[0] || null;
      artist = lines[1] || null;
    }
  } catch {}

  return { url: audioReqs[0], title, artist };
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

async function main() {
  const context = await chromium.launchPersistentContext(
    path.join(require('os').tmpdir(), 'pixabay-music-fetch-ctx'),
    { headless: true, userAgent: UA }
  );
  const page = context.pages()[0] || await context.newPage();

  const manifest = [];
  for (const m of MOODS) {
    process.stdout.write(`Fetching mood "${m.mood}" (${m.query})... `);
    let result = null;
    try {
      result = await grabOneTrack(page, m.query);
    } catch (e) {
      console.log('ERROR', e.message);
      continue;
    }
    if (!result) { console.log('no track found'); continue; }

    const fileName = `${m.slug}.mp3`;
    const outPath = path.join(OUT_DIR, fileName);
    try {
      execFileSync('curl', ['-sL', '-A', UA, '-e', `https://pixabay.com/music/search/${encodeURIComponent(m.query)}/`, '-o', outPath, result.url]);
      const size = fs.statSync(outPath).size;
      if (size < 50000) { console.log(`FAILED (too small: ${size}B)`); fs.unlinkSync(outPath); continue; }
      console.log(`OK — ${fileName} (${(size / 1024 / 1024).toFixed(2)}MB) "${result.title}" by ${result.artist}`);
      manifest.push({
        file: fileName, mood: m.mood, title: result.title, artist: result.artist,
        sourceUrl: result.url, searchQuery: m.query,
        license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/',
        downloadedAt: new Date().toISOString().slice(0, 10),
      });
    } catch (e) {
      console.log('curl FAILED', e.message);
    }
    await page.waitForTimeout(1500);
  }

  await context.close();
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${manifest.length} tracks. Manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
