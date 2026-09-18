#!/usr/bin/env node
'use strict';

// scripts/daily-video-supply.js
//
// THE SUPPLY LOOP. One video a day, gate-passed, queued for Heath's approval,
// without anyone asking for it.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// 2026-09-17: zero videos posted in 24h with THREE working generators on disk
// and a working publish path. Nothing was broken. Nothing was scheduled.
// docs/CONTENT-FORMAT-LIBRARY.md §8.3 lays out a week of unattended overnight
// production; this file is the thing that actually fires it.
//
// It is deliberately thin. It does not render, caption, voice or publish
// anything itself -- every one of those already has an owner:
//
//   D1 Ask Dossie   scripts/generate-ask-dossie-video.js  (capture, real app)
//                 + scripts/render-ask-dossie-video.js    (VO, compositor, gate, queue)
//   R1 Listing Reel scripts/listing-reel-trigger.js --render
//                   (live connectMLS read -> Ken Burns -> gate -> queue)
//
// What this file owns is the three things nobody owned: WHICH format runs
// today, whether that format still has honest material left, and shouting when
// a day produces nothing.
//
// ---------------------------------------------------------------------------
// WHERE IT RUNS, AND WHY NOT ON VERCEL
// ---------------------------------------------------------------------------
// Locally, off the Windows 30-min tick (scripts/run-tc-discovery-harvest.cmd
// Step 11 -> scripts/run-daily-video-supply.cmd -> WSL), self-gated to once a
// calendar day. It cannot be a Vercel cron for three independent reasons, any
// one of which is fatal:
//
//   1. Vercel serverless has no ffmpeg (api/cron-render-videos.js says so in
//      its own header) and both formats end in an ffmpeg composite.
//   2. D1's source material is a Playwright screenshot loop against the live
//      app; R1's is a connectMLS session in real Chrome. Neither exists in a
//      serverless sandbox.
//   3. vercel.json is at 54/100 cron entries and the cap is HARD at 100 on
//      every plan -- so even work that COULD run there gets multiplexed onto
//      an existing dispatcher rather than adding an entry. Nothing here needs
//      one.
//
// ---------------------------------------------------------------------------
// ROTATION, AND WHY IT IS NOT "RUN D1 EVERY DAY"
// ---------------------------------------------------------------------------
// Each format has a finite amount of genuinely real material (§8.2 calls this
// its runway) and burning one format daily exhausts it and starts repeating,
// which is worse than posting nothing. So each candidate gets a starvation
// score -- days since it last produced, divided by its share of the week --
// and the hungriest eligible format wins. A format with zero runway left, or a
// missing prerequisite, is skipped with a NAMED reason and the next one runs;
// a day is never lost because one format was blocked.
//
//   node scripts/daily-video-supply.js              # the scheduled call
//   node scripts/daily-video-supply.js --force      # ignore the once/day gate
//   node scripts/daily-video-supply.js --format D1  # run one format explicitly
//   node scripts/daily-video-supply.js --plan       # print the decision, run nothing
//   node scripts/daily-video-supply.js --runway     # print runway per format, exit
//   node scripts/daily-video-supply.js --no-alert   # never send Telegram (rehearsal)
//
// NOTHING HERE PUBLISHES. Output lands in video_library via the existing
// Pipeline B queue and waits for Heath's approval. Publishing is a separate,
// already-autonomous capability (ops_flags.publish_content, read by
// api/cron-post-videos.js's path) and is not touched from here.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');

require('./_lib/load-env-local.js').loadEnvLocal(REPO);

const MEDIA_ROOT = process.env.DOSSIE_MEDIA_ROOT || path.join(REPO, 'Media');
// The state file lives beside the MEDIA library, not in scripts/, on purpose:
// scripts/ differs per checkout (dev tree vs MeetDossie-scheduler vs a
// worktree) and a per-checkout ledger would re-spend the same question the
// first time a different checkout ran. Media/ is the one shared location.
const STATE_FILE = process.env.DAILY_VIDEO_SUPPLY_STATE
  || path.join(process.env.DOSSIE_MEDIA_ROOT || path.join(REPO, 'Media'), '.daily-video-supply-state.json');
const MAPPED_JSON = path.join(__dirname, 'ask-dossie-questions', 'mapped-questions.json');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const FORCE = flag('force');
const PLAN_ONLY = flag('plan');
const NO_ALERT = flag('no-alert');
const ONLY_FORMAT = opt('format', null);

function log(m) { console.log(`[video-supply] ${m}`); }
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ── state ───────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch { /* start fresh */ }
  return {};
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch (e) {
    console.warn('[video-supply] could not persist state:', e.message);
  }
}
function history(state) { return Array.isArray(state.history) ? state.history : []; }
function lastSuccessFor(state, id) {
  return history(state).filter((h) => h.format === id && h.ok).slice(-1)[0] || null;
}
function daysSince(iso) {
  if (!iso) return 999;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

// ── formats ─────────────────────────────────────────────────────────────────
//
// `share` is this format's slice of a 7-day week, straight out of §8.1: three
// realtor masters, three Dossie masters, two Rust. It is the DIVISOR in the
// starvation score, so a format meant to run once a week does not out-compete
// one meant to run twice.
//
// `runway()` must count REAL remaining material, not a guess, and must be
// honest about zero. `blocked()` returns a NAMED reason or null.
const FORMATS = [
  {
    id: 'D1',
    brand: 'dossie',
    label: 'Ask Dossie real-question screen demo',
    share: 3,
    runway: d1Runway,
    blocked: d1Blocked,
    run: runD1,
  },
  {
    id: 'R1',
    brand: 'heath-realtor',
    label: 'Ken Burns listing reel',
    share: 3,
    runway: r1Runway,
    blocked: r1Blocked,
    run: runR1,
  },
  {
    id: 'U1',
    brand: 'rust',
    label: 'Rust readiness -> coach adjustment',
    share: 2,
    // 6 coaches x ~4 readiness scenarios (§U1). Real material, no destination.
    runway: () => ({ remaining: 24, note: '6 coaches x 4 readiness scenarios (CONTENT-FORMAT-LIBRARY §U1)' }),
    blocked: () => 'Rust has no connected social account — every master would be '
      + 'banked, not posted (§9 item 1: Heath must create the accounts). Building '
      + 'into a void burns ElevenLabs credits for zero reach.',
    run: () => { throw new Error('U1 is blocked — see blocked()'); },
  },
];

// ---- D1 --------------------------------------------------------------------
function loadMapped() {
  try { return JSON.parse(fs.readFileSync(MAPPED_JSON, 'utf8')); } catch { return null; }
}
/** Rows already spent, by the real DB row_id the question came from.
 *
 *  Two ledgers, unioned, because a state file can be lost or belong to a
 *  different checkout and re-asking the same question is the one failure that
 *  looks exactly like working software. The durable one is the same trick
 *  listing-reel-trigger.js uses: the FILENAME is the ledger. Every D1 slug
 *  carries the first 8 chars of its source row_id, so the set of questions
 *  already spent can be read straight off the shared Media/ library. */
function d1Used(state) {
  const used = new Set(history(state).filter((h) => h.format === 'D1' && h.ok && h.row_id).map((h) => h.row_id));
  const prefixes = new Set();
  for (const dir of [path.join(MEDIA_ROOT, 'finished-videos'), path.join(MEDIA_ROOT, 'd1-captures')]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = /^dossie-d1-cap\d+-([0-9a-f]{8})-\d{4}-\d{2}-\d{2}/.exec(f);
        if (m) prefixes.add(m[1]);
      }
    } catch { /* folder may not exist yet */ }
  }
  return { ids: used, prefixes };
}
function d1IsUsed(usedSets, rowId) {
  return usedSets.ids.has(rowId) || usedSets.prefixes.has(String(rowId).slice(0, 8));
}
function d1Runway(state) {
  const doc = loadMapped();
  if (!doc || !Array.isArray(doc.mapped)) {
    return { remaining: 0, note: `no ${path.basename(MAPPED_JSON)} — run generate-ask-dossie-video.js --stage map` };
  }
  const used = d1Used(state);
  const left = doc.mapped.filter((r) => !d1IsUsed(used, r.row_id));
  return {
    remaining: left.length,
    note: `${left.length} of ${doc.mapped.length} mapped real quotes unused `
      + `(mapper refuses to stretch a quote onto an adjacent capability, so this is the honest count)`,
    next: left[0] || null,
  };
}
function d1Blocked() {
  if (!process.env.DEMO_PASSWORD) return 'DEMO_PASSWORD missing from .env.local — the capture cannot sign in to the demo account';
  if (!process.env.ELEVENLABS_API_KEY && !process.env.ELEVENLABS_API_KEY_PERSONAL) return 'ELEVENLABS_API_KEY missing — no voiceover';
  return null;
}
function runD1(state) {
  const rw = d1Runway(state);
  if (!rw.next) throw new Error('D1 runway is empty: ' + rw.note);
  const row = rw.next;
  // The row_id prefix in the slug is what makes the filename a durable
  // "already asked this" ledger — see d1Used().
  const slug = `dossie-d1-cap${row.capability_number}-${String(row.row_id).slice(0, 8)}-${todayKey()}`;
  const captureDir = path.join(MEDIA_ROOT, 'd1-captures', slug);
  fs.mkdirSync(captureDir, { recursive: true });

  log(`D1 question source: ${row.source_table}/${row.row_id} -> capability #${row.capability_number}`);
  log(`D1 asks: ${row.ask_question}`);

  const cap = sh('node', ['scripts/generate-ask-dossie-video.js',
    '--stage', 'capture', '--pick', row.row_id, '--out', captureDir]);
  if (cap.status !== 0) throw new Error(`capture failed (exit ${cap.status})`);

  const out = path.join(MEDIA_ROOT, 'finished-videos', `${slug}.mp4`);
  const rend = sh('node', ['scripts/render-ask-dossie-video.js',
    '--capture', captureDir, '--out', out, '--slug', slug]);
  if (rend.status !== 0) throw new Error(`render/gate failed (exit ${rend.status}) — see the gate verdict above`);

  return { video_id: slug, path: out, row_id: row.row_id, capability: row.capability_number };
}

// ---- R1 --------------------------------------------------------------------
function r1PhotoListings() {
  // Only a listing whose MLS photos are actually on disk can produce a reel.
  // Mirrors resolvePhotoDir() in listing-reel-trigger.js — 4+ photos required.
  let LISTINGS = [];
  let ANGLES = [];
  try { ({ LISTINGS, ANGLES } = require('./_lib/listing-marketing-facts')); } catch { return { listings: [], angles: 6 }; }
  const roots = [
    process.env.LISTING_REEL_PHOTOS_ROOT,
    path.join(REPO, '.tmp', 'fawndale-wildcherry-photos'),
    path.join(MEDIA_ROOT, 'listing-photos'),
    '/mnt/c/Users/Heath/Projects/MeetDossie/.tmp/fawndale-wildcherry-photos',
  ].filter(Boolean);
  // LISTINGS is keyed BY MLS NUMBER, not an array — Object.values() or this
  // whole check silently reports zero and R1 looks permanently blocked.
  const all = Array.isArray(LISTINGS) ? LISTINGS : Object.values(LISTINGS || {});
  const withPhotos = all.filter((l) => l && l.key && roots.some((root) => {
    try {
      const dir = path.join(root, l.key);
      if (!fs.existsSync(dir)) return false;
      const re = new RegExp(`^${l.key}-photo\\d+\\.jpg$`);
      return fs.readdirSync(dir).filter((f) => re.test(f)).length >= 4;
    } catch { return false; }
  }));
  return { listings: withPhotos, angles: (ANGLES || []).length || 6 };
}
function r1Runway(state) {
  const { listings, angles } = r1PhotoListings();
  const spent = history(state).filter((h) => h.format === 'R1' && h.ok).length;
  const total = listings.length * angles;
  return {
    remaining: Math.max(0, total - spent),
    note: `${listings.length} listing(s) with a usable photo set x ${angles} angles = ${total} `
      + `distinct reels; ${spent} produced by this loop so far. A new listing or a new photo `
      + `set is what refills this.`,
  };
}
function r1Blocked() {
  const { listings } = r1PhotoListings();
  if (listings.length === 0) {
    return 'no listing has 4+ MLS photos on disk — R1 renders over REAL photos only, never a substitute image';
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 'SUPABASE_URL/SERVICE_ROLE_KEY missing';
  return null;
}
function runR1() {
  // --render = live connectMLS read, VO, Ken Burns render, quality gate, queue.
  // The trigger owns its own per-listing cooldown and angle ledger, so this
  // loop does not second-guess which property or angle is next.
  const r = sh('node', ['scripts/listing-reel-trigger.js', '--render']);
  if (r.status !== 0) throw new Error(`listing-reel-trigger --render failed (exit ${r.status})`);
  // The trigger names reels deterministically and drops them in the realtor
  // watch folder; report the newest one so the run record points at something.
  const dir = path.join(MEDIA_ROOT, 'finished-videos', 'realtor');
  let newest = null;
  try {
    newest = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
  } catch { /* the trigger may legitimately have decided nothing was due */ }
  if (!newest || Date.now() - newest.t > 20 * 60 * 1000) {
    throw new Error('listing-reel-trigger exited 0 but produced no new reel in the last 20 min '
      + '(most likely every listing is inside its cooldown) — treating as "no video today", not success');
  }
  return { video_id: path.basename(newest.f, '.mp4'), path: path.join(dir, newest.f) };
}

// ── child process ───────────────────────────────────────────────────────────
function sh(cmd, args) {
  log(`$ ${cmd} ${args.join(' ')}`);
  return spawnSync(cmd, args, {
    cwd: REPO,
    stdio: 'inherit',
    env: {
      ...process.env,
      DOSSIE_MEDIA_ROOT: MEDIA_ROOT,
      // queue-finished-videos.py scans this; keep every producer and the
      // scanner pointed at the same library whichever checkout is executing.
      QUEUE_VIDEOS_DIR: path.join(MEDIA_ROOT, 'finished-videos'),
    },
  });
}

// ── alerting ────────────────────────────────────────────────────────────────
// A day that produces nothing must be LOUD. The whole reason this file exists
// is that a silent zero looked identical to a healthy pipeline for 24 hours
// (feedback_silent-failure-is-the-enemy.md). Deduped through the same
// alert_state table api/_lib/silence-alarm.js uses so a persistent blocker
// nags once a day rather than every 30 minutes.
const ALERT_KEY = 'daily_video_supply';
const ALERT_COOLDOWN_HOURS = 20;

async function sbFetch(p, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { ok: false, data: null };
  try {
    const res = await fetch(`${SUPABASE_URL}${p}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, data };
  } catch { return { ok: false, data: null }; }
}

async function alert(text, { force = false } = {}) {
  if (NO_ALERT) { log('ALERT (suppressed by --no-alert): ' + text); return; }
  if (!force) {
    const r = await sbFetch(`/rest/v1/alert_state?key=eq.${ALERT_KEY}&select=*`);
    const row = r.ok && Array.isArray(r.data) ? r.data[0] : null;
    if (row && row.last_fired_at && daysSince(row.last_fired_at) * 24 < ALERT_COOLDOWN_HOURS) {
      log('alert suppressed (cooldown): ' + text);
      return;
    }
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      });
    } catch (e) { console.warn('[video-supply] telegram send failed:', e.message); }
  } else {
    log('WARN: TELEGRAM_BOT_TOKEN/CHAT_ID not set — cannot alert');
  }
  await sbFetch('/rest/v1/alert_state?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      key: ALERT_KEY,
      metadata: { text },
      last_fired_at: new Date().toISOString(),
      last_reason: text.slice(0, 200),
      updated_at: new Date().toISOString(),
    }),
  });
}

// ── the decision ────────────────────────────────────────────────────────────
function rank(state) {
  return FORMATS.map((f) => {
    const rw = f.runway(state);
    const blocked = f.blocked(state);
    const last = lastSuccessFor(state, f.id);
    const age = daysSince(last && last.at);
    return {
      ...f,
      remaining: rw.remaining,
      note: rw.note,
      next: rw.next || null,
      blockedReason: blocked,
      lastAt: last ? last.at : null,
      // days-since-last, normalised by how often this format is MEANT to run.
      score: rw.remaining > 0 && !blocked ? age * (f.share / 8) : -1,
    };
  }).sort((a, b) => b.score - a.score);
}

function runwayReport(ranked) {
  const lines = ranked.map((r) => {
    const status = r.blockedReason ? `BLOCKED: ${r.blockedReason}`
      : r.remaining === 0 ? 'EXHAUSTED' : `${r.remaining} left`;
    return `  ${r.id} ${r.brand.padEnd(14)} ${String(r.remaining).padStart(3)}  ${status}\n      ${r.note}`;
  });
  const live = ranked.filter((r) => !r.blockedReason && r.remaining > 0);
  const totalLive = live.reduce((n, r) => n + r.remaining, 0);
  // Days of runway at one video a day = the total across postable formats,
  // BUT no single format may be drawn faster than its share, so the real
  // ceiling is the first format to run dry under proportional draw.
  const daysUntilFirstDry = live.length
    ? Math.min(...live.map((r) => Math.floor(r.remaining * (8 / r.share))))
    : 0;
  return {
    text: lines.join('\n'),
    totalLive,
    daysUntilFirstDry,
    days: live.length ? Math.min(totalLive, daysUntilFirstDry) : 0,
  };
}

// ── main ────────────────────────────────────────────────────────────────────
(async function main() {
  const state = loadState();
  const ranked = rank(state);
  const report = runwayReport(ranked);

  if (flag('runway')) {
    console.log('\nRUNWAY (videos of genuinely real material left, per format)\n');
    console.log(report.text);
    console.log(`\n  postable total: ${report.totalLive} videos`);
    console.log(`  at 1/day with proportional rotation: ~${report.days} days before Heath must supply new material\n`);
    process.exit(0);
  }

  if (!FORCE && state.last_run_date === todayKey()) {
    log(`already ran today (${state.last_run_date}) — exiting. --force to override.`);
    process.exit(0);
  }

  const candidates = ONLY_FORMAT
    ? ranked.filter((r) => r.id.toUpperCase() === ONLY_FORMAT.toUpperCase())
    : ranked.filter((r) => r.score >= 0);

  if (candidates.length === 0) {
    const why = ranked.map((r) => `${r.id}: ${r.blockedReason || (r.remaining === 0 ? 'runway exhausted' : 'n/a')}`).join('\n');
    const msg = `VIDEO SUPPLY: no format can produce today.\n\n${why}\n\n`
      + 'Nothing will queue until one of these is cleared. See docs/CONTENT-FORMAT-LIBRARY.md §9.';
    log(msg);
    await alert(msg);
    state.last_run_date = todayKey();
    state.history = [...history(state), { at: new Date().toISOString(), format: null, ok: false, error: 'no eligible format' }];
    saveState(state);
    process.exit(1);
  }

  log('today\'s ranking: ' + candidates.map((c) => `${c.id}(${c.score.toFixed(1)}, ${c.remaining} left)`).join('  '));
  for (const skipped of ranked.filter((r) => r.blockedReason)) {
    log(`skipping ${skipped.id}: ${skipped.blockedReason}`);
  }

  if (PLAN_ONLY) {
    console.log(`\nWOULD RUN: ${candidates[0].id} (${candidates[0].label})`);
    console.log(report.text);
    process.exit(0);
  }

  // Try formats in rank order. A blocked or failing format must not cost the
  // day — the second candidate gets its turn before we call it a zero.
  const errors = [];
  for (const f of candidates) {
    log(`=== running ${f.id} — ${f.label} (${f.remaining} of runway left) ===`);
    try {
      const result = f.run(state);
      state.last_run_date = todayKey();
      state.history = [...history(state), {
        at: new Date().toISOString(), format: f.id, brand: f.brand, ok: true, ...result,
      }].slice(-200);
      saveState(state);
      const after = runwayReport(rank(state));
      log(`QUEUED: ${result.video_id}`);
      log(`path: ${result.path}`);
      log(`runway now ~${after.days} days`);
      // Success is quiet on purpose. The video shows up in the morning
      // approval batch; a second ping for the same event is noise.
      process.exit(0);
    } catch (e) {
      const msg = `${f.id}: ${(e && e.message) || e}`;
      console.error('[video-supply] ' + msg);
      errors.push(msg);
    }
  }

  state.last_run_date = todayKey();
  state.history = [...history(state), {
    at: new Date().toISOString(), format: null, ok: false, error: errors.join(' | '),
  }].slice(-200);
  saveState(state);

  const msg = 'VIDEO SUPPLY FAILED — nothing queued today.\n\n' + errors.map((e) => '- ' + e).join('\n')
    + '\n\nThe gate holds a failed render rather than queueing it, so nothing bad shipped; '
    + 'there is simply no video for today until this is fixed.';
  await alert(msg, { force: true });
  process.exit(1);
})().catch(async (e) => {
  console.error('[video-supply] threw:', (e && e.stack) || e);
  await alert(`VIDEO SUPPLY CRASHED: ${(e && e.message) || e}`, { force: true });
  process.exit(1);
});
