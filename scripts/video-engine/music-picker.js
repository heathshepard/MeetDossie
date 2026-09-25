#!/usr/bin/env node
/**
 * music-picker.js — Heath's note 8 default: a licensed music bed, ducked
 * >=18dB under speech, never the same track two videos in a row.
 *
 * pickTrack(manifest, mood, statePath) -> { track, duckDb }
 *   - filters manifest to `mood` if given, else considers all tracks.
 *   - excludes whatever track was used last (read from statePath) UNLESS
 *     that's the only candidate (single-track manifest / single-mood
 *     library) — in that case it's used anyway and the gate downgrades
 *     "never twice in a row" to a warning rather than a hard fail, since
 *     there is no other option available (a real gap: manifest currently
 *     has exactly 1 track per mood).
 *   - writes the chosen track back to statePath for next run.
 */
const fs = require('fs');

function loadState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return { lastFile: null };
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { lastFile: null }; }
}

function pickTrack(manifest, mood, statePath) {
  const pool = mood ? manifest.filter(m => m.mood === mood) : manifest.slice();
  if (!pool.length) return { track: null, duckDb: null, warning: `no track for mood "${mood}"` };
  const state = loadState(statePath);
  let candidates = pool.filter(t => t.file !== state.lastFile);
  let warning = null;
  if (!candidates.length) {
    candidates = pool;
    warning = `only ${pool.length} track(s) available for this mood — could not avoid repeating "${state.lastFile}"`;
  }
  const track = candidates[Math.floor(Math.random() * candidates.length)];
  if (statePath) fs.writeFileSync(statePath, JSON.stringify({ lastFile: track.file, lastPickedAt: new Date().toISOString() }, null, 2));
  return { track, duckDb: 18, warning };
}

// Default ducking: >=18dB under speech. ffmpeg `volume` filter takes a
// linear multiplier, not dB directly for this codepath (edit.js multiplies
// the music stream by musicVolume before amix) — 18dB down = 10^(-18/20).
const DUCK_18DB_LINEAR = Math.pow(10, -18 / 20); // ~0.1259

module.exports = { pickTrack, DUCK_18DB_LINEAR };

if (require.main === module) {
  const path = require('path');
  const manifestPath = process.argv[2] || path.join(__dirname, 'music-manifest.json');
  const mood = process.argv[3] || null;
  const statePath = process.argv[4] || path.join(__dirname, '.video-engine-music-state.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(JSON.stringify(pickTrack(manifest, mood, statePath), null, 2));
}
