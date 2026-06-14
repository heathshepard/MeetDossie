'use strict';

// scripts/atlas-fb-first-comments-blitz-v2.js
//
// V2 (revised 2026-06-14 by Sage)
//
// Pulls 6-8 group_posts rows JOINED to group_registry, prioritising registry
// rows with the OLDEST last_blitzed_at — true round-robin across all ~30
// active groups instead of the previous 6 hardcoded UUIDs. Each group is
// hit at most once per cool_down_hours (default 168h = weekly) so we touch
// every group within a week rather than the same 6 every day.
//
// On a successful first-comment post, BOTH:
//   - group_posts.first_comment_posted_at = NOW()
//   - group_registry.last_blitzed_at      = NOW()
//   - group_registry.blitz_count          = blitz_count + 1
// are set, so the next blitz naturally selects the next-coldest group.
//
// Flags:
//   --only <label>     — run a single group (label = group slug, or "all")
//   --max <N>          — override the per-run cap (default 7)
//
// Selection rules:
//   1. group_posts.status='approved' AND first_comment_posted_at IS NULL
//      AND first_comment_body IS NOT NULL AND first_comment_body contains "Dossie"
//   2. JOIN group_registry by group_registry_id
//      WHERE group_registry.skip=false
//      AND (last_blitzed_at IS NULL OR NOW() - last_blitzed_at > cool_down_hours)
//   3. Order by group_registry.last_blitzed_at ASC NULLS FIRST, group_posts.created_at ASC
//   4. Limit per-run cap (default 7)

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

const PY_DRIVER = path.join(__dirname, 'atlas-fb-first-comment-v2.py');
const TMP_DIR = path.join(os.tmpdir(), 'atlas-fb-first-comments-v2');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const DEFAULT_CAP = 7;

// CLI arg parsing
function argFlag(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  return process.argv[i + 1] || null;
}
const onlyArg = argFlag('--only');
const maxArg  = parseInt(argFlag('--max') || '', 10);
const PER_RUN_CAP = Number.isFinite(maxArg) && maxArg > 0 ? maxArg : DEFAULT_CAP;

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

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}

// Derive a unique needle (search term for the PyAutoGUI driver) from the
// post body. We want a 4-8 word substring that's distinctive enough to find
// the parent post in the FB group feed.
function deriveNeedle(postBody) {
  if (!postBody) return null;
  const cleaned = String(postBody)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Try paragraph 1 first 6-8 words (most distinctive part of opening).
  const words = cleaned.split(/\s+/);
  if (words.length < 4) return null;
  // Skip very generic openings like "Hi everyone" / "Quick question" — start
  // at word index 2-4 if we can.
  const start = Math.min(2, Math.max(0, words.length - 8));
  const slice = words.slice(start, start + 7).join(' ');
  // Strip trailing punctuation so PyAutoGUI's text-match doesn't get tripped.
  return slice.replace(/[.,!?;:"']+$/, '');
}

// Load the next batch: oldest-blitzed groups with an approved-but-uncommented
// group_posts row available. We do this in 2 steps because PostgREST can't
// express the WHERE-on-joined-table-with-NULL-cool-down-or-stale rule cleanly.
async function loadBlitzTargets(limit) {
  // 1. Fetch all eligible group_registry rows, sorted by last_blitzed_at ASC NULLS FIRST.
  //    Cool-down filter applied client-side because PostgREST can't compare cool_down_hours
  //    interval against NOW() - last_blitzed_at in one filter.
  const registryRes = await sb(
    '/rest/v1/group_registry?skip=eq.false&select=id,group_name,group_url,category,cool_down_hours,last_blitzed_at,blitz_count' +
    '&order=last_blitzed_at.asc.nullsfirst'
  );
  if (!registryRes.ok || !Array.isArray(registryRes.data)) {
    throw new Error(`Failed to load group_registry: ${registryRes.status}`);
  }
  const now = Date.now();
  const eligibleRegistry = registryRes.data.filter((g) => {
    if (!g.last_blitzed_at) return true;
    const lastMs = new Date(g.last_blitzed_at).getTime();
    const cooldownMs = (g.cool_down_hours || 168) * 60 * 60 * 1000;
    return (now - lastMs) >= cooldownMs;
  });

  // 2. For each eligible registry row, find the oldest unblitzed approved
  //    group_posts row. Stop once we have `limit` candidates.
  const targets = [];
  for (const reg of eligibleRegistry) {
    if (targets.length >= limit) break;
    const postsRes = await sb(
      `/rest/v1/group_posts?group_registry_id=eq.${encodeURIComponent(reg.id)}` +
      `&status=eq.approved` +
      `&first_comment_posted_at=is.null` +
      `&first_comment_body=not.is.null` +
      `&order=created_at.asc&limit=1&select=id,group_name,group_url,post_body,first_comment_body,template_id,pillar,created_at`
    );
    if (!postsRes.ok || !Array.isArray(postsRes.data) || !postsRes.data.length) continue;
    const row = postsRes.data[0];
    const needle = deriveNeedle(row.post_body);
    if (!needle) continue;
    targets.push({
      id: row.id,
      registryId: reg.id,
      label: slugify(reg.group_name) + '-' + row.id.slice(0, 8),
      groupName: reg.group_name,
      groupUrl: row.group_url || reg.group_url,
      category: reg.category,
      needle,
      commentBody: row.first_comment_body,
      lastBlitzedAt: reg.last_blitzed_at,
    });
  }
  return targets;
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

async function markCommentPosted(postId, registryId) {
  const now = new Date().toISOString();
  // 1. group_posts.first_comment_posted_at = NOW()
  await sb(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ first_comment_posted_at: now }),
  });
  // 2. group_registry: bump last_blitzed_at + blitz_count + outcome
  if (registryId) {
    // We can't do count = count + 1 in PostgREST without an RPC.
    // Cheap path: GET current count, PATCH with +1.
    const curr = await sb(`/rest/v1/group_registry?id=eq.${encodeURIComponent(registryId)}&select=blitz_count`);
    const count = (curr?.data?.[0]?.blitz_count || 0) + 1;
    await sb(`/rest/v1/group_registry?id=eq.${encodeURIComponent(registryId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_blitzed_at: now,
        blitz_count: count,
        last_blitz_outcome: 'posted',
      }),
    });
  }
}

async function markCommentFailed(registryId, outcome) {
  if (!registryId) return;
  // Don't bump last_blitzed_at on failure — failures should be retried, not
  // pushed to back of queue. Just record the outcome for diagnostics.
  await sb(`/rest/v1/group_registry?id=eq.${encodeURIComponent(registryId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_blitz_outcome: outcome || 'failed' }),
  });
}

// Idempotency: skip the end-of-run Telegram digest if an identical message
// was already sent in the last 30 minutes. Multiple runs can stack from
// retries or watchdog re-triggers — Heath should see at most one digest.
async function shouldSendDigest(notificationKey) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const res = await sb(
    `/rest/v1/cron_notifications?notification_key=eq.${encodeURIComponent(notificationKey)}` +
    `&sent_at=gte.${encodeURIComponent(cutoff)}&select=id&limit=1`
  );
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) return false;
  return true;
}

async function recordDigestSent(notificationKey, meta) {
  await sb('/rest/v1/cron_notifications', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ notification_key: notificationKey, meta: meta || {} }),
  });
}

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

  console.log(`[atlas-comments-v2] loading targets (cap=${PER_RUN_CAP}, registry rotation by last_blitzed_at)`);
  let targets;
  try {
    targets = await loadBlitzTargets(PER_RUN_CAP);
  } catch (e) {
    console.error('[atlas-comments-v2] FATAL loading targets:', e.message);
    process.exit(1);
  }
  if (onlyArg && onlyArg !== 'all') {
    targets = targets.filter((t) => t.label.startsWith(onlyArg) || slugify(t.groupName).includes(onlyArg));
    if (!targets.length) {
      console.error(`[atlas-comments-v2] --only ${onlyArg} matched no rotation targets`);
      process.exit(1);
    }
  }
  if (!targets.length) {
    const note = '[atlas-comments-v2] No eligible group_posts found in rotation (all within cool-down or no approved-uncommented rows). Generator may need to run.';
    console.log(note);
    await tg('FB blitz: nothing to ship (rotation pool empty or all in cool-down).');
    process.exit(0);
  }
  console.log(`[atlas-comments-v2] selected ${targets.length} target(s) from rotation:`);
  for (const t of targets) {
    const lb = t.lastBlitzedAt ? `last_blitzed=${t.lastBlitzedAt}` : 'NEVER blitzed';
    console.log(`  - ${t.groupName} (${lb}, category=${t.category})`);
  }

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const item = targets[i];
    const idx = i + 1;
    console.log(`\n[atlas-comments-v2] === ${idx}/${targets.length} ${item.groupName} ===`);

    if (!/\bDossie\b/.test(item.commentBody)) {
      console.warn(`[atlas-comments-v2] WARNING: ${item.groupName} body lacks 'Dossie'`);
    }

    console.log(`[atlas-comments-v2] attempt 1 for ${item.groupName}`);
    let driverRes = await runDriver({
      groupUrl: item.groupUrl,
      needle: item.needle,
      commentBody: item.commentBody,
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
        groupUrl: item.groupUrl,
        needle: item.needle,
        commentBody: item.commentBody,
        postId: item.id,
        label: item.label,
      });
      outcome = driverRes.result?.outcome;
      runDir = driverRes.result?.run_dir;
    }

    const preview = item.commentBody.slice(0, 80).replace(/\n/g, ' ');
    if (outcome === 'posted') {
      await markCommentPosted(item.id, item.registryId);
      results.push({ ...item, outcome, runDir });
      await tg(`COMMENT LIVE - ${item.groupName}\n\n"${preview}..."`);
    } else {
      await markCommentFailed(item.registryId, outcome);
      results.push({ ...item, outcome: outcome || 'unknown', runDir });
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
    for (const r of failed) summary += `  - ${r.groupName} -- ${r.outcome}\n`;
  }
  console.log('\n' + summary);

  // IDEMPOTENT digest send: only one per 30 min, keyed by date so a same-day
  // re-run doesn't dupe Heath's Telegram.
  if (!onlyArg) {
    const digestKey = `fb-first-comments-blitz-${new Date().toISOString().slice(0,10)}`;
    if (await shouldSendDigest(digestKey)) {
      await tg(summary);
      await recordDigestSent(digestKey, { posted: posted.length, failed: failed.length, total: targets.length });
    } else {
      console.log(`[atlas-comments-v2] digest already sent recently (key=${digestKey}) — suppressing duplicate`);
    }
  }

  const summaryDir = path.join(__dirname, 'atlas-runs', `fb-first-comments-v2-${Date.now()}`);
  fs.mkdirSync(summaryDir, { recursive: true });
  fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify({ results }, null, 2));
  console.log(`[atlas-comments-v2] summary -> ${summaryDir}`);

  process.exit(failed.length > 0 ? 1 : 0);
})().catch((e) => {
  console.error('[atlas-comments-v2] FATAL:', e.stack || e.message);
  process.exit(1);
});
