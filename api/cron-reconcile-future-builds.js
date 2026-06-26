const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// api/cron-reconcile-future-builds.js
//
// SV-ENG-FUTURE-BUILDS-RECONCILER (Atlas, 2026-06-25)
//
// PURPOSE: Aggregate in-flight engineering work from every authoritative
// source and write it to public.jarvis_future_builds so the Jarvis HUD always
// reflects reality. The TaskList in the Cole/Jarvis conversation is
// transient — this cron makes the HUD durable.
//
// SOURCES (run in this order — most-authoritative first):
//   1. github          — branches with commits in last 14 days, not main/staging
//   2. github-pr       — open PRs in heathshepard/MeetDossie + heathshepard/Dossie
//   3. memory          — project_*_handoff_*.md + project_*_in_flight.md
//   4. dod             — files in Shepard-Ventures/Engineering/definitions-of-done/ mod'd last 30d
//   5. heath-queue     — heath_todo rows with status in ('pending', 'in_progress')
//   6. agent-thread    — SKIPPED for v1 (too noisy at item level; nice-to-have)
//
// IDEMPOTENCY: each row carries source_key = "<source>:<id>". The cron does
// UPSERT ON CONFLICT (tenant_id, source_key) so re-runs are safe. Items that
// drop out of source on subsequent runs are archived (status='shipped',
// archived_at=now()) — never deleted.
//
// STALL DETECTION: rows whose source didn't refresh in >14 days get a
// "stalled":true flag in description JSON, but are NOT archived — waits for
// human kill decision.
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// SCHEDULE: every 6h via vercel.json. Manual trigger:
//   curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-reconcile-future-builds
//
// TENANT: hard-coded to Heath's auth.users.id. Future expansion: enumerate
// tenants from a config table.

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const GITHUB_TOKEN              = process.env.GITHUB_TOKEN; // optional, raises rate limit

const HEATH_TENANT_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';

const REPOS = [
  'heathshepard/MeetDossie',
  'heathshepard/Dossie',
];
const PROTECTED_BRANCHES = new Set(['main', 'master', 'staging', 'production', 'gh-pages']);
const BRANCH_ACTIVE_DAYS = 14;
const DOD_MOD_DAYS       = 30;
const STALL_DAYS         = 14;

// Filesystem roots
const path = require('path');
const fs   = require('fs');
const MEMORY_ROOT = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.claude', 'projects', 'C--Users-Heath-Shepard-Desktop-MeetDossie', 'memory'
);
const DOD_ROOT = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  'Desktop', 'Shepard-Ventures', 'Engineering', 'definitions-of-done'
);

// ─── Supabase helpers ────────────────────────────────────────────────────────

async function sb(restPath, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 0, data: null, error: 'missing_supabase_env' };
  }
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  try {
    const res = await fetch(`${SUPABASE_URL}${restPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : (data && (data.message || data.error || text)) };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err && err.message || err) };
  }
}

// ─── GitHub helpers ──────────────────────────────────────────────────────────

async function ghFetch(apiPath) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'shepard-ventures-future-builds-reconciler',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com${apiPath}`, { headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err && err.message || err) };
  }
}

function humanizeBranchName(name) {
  // feat/foo-bar-baz → "Foo Bar Baz"
  // atlas-thing → "Atlas Thing"
  // strip prefix paths and casing
  const base = String(name).split('/').slice(-1)[0] || String(name);
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// ─── Source 1: GitHub branches ───────────────────────────────────────────────

async function collectGithubBranches() {
  const out = [];
  const cutoffMs = Date.now() - BRANCH_ACTIVE_DAYS * 86400 * 1000;
  for (const repo of REPOS) {
    // Page through branches. Most repos have <100 so 1 page is enough.
    const { ok, data } = await ghFetch(`/repos/${repo}/branches?per_page=100`);
    if (!ok || !Array.isArray(data)) continue;
    for (const br of data) {
      const name = br.name;
      if (PROTECTED_BRANCHES.has(name)) continue;
      // Cheap activity probe: fetch the branch detail for its commit timestamp.
      const det = await ghFetch(`/repos/${repo}/branches/${encodeURIComponent(name)}`);
      const committedAt = det?.data?.commit?.commit?.committer?.date
        || det?.data?.commit?.commit?.author?.date;
      if (!committedAt) continue;
      const ts = Date.parse(committedAt);
      if (Number.isFinite(ts) && ts >= cutoffMs) {
        out.push({
          source: 'github',
          source_key: `github:${repo.split('/')[1]}:${name}`,
          title: humanizeBranchName(name),
          description: `Active branch in ${repo}. Last commit ${committedAt}.`,
          status: 'building',
          source_doc_path: `https://github.com/${repo}/tree/${encodeURIComponent(name)}`,
          last_activity: committedAt,
        });
      }
    }
  }
  return out;
}

// ─── Source 2: GitHub open PRs ───────────────────────────────────────────────

async function collectGithubPRs() {
  const out = [];
  for (const repo of REPOS) {
    const { ok, data } = await ghFetch(`/repos/${repo}/pulls?state=open&per_page=100`);
    if (!ok || !Array.isArray(data)) continue;
    for (const pr of data) {
      const reviewState = pr.requested_reviewers && pr.requested_reviewers.length > 0
        ? 'review-requested'
        : 'open';
      const merged = pr.merged_at ? true : false;
      let status = 'building';
      // PR-ready-to-merge hint goes into description; status stays "building".
      let descTag = '';
      if (pr.mergeable_state === 'clean' && pr.draft === false) descTag = ' Ready to merge.';
      if (pr.draft) descTag = ' Draft.';
      out.push({
        source: 'github-pr',
        source_key: `github-pr:${repo.split('/')[1]}:#${pr.number}`,
        title: pr.title || `PR #${pr.number}`,
        description: `${repo} PR #${pr.number} (${reviewState}).${descTag} ${pr.html_url}`,
        status,
        source_doc_path: pr.html_url,
        last_activity: pr.updated_at || pr.created_at,
      });
    }
  }
  return out;
}

// ─── Source 3: Memory handoff/in-flight files ────────────────────────────────

function collectMemoryHandoffs() {
  const out = [];
  try {
    if (!fs.existsSync(MEMORY_ROOT)) return out;
    const files = fs.readdirSync(MEMORY_ROOT);
    const pattern = /^project_.*(handoff|in_flight).*\.md$/i;
    const now = Date.now();
    for (const f of files) {
      if (!pattern.test(f)) continue;
      const full = path.join(MEMORY_ROOT, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch { content = ''; }
      // Title from frontmatter description: or first markdown H1, else filename.
      let title = null;
      const fmMatch = content.match(/^---[\s\S]*?description:\s*(.+)$/m);
      if (fmMatch) title = fmMatch[1].trim();
      if (!title) {
        const h1 = content.match(/^#\s+(.+)$/m);
        if (h1) title = h1[1].trim();
      }
      if (!title) title = f.replace(/\.md$/, '').replace(/_/g, ' ');
      out.push({
        source: 'memory',
        source_key: `memory:${f.replace(/\.md$/, '')}`,
        title: title.slice(0, 180),
        description: `Memory handoff file: ${f}. Modified ${stat.mtime.toISOString()}.`,
        status: 'idea',
        source_doc_path: full,
        last_activity: stat.mtime.toISOString(),
      });
    }
  } catch (err) {
    console.warn('[reconciler] memory scan failed', err.message);
  }
  return out;
}

// ─── Source 4: DoD drafts ────────────────────────────────────────────────────

function collectDoDDrafts() {
  const out = [];
  try {
    if (!fs.existsSync(DOD_ROOT)) return out;
    const cutoffMs = Date.now() - DOD_MOD_DAYS * 86400 * 1000;
    const files = fs.readdirSync(DOD_ROOT);
    for (const f of files) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(DOD_ROOT, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs < cutoffMs) continue;
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch { content = ''; }
      // Skip if marked shipped already
      if (/^status:\s*shipped/im.test(content)) continue;
      let title = null;
      const h1 = content.match(/^#\s+(.+)$/m);
      if (h1) title = h1[1].trim();
      if (!title) title = f.replace(/\.md$/, '').replace(/-/g, ' ');
      out.push({
        source: 'dod',
        source_key: `dod:${f}`,
        title: `DoD: ${title}`.slice(0, 180),
        description: `DoD draft modified ${stat.mtime.toISOString()}. ${f}`,
        status: 'dod_drafting',
        source_doc_path: full,
        last_activity: stat.mtime.toISOString(),
      });
    }
  } catch (err) {
    console.warn('[reconciler] DoD scan failed', err.message);
  }
  return out;
}

// ─── Source 5: heath_todo queue ─────────────────────────────────────────────

async function collectHeathTodo() {
  const out = [];
  const sel = await sb(
    `/rest/v1/heath_todo?status=in.(pending,in_progress)&select=id,title,detail,status,created_at,deadline,venture,priority&limit=200`,
    { method: 'GET' }
  );
  if (!sel.ok || !Array.isArray(sel.data)) return out;
  for (const row of sel.data) {
    const title = (row.title || '').toString().slice(0, 180);
    if (!title) continue;
    out.push({
      source: 'heath-queue',
      source_key: `heath-queue:${row.id}`,
      title,
      description: `Heath queue (${row.status}). ${row.detail || ''}`.slice(0, 1000),
      status: 'building',
      source_doc_path: null,
      score: row.priority || null,
      last_activity: row.created_at,
    });
  }
  return out;
}

// ─── Reconcile: UPSERT into jarvis_future_builds ─────────────────────────────

async function fetchExistingReconciledRows() {
  // All non-archived rows whose source_key isn't a "manual:..." (we don't
  // touch hand-seeded items; only the ones we ourselves wrote).
  const sel = await sb(
    `/rest/v1/jarvis_future_builds?tenant_id=eq.${HEATH_TENANT_ID}` +
    `&select=id,source_key,status,description,updated_at,archived_at` +
    `&archived_at=is.null` +
    `&limit=2000`,
    { method: 'GET' }
  );
  if (!sel.ok || !Array.isArray(sel.data)) return { ok: false, rows: [], error: sel.error };
  return { ok: true, rows: sel.data };
}

function isStalled(lastActivityIso) {
  if (!lastActivityIso) return false;
  const ts = Date.parse(lastActivityIso);
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) > STALL_DAYS * 86400 * 1000;
}

async function upsertBuild(row) {
  // Build payload. Tag stalled into description JSON suffix.
  const stalledFlag = isStalled(row.last_activity);
  const description = stalledFlag
    ? `${row.description || ''}\n\n[stalled:true since ${row.last_activity}]`
    : (row.description || null);

  const payload = {
    tenant_id: HEATH_TENANT_ID,
    title: row.title.slice(0, 280),
    description,
    source: row.source,
    source_key: row.source_key,
    status: row.status,
    source_doc_path: row.source_doc_path || null,
    score: row.score || null,
    updated_at: new Date().toISOString(),
    archived_at: null,
  };
  const res = await sb(
    `/rest/v1/jarvis_future_builds?on_conflict=tenant_id,source_key`,
    {
      method: 'POST',
      headers: {
        'Prefer': 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    }
  );
  return res;
}

async function archiveBuild(id) {
  const payload = { archived_at: new Date().toISOString(), status: 'shipped', updated_at: new Date().toISOString() };
  const res = await sb(
    `/rest/v1/jarvis_future_builds?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify(payload),
    }
  );
  return res;
}

// ─── Main handler ────────────────────────────────────────────────────────────

async function reconcile() {
  const errors = [];
  const counts = { inserted_or_updated: 0, archived: 0, sources: {} };

  // Collect from every source. Each source is fail-soft.
  const collected = [];

  for (const [name, fn] of [
    ['github',       collectGithubBranches],
    ['github-pr',    collectGithubPRs],
    ['memory',       collectMemoryHandoffs],
    ['dod',          collectDoDDrafts],
    ['heath-queue',  collectHeathTodo],
  ]) {
    try {
      const rows = await fn();
      counts.sources[name] = rows.length;
      collected.push(...rows);
    } catch (err) {
      counts.sources[name] = 'error';
      errors.push(`${name}: ${err && err.message || err}`);
    }
  }

  // Dedupe by source_key (last wins). Shouldn't happen across sources but safe.
  const dedup = new Map();
  for (const r of collected) dedup.set(r.source_key, r);
  const finalRows = Array.from(dedup.values());

  // UPSERT each
  for (const row of finalRows) {
    const res = await upsertBuild(row);
    if (res.ok) counts.inserted_or_updated += 1;
    else errors.push(`upsert ${row.source_key}: ${res.error || res.status}`);
  }

  // Compute archive candidates: existing reconciled rows (non-manual prefix)
  // whose source_key didn't appear in finalRows this run.
  const existing = await fetchExistingReconciledRows();
  if (existing.ok) {
    const presentKeys = new Set(finalRows.map(r => r.source_key));
    for (const ex of existing.rows) {
      if (!ex.source_key) continue;
      if (ex.source_key.startsWith('manual:')) continue;     // hand-seeded — leave alone
      if (presentKeys.has(ex.source_key)) continue;          // still present in source
      // Drop-out → archive as shipped
      const ar = await archiveBuild(ex.id);
      if (ar.ok) counts.archived += 1;
      else errors.push(`archive ${ex.id}: ${ar.error || ar.status}`);
    }
  } else {
    errors.push(`fetch_existing: ${existing.error}`);
  }

  return { counts, errors };
}

async function handler(req, res) {
  // Auth gate: CRON_SECRET bearer OR Vercel cron header
  const auth = req.headers['authorization'] || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1' || !!req.headers['x-vercel-cron'];
  const bearerOk = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!bearerOk && !isVercelCron) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const result = await reconcile();
    const ok = result.errors.length === 0;
    return res.status(200).json({
      ok,
      ...result.counts,
      errors: result.errors.slice(0, 20),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[reconciler] fatal', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}

module.exports = withTelemetry('cron-reconcile-future-builds', handler);
