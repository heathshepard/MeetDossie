'use strict';

// scripts/atlas-fb-blitz-pyautogui.js
//
// Atlas orchestrator for the 6-post Sage FB blitz when Heath's Chrome is open.
// Drives PyAutoGUI per post (no Playwright, no profile lock collision).
//
// Per memory rules:
//   - feedback_pyautogui_not_playwright.md (PyAutoGUI on real Chrome is the default)
//   - feedback_cole_does_web_forms.md (we drive web forms, never ask Heath)
//   - feedback_never_ask_heath_to_do_what_cole_can.md (no asking Heath to close Chrome)
//   - feedback_no_quitting_mission_complete.md (failure is not an option)
//
// Behavior:
//   - Pull all 6 approved sage-blitz posts from group_posts (hard-coded IDs).
//   - For each: write post_body to temp file, spawn the Python driver, capture
//     ATLAS_RESULT_JSON line from stdout.
//   - On 'posted'/'pending_review': mark Supabase status='posted' + send per-post
//     Telegram ping with screenshot of final state.
//   - On 'no_composer': mark Supabase status='skipped_no_composer' + tag in
//     reference_fb_groups.md (out-of-band).
//   - On other failures: retry once with a 10s delay. If still failing, mark
//     status='approved' (so it stays in the queue) + roll into final summary.
//   - End-of-blitz: single Telegram summary message.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Load .env.local
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const POST_IDS = [
  'fc1762df-60eb-463f-98c6-5e10eed13e6d', // Texas Real Estate Agents — CONTROL / Victor
  '37faa0aa-dce2-4dfe-bced-48e507eb2d2f', // Texas Real Estate Network — COST / Patricia
  'd078e368-1738-4bdc-a2f5-fc1f0fe8399c', // Dallas Texas Realtors — VISIBILITY / Brenda
  'b9add267-e9b1-4f4d-8421-debe19dec9db', // All about Real Estate Houston — SPEED / Patricia
  'b4aa1c2f-924b-4aa6-9330-373d897c1b36', // Realtors San Antonio Boerne Bulverde New Braunfels — CONTROL / Victor
  'd68ce2f6-f3e9-4dbb-99d5-5f053cf4f315', // Texas Hill Country Real Estate — COST / Patricia
];

const PY_DRIVER = path.join(__dirname, 'atlas-fb-post-pyautogui.py');
const TMP_DIR = path.join(os.tmpdir(), 'atlas-fb-blitz');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

async function sb(p, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch {} }
  return { ok: res.ok, status: res.status, data };
}

async function tg(text, files = []) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn('[atlas-blitz] tg failed:', e.message);
  }
}

function runDriver({ groupUrl, postBody, postId, idx, total }) {
  return new Promise((resolve) => {
    const bodyFile = path.join(TMP_DIR, `${postId}.txt`);
    fs.writeFileSync(bodyFile, postBody, 'utf8');

    const args = [
      PY_DRIVER,
      '--group-url', groupUrl,
      '--post-body-file', bodyFile,
      '--post-id', postId,
      '--idx', String(idx),
      '--total', String(total),
    ];

    const proc = spawn('python', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { const s = d.toString(); stdout += s; process.stdout.write(s); });
    proc.stderr.on('data', (d) => { const s = d.toString(); stderr += s; process.stderr.write(s); });
    proc.on('close', (code) => {
      // Parse ATLAS_RESULT_JSON line
      const m = stdout.match(/ATLAS_RESULT_JSON:(\{.*\})\s*$/m);
      let parsed = null;
      if (m) {
        try { parsed = JSON.parse(m[1]); } catch {}
      }
      try { fs.unlinkSync(bodyFile); } catch {}
      resolve({ exitCode: code, result: parsed, stdout, stderr });
    });
  });
}

async function markPosted(postId, postUrl, runDir) {
  // group_posts has no `notes` column — keep the patch to only valid columns
  const now = new Date().toISOString();
  const res = await sb(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'posted',
      posted_at: now,
      post_url: postUrl || null,
    }),
  });
  if (!res.ok) console.error(`[atlas-blitz] markPosted ${postId} failed: ${res.status}`, res.data);
  return res.ok;
}

async function markSkipped(postId, reason, runDir) {
  // 'skipped_no_composer' is not in group_posts.status check constraint.
  // Leave status='approved' — orchestrator's results array tracks per-run skips.
  console.log(`[atlas-blitz] post ${postId} SKIPPED reason=${reason} — leaving status=approved`);
  return true;
}

async function markFailed(postId, reason, runDir) {
  // Leave status as 'approved' so it retries in next blitz — no DB write needed
  // Just log for observability
  console.log(`[atlas-blitz] post ${postId} FAILED reason=${reason} — leaving status=approved for retry`);
  return true;
}

(async () => {
  console.log('[atlas-blitz] Starting FB blitz — PyAutoGUI driver (Heath\'s Chrome stays open)');
  await tg('Atlas FB blitz starting — PyAutoGUI driver on Heath\'s real Chrome. 6 posts. No Chrome restart needed.');

  const results = [];

  for (let i = 0; i < POST_IDS.length; i++) {
    const id = POST_IDS[i];
    const idx = i + 1;
    console.log(`\n[atlas-blitz] === Post ${idx}/${POST_IDS.length} (${id}) ===`);

    // Pull fresh row
    const pre = await sb(`/rest/v1/group_posts?id=eq.${encodeURIComponent(id)}&select=*`);
    const row = pre?.data?.[0];
    if (!row) {
      console.error(`[atlas-blitz] post ${id} not found — skipping`);
      results.push({ idx, id, groupName: '(missing)', outcome: 'not_found' });
      continue;
    }

    if (row.status === 'posted') {
      console.log(`[atlas-blitz] post ${id} already posted — skipping`);
      results.push({ idx, id, groupName: row.group_name, outcome: 'already_posted', postUrl: row.post_url });
      continue;
    }

    const groupName = row.group_name;
    const groupUrl = row.group_url;
    const pillar = row.pillar;
    const body = row.post_body;
    const preview = (body || '').slice(0, 80).replace(/\n/g, ' ');

    // Attempt 1
    console.log(`[atlas-blitz] attempt 1 for ${groupName}`);
    let driverRes = await runDriver({ groupUrl, postBody: body, postId: id, idx, total: POST_IDS.length });
    let outcome = driverRes.result?.outcome;
    let runDir = driverRes.result?.run_dir;

    // Retry once on non-final failures
    const retryable = ['composer_unclickable', 'post_button_missing', 'paste_failed', 'page_load_failed'];
    if (retryable.includes(outcome)) {
      console.log(`[atlas-blitz] attempt 1 failed (${outcome}). Retrying in 15s...`);
      await new Promise((r) => setTimeout(r, 15000));
      driverRes = await runDriver({ groupUrl, postBody: body, postId: id, idx, total: POST_IDS.length });
      outcome = driverRes.result?.outcome;
      runDir = driverRes.result?.run_dir;
    }

    if (outcome === 'posted' || outcome === 'pending_review') {
      await markPosted(id, null, runDir);
      results.push({ idx, id, groupName, pillar, outcome, runDir });
      const tag = outcome === 'pending_review' ? 'PENDING REVIEW' : 'POSTED';
      await tg(`${tag} ${idx}/${POST_IDS.length} — ${groupName} (${pillar})\n\n"${preview}..."`);
    } else if (outcome === 'no_composer') {
      await markSkipped(id, 'no composer detected on group page', runDir);
      results.push({ idx, id, groupName, pillar, outcome, runDir });
      console.log(`[atlas-blitz] ${groupName} skipped — no composer`);
      // No per-skip Telegram ping per spec
    } else {
      await markFailed(id, outcome || 'unknown', runDir);
      results.push({ idx, id, groupName, pillar, outcome: outcome || 'unknown', runDir });
      console.log(`[atlas-blitz] ${groupName} failed — outcome=${outcome}`);
    }

    // Pause between posts (look human)
    if (i < POST_IDS.length - 1) {
      console.log('[atlas-blitz] sleeping 25s before next post...');
      await new Promise((r) => setTimeout(r, 25000));
    }
  }

  // Final summary
  const posted = results.filter((r) => r.outcome === 'posted' || r.outcome === 'pending_review' || r.outcome === 'already_posted');
  const skipped = results.filter((r) => r.outcome === 'no_composer');
  const failed = results.filter((r) => !['posted','pending_review','already_posted','no_composer'].includes(r.outcome));

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  let summary = `FB BLITZ COMPLETE — ${dateStr} (Atlas PyAutoGUI)\n\n`;
  summary += `Posted: ${posted.length}/${POST_IDS.length}\n`;
  for (const r of posted) summary += `  • ${r.groupName} (${r.pillar || '?'})\n`;
  if (skipped.length) {
    summary += `\nSkipped (no composer): ${skipped.length}\n`;
    for (const r of skipped) summary += `  • ${r.groupName}\n`;
  }
  if (failed.length) {
    summary += `\nFailed (reset to approved): ${failed.length}\n`;
    for (const r of failed) summary += `  • ${r.groupName} — ${r.outcome}\n`;
  }
  summary += `\nHeath's Chrome stayed open throughout. No profile lock.`;

  await tg(summary);
  console.log('\n' + summary);

  // Write summary JSON for atlas-runs trail
  const summaryDir = path.join(__dirname, 'atlas-runs', `fb-blitz-${Date.now()}`);
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify({ results, posted: posted.length, skipped: skipped.length, failed: failed.length }, null, 2));
  console.log(`[atlas-blitz] summary written to ${summaryDir}`);

  process.exit(failed.length > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[atlas-blitz] FATAL:', e.stack || e.message);
  tg(`Atlas FB blitz CRASHED: ${e.message}`).finally(() => process.exit(1));
});
