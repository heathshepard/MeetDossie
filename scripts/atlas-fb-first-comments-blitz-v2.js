'use strict';

// scripts/atlas-fb-first-comments-blitz-v2.js
// V2 — uses atlas-fb-first-comment-v2.py. Adds: --only flag to run a single post.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

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

const POSTS = [
  {
    id: 'fc1762df-60eb-463f-98c6-5e10eed13e6d',
    label: 'texas-real-estate-agents',
    needle: 'Option periods, financing contingencies, appraisal windows',
  },
  {
    id: '37faa0aa-dce2-4dfe-bced-48e507eb2d2f',
    label: 'texas-real-estate-network',
    needle: 'spreadsheet line item gets brutal',
  },
  {
    id: 'd078e368-1738-4bdc-a2f5-fc1f0fe8399c',
    label: 'dallas-texas-realtors',
    needle: 'drained me the most early on',
  },
  {
    id: 'b9add267-e9b1-4f4d-8421-debe19dec9db',
    label: 'all-about-real-estate-houston',
    needle: 'email chains across six parties',
  },
  {
    id: 'b4aa1c2f-924b-4aa6-9330-373d897c1b36',
    label: 'realtors-san-antonio-boerne',
    needle: 'Stone Oak listings and Hill Country buyers',
  },
  {
    id: 'd68ce2f6-f3e9-4dbb-99d5-5f053cf4f315',
    label: 'texas-hill-country-real-estate',
    needle: 'solo agents working Hill Country deals',
  },
];

const PY_DRIVER = path.join(__dirname, 'atlas-fb-first-comment-v2.py');
const TMP_DIR = path.join(os.tmpdir(), 'atlas-fb-first-comments-v2');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Parse --only label
const onlyArg = process.argv.find((a, i) => process.argv[i - 1] === '--only');

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

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch {}
}

function runDriver({ groupUrl, needle, commentBody, postId, label }) {
  return new Promise((resolve) => {
    const bodyFile = path.join(TMP_DIR, `${postId}.txt`);
    fs.writeFileSync(bodyFile, commentBody, 'utf8');
    const args = [
      PY_DRIVER,
      '--group-url', groupUrl,
      '--needle', needle,
      '--comment-file', bodyFile,
      '--post-id', postId,
      '--label', label,
    ];
    const proc = spawn('python', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { const s = d.toString(); stdout += s; process.stdout.write(s); });
    proc.stderr.on('data', (d) => { const s = d.toString(); stderr += s; process.stderr.write(s); });
    proc.on('close', (code) => {
      const m = stdout.match(/ATLAS_RESULT_JSON:(\{.*\})\s*$/m);
      let parsed = null;
      if (m) { try { parsed = JSON.parse(m[1]); } catch {} }
      try { fs.unlinkSync(bodyFile); } catch {}
      resolve({ exitCode: code, result: parsed, stdout, stderr });
    });
  });
}

async function markCommentPosted(postId) {
  const now = new Date().toISOString();
  const res = await sb(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ first_comment_posted_at: now }),
  });
  return res.ok;
}

// Same DossieBot-Sage profile dir the poster + watcher target. The first-
// comment blitz drives Heath's main Chrome via PyAutoGUI rather than
// launchPersistentContext, but a stale DossieBot Chrome from a prior
// poster run can still hold a Singleton lock that breaks the next
// fb-group-poster invocation. Pre-clearing here is cheap insurance.
const CHROME_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);

(async () => {
  // Preflight: close FB tabs in Heath's main Chrome so they don't race with
  // the DossieBot automation profile / PyAutoGUI window targeting.
  try {
    const { preflight } = require('./_lib/fb-tab-preflight');
    const pre = await preflight({ reason: 'first-comments-blitz-v2' });
    console.log(`[atlas-comments-v2] preflight: closed=${pre.closed} skipped_dossiebot=${pre.skipped_dossiebot}`);
  } catch (e) {
    console.warn(`[atlas-comments-v2] preflight non-fatal error: ${e.message}`);
  }

  // Profile unlock: kill stale chrome.exe holding a lock on the DossieBot
  // user-data-dir. Same fix Sage applied to the group poster after 2 of 7
  // posts failed today (2026-06-11) with Singleton-lock errors.
  try {
    const { unlockProfile } = require('./_lib/chrome-profile-unlock');
    const unlocked = await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'first-comments-blitz-v2' });
    if (unlocked.killed > 0) {
      console.log(`[atlas-comments-v2] profile-unlock: killed ${unlocked.killed} stale chrome process(es) for ${CHROME_PROFILE_PATH}`);
    }
  } catch (e) {
    console.warn(`[atlas-comments-v2] profile-unlock non-fatal error: ${e.message}`);
  }

  let targets = POSTS;
  if (onlyArg) {
    targets = POSTS.filter((p) => p.label === onlyArg);
    if (!targets.length) {
      console.error(`[atlas-comments-v2] --only ${onlyArg} matched no posts`);
      process.exit(1);
    }
    console.log(`[atlas-comments-v2] running ONLY: ${onlyArg}`);
  } else {
    console.log('[atlas-comments-v2] running ALL 6');
  }

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    const idx = i + 1;
    console.log(`\n[atlas-comments-v2] === ${idx}/${targets.length} ${item.label} ===`);

    const pre = await sb(`/rest/v1/group_posts?id=eq.${encodeURIComponent(item.id)}&select=*`);
    const row = pre?.data?.[0];
    if (!row) { results.push({ ...item, outcome: 'not_found' }); continue; }

    if (row.first_comment_posted_at) {
      console.log(`[atlas-comments-v2] already posted at ${row.first_comment_posted_at} - skip`);
      results.push({ ...item, groupName: row.group_name, outcome: 'already_posted' });
      continue;
    }

    const commentBody = row.first_comment_body;
    if (!commentBody) { results.push({ ...item, outcome: 'no_body' }); continue; }
    if (!/\bDossie\b/.test(commentBody)) {
      console.warn(`[atlas-comments-v2] WARNING: ${row.group_name} body lacks 'Dossie'`);
    }

    console.log(`[atlas-comments-v2] attempt 1 for ${row.group_name}`);
    let driverRes = await runDriver({
      groupUrl: row.group_url,
      needle: item.needle,
      commentBody,
      postId: item.id,
      label: item.label,
    });
    let outcome = driverRes.result?.outcome;
    let runDir = driverRes.result?.run_dir;

    const retryable = ['composer_unclickable', 'paste_failed', 'submit_failed', 'comment_button_missing'];
    if (retryable.includes(outcome)) {
      console.log(`[atlas-comments-v2] retry in 12s (${outcome})...`);
      await new Promise((r) => setTimeout(r, 12000));
      driverRes = await runDriver({
        groupUrl: row.group_url,
        needle: item.needle,
        commentBody,
        postId: item.id,
        label: item.label,
      });
      outcome = driverRes.result?.outcome;
      runDir = driverRes.result?.run_dir;
    }

    const preview = commentBody.slice(0, 80).replace(/\n/g, ' ');
    if (outcome === 'posted') {
      await markCommentPosted(item.id);
      results.push({ ...item, groupName: row.group_name, outcome, runDir });
      await tg(`COMMENT LIVE - ${row.group_name}\n\n"${preview}..."`);
    } else {
      results.push({ ...item, groupName: row.group_name, outcome: outcome || 'unknown', runDir });
    }

    if (i < targets.length - 1) {
      console.log('[atlas-comments-v2] sleep 25s before next...');
      await new Promise((r) => setTimeout(r, 25000));
    }
  }

  const posted = results.filter((r) => r.outcome === 'posted' || r.outcome === 'already_posted');
  const failed = results.filter((r) => !['posted', 'already_posted'].includes(r.outcome));

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  let summary = `FB FIRST-COMMENTS BLITZ V2 COMPLETE - ${dateStr}\n\n`;
  summary += `Live: ${posted.length}/${targets.length}\n`;
  for (const r of posted) summary += `  - ${r.groupName} (${r.outcome})\n`;
  if (failed.length) {
    summary += `\nFailed: ${failed.length}\n`;
    for (const r of failed) summary += `  - ${r.groupName || r.label} -- ${r.outcome}\n`;
  }
  console.log('\n' + summary);
  if (!onlyArg) await tg(summary);

  const summaryDir = path.join(__dirname, 'atlas-runs', `fb-first-comments-v2-${Date.now()}`);
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify({ results }, null, 2));
  console.log(`[atlas-comments-v2] summary -> ${summaryDir}`);

  process.exit(failed.length > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[atlas-comments-v2] FATAL:', e.stack || e.message);
  process.exit(1);
});
