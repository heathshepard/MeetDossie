// One-off runner for queue task 2b0a59bf-41d3-4892-bbb6-f67e1f916323
// TikTok trending audio 2026-09-28 — Sage.
//
// Source data: publicly published trend aggregators (Metricool weekly US
// chart 2026-09-21, Tokchart live board 2026-09-28, HeyOrca + SocialPilot
// Sept-2026 roundups) fetched via WebFetch — NOT a live TikTok Creative
// Center API pull (no scraper/browser tool available in this session; see
// RESULT_SUMMARY). sound_id is a slug proxy, NOT TikTok's internal numeric
// ID (not exposed by any of the text sources used). use_count is the real
// published UGC-video count where a source gave one, else null — never
// fabricated. trend_score is my own niche re-rank (0-100) biasing toward
// voiceover/storytime/text-overlay formats that fit a Texas-realtor /
// transaction-coordinator brand, per the handler's stated bias rules.

'use strict';
const fs = require('fs');
const path = require('path');

function loadEnvLocal() {
  const p = path.join(__dirname, '..', '..', '..', '.env.local');
  const txt = fs.readFileSync(p, 'utf8');
  txt.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"?([^"#\r\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}
loadEnvLocal();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbFetch(p, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data, text };
}

const SCAN_DATE = '2026-09-28';
const PLATFORM = 'tiktok';

function slug(title, artist) {
  return `tt-${SCAN_DATE}-` + `${title}-${artist}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150);
}

const sounds = [
  { title: 'Makes No Difference', artist: 'The Rose Hips', use_count: null, trend_score: 95 },
  { title: 'Be OK', artist: 'Ingrid Michaelson', use_count: null, trend_score: 93 },
  { title: 'Please keep me in your thoughts (Original Audio)', artist: 'Original Sound', use_count: null, trend_score: 92 },
  { title: 'Only Exception', artist: 'Paramore', use_count: null, trend_score: 90 },
  { title: 'I feel like a ____ (Original Sound)', artist: 'Original Sound', use_count: null, trend_score: 88 },
  { title: 'Do you have a job? (Original Audio)', artist: 'Original Sound', use_count: null, trend_score: 86 },
  { title: "Can't Hold Us", artist: 'Macklemore & Ryan Lewis ft. Ray Dalton', use_count: null, trend_score: 85 },
  { title: 'Taylor Swift Countdown (Original Sound)', artist: 'Original Sound', use_count: null, trend_score: 83 },
  { title: 'D>E>A>T>H>M>E>T>A>L', artist: 'Panchiko', use_count: null, trend_score: 80 },
  { title: 'ONSRA', artist: 'Comehelpglo', use_count: null, trend_score: 78 },
  { title: 'Obsessica', artist: 'Malcolm Todd', use_count: null, trend_score: 76 },
  { title: 'Nicole Kidman', artist: 'Adela', use_count: null, trend_score: 74 },
  { title: 'AINSI BAS LA VIDA HARDTEKK', artist: 'whoiam, WHOiAM', use_count: 100000, trend_score: 72 },
  { title: 'Freak', artist: 'Lana Del Rey', use_count: null, trend_score: 70 },
  { title: 'Sey Mami', artist: 'Cinco Suave', use_count: null, trend_score: 65 },
  { title: 'BbY WOW', artist: 'Karol G', use_count: null, trend_score: 60 },
  { title: 'COMPA COLETO (uy_como)', artist: 'ARIA VEGA', use_count: 653000, trend_score: 58 },
  { title: 'VIBIN', artist: 'Wxoda', use_count: null, trend_score: 55 },
  { title: 'Summer Bummer', artist: 'RhyRhy', use_count: null, trend_score: 52 },
  { title: 'Puede Nang Mangarap', artist: 'Lyca Gairanod', use_count: 501000, trend_score: 50 },
];

const MIRROR_PATH = 'C:\\Users\\Heath\\Desktop\\Shepard-Ventures\\Marketing\\sage\\trending-audio-live.json';

async function main() {
  const rows = sounds.map((s, i) => ({
    scanned_date: SCAN_DATE,
    platform: PLATFORM,
    sound_id: slug(s.title, s.artist),
    title: s.title.slice(0, 400),
    artist: s.artist.slice(0, 200),
    use_count: s.use_count,
    trend_score: s.trend_score,
    rank: i + 1,
  }));

  let inserted = 0;
  const errors = [];
  for (const row of rows) {
    const r = await sbFetch(`trending_audio?on_conflict=scanned_date,platform,sound_id`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify(row),
    });
    if (r.ok) inserted++;
    else errors.push({ sound_id: row.sound_id, status: r.status, body: r.text.slice(0, 300) });
  }

  let mirrorWriteOk = false;
  try {
    fs.mkdirSync(path.dirname(MIRROR_PATH), { recursive: true });
    fs.writeFileSync(MIRROR_PATH, JSON.stringify({
      updated_at: new Date().toISOString(),
      scan_date: SCAN_DATE,
      platform: PLATFORM,
      method: 'public trend-chart aggregation (Metricool/Tokchart/HeyOrca/SocialPilot) + manual niche re-rank — not a live TikTok Creative Center API pull',
      sounds: rows,
    }, null, 2), 'utf8');
    mirrorWriteOk = true;
  } catch (e) {
    console.log('mirror_write_failed:', e.message);
  }

  console.log(JSON.stringify({ inserted, total: rows.length, errors, mirrorWriteOk }, null, 2));
}

main();
