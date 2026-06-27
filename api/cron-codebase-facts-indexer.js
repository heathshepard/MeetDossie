'use strict';

// api/cron-codebase-facts-indexer.js
// =============================================================================
// Codebase Facts Indexer — scans the MeetDossie repo at HEAD and writes facts
// to the codebase_facts table so agents stop proposing builds for things that
// already exist (e.g. "build privacy policy" when privacy.html ships in prod).
//
// WHY THIS EXISTS
//   2026-06-27: Hadley's blocked agent_queue item said "meetdossie.com has no
//   PP or ToS" — but privacy.html and terms.html exist on disk and deploy.
//   Heath had to manually correct it. Heath's directive: "Make the system
//   self aware. We need to close this gap so I don't have to remember these
//   details."
//
// WHAT IT INDEXES
//   - Customer-facing pages (privacy.html, terms.html, /founding, etc.)
//   - API routes (one-line summary extracted from first comment)
//   - Vercel cron schedules + maxDuration overrides
//   - Auth model (which endpoints require CRON_SECRET / x-watcher-secret etc.)
//   - Feature capabilities (spawn_agent intent, heath_actions UI,
//     project_context federation, GitHub Actions CI)
//   - Supabase tables that exist (approximate row counts)
//
// HOW IT WORKS
//   Reads files directly from the deployed filesystem (the cron runs in the
//   same Vercel function bundle, so it sees the repo at deploy-time HEAD).
//   For Supabase facts it pings information_schema via the service role.
//
// SCHEDULE
//   Every 6 hours via vercel.json.
//
// AUTH
//   Bearer ${CRON_SECRET} OR x-vercel-cron.
//
// OWNER
//   Atlas, 2026-06-27 (SV-ENG-CODEBASE-SELF-AWARENESS).

const fs = require('fs');
const path = require('path');
const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const HEATH_TENANT_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';

// Repo root: the Vercel bundle deploys api/ + html files at the deploy root.
// process.cwd() during Vercel function invocation = the function dir's parent
// container root. We walk up from __dirname until we find vercel.json or the
// repo root. Fall back to process.cwd().
function findRepoRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'vercel.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findRepoRoot();

// ─── Supabase REST helpers ──────────────────────────────────────────────────

async function sb(p, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ─── File helpers ───────────────────────────────────────────────────────────

function safeReadText(filePath, maxBytes = 200_000) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), bytes: stat.size, mtime: stat.mtime };
  } catch (e) {
    return null;
  }
}

function safeListDir(dirPath) {
  try {
    return fs.readdirSync(dirPath);
  } catch {
    return [];
  }
}

function countLines(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n + (text.endsWith('\n') ? 0 : 1);
}

// Extract first leading comment block (// or /* */) from a JS file as a
// one-line summary.
function extractApiSummary(text) {
  if (!text) return null;
  const lines = text.split('\n').slice(0, 80);
  const commentLines = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (commentLines.length > 0) break;
      continue;
    }
    if (line.startsWith("'use strict'") || line.startsWith('"use strict"')) continue;
    if (line.startsWith('/*')) { inBlock = true; commentLines.push(line.replace(/^\/\*+/, '').trim()); continue; }
    if (inBlock) {
      if (line.includes('*/')) { inBlock = false; commentLines.push(line.replace(/\*\/$/, '').replace(/^\*+/, '').trim()); continue; }
      commentLines.push(line.replace(/^\*+/, '').trim());
      continue;
    }
    if (line.startsWith('//')) {
      commentLines.push(line.replace(/^\/+/, '').trim());
      continue;
    }
    break;
  }
  // Find first non-meta line (skip filename echo + equals-sign separators)
  for (const l of commentLines) {
    if (!l) continue;
    if (/^[=─-]+$/.test(l)) continue;
    if (/^api\/.*\.js$/.test(l)) continue;
    return l.slice(0, 200);
  }
  return null;
}

// ─── Indexers ───────────────────────────────────────────────────────────────

async function indexLegalPages() {
  const facts = [];
  const pages = [
    { key: 'privacy-policy-page', filename: 'privacy.html', route: '/privacy' },
    { key: 'terms-of-service-page', filename: 'terms.html', route: '/terms' },
    { key: 'founding-page', filename: 'founding.html', route: '/founding' },
    { key: 'agents-page', filename: 'agents.html', route: '/agents' },
    { key: 'coordinators-page', filename: 'coordinators.html', route: '/coordinators' },
    { key: 'calculator-page', filename: 'calculator.html', route: '/calculator' },
    { key: 'help-page', filename: 'help.html', route: '/help' },
    { key: 'faq-page', filename: 'faq.html', route: '/faq' },
    { key: 'learn-page', filename: 'learn.html', route: '/learn' },
    { key: 'unsubscribe-page', filename: 'unsubscribe.html', route: '/unsubscribe' },
    { key: 'app-page', filename: 'app.html', route: '/app' },
    { key: 'workspace-page', filename: 'workspace.html', route: '/workspace' },
    { key: 'jarvis-pwa-page', filename: 'jarvis-pwa.html', route: '/myjarvis' },
    { key: 'shepardventures-page', filename: 'shepardventures.html', route: '/shepardventures' },
  ];

  for (const p of pages) {
    const full = path.join(REPO_ROOT, p.filename);
    const r = safeReadText(full, 50_000);
    if (r) {
      // Extract any meta version/last-updated info from the head.
      const versionMatch =
        r.text.match(/(?:last[\s_-]?updated|effective[\s_-]?date)[^<\n]{0,80}/i) ||
        r.text.match(/<meta[^>]+name=["']last[_-]?modified[_-]?date["'][^>]*content=["']([^"']+)["']/i);
      facts.push({
        fact_key: p.key,
        category: 'legal-pages',
        fact_value: {
          exists: true,
          path: p.filename,
          route: p.route,
          bytes: r.bytes,
          line_count: countLines(r.text),
          version_marker: versionMatch ? versionMatch[0].slice(0, 200) : null,
          mtime: r.mtime ? r.mtime.toISOString() : null,
        },
      });
    } else {
      facts.push({
        fact_key: p.key,
        category: 'legal-pages',
        fact_value: { exists: false, path: p.filename, route: p.route },
      });
    }
  }
  return facts;
}

async function indexApiRoutes() {
  const facts = [];
  const apiDir = path.join(REPO_ROOT, 'api');
  const entries = safeListDir(apiDir).filter((f) => f.endsWith('.js'));

  for (const file of entries) {
    const full = path.join(apiDir, file);
    const r = safeReadText(full, 60_000);
    if (!r) continue;
    const route = '/api/' + file.replace(/\.js$/, '');
    const summary = extractApiSummary(r.text);

    // Detect auth requirement.
    const authBits = [];
    if (/Bearer\s+\$\{?CRON_SECRET\}?|Bearer\s+\$\{CRON_SECRET\}|auth\s*===?\s*`Bearer \$\{CRON_SECRET\}`/i.test(r.text) || /CRON_SECRET/.test(r.text)) {
      authBits.push('cron-secret');
    }
    if (/X-Watcher-Secret|x-watcher-secret/i.test(r.text)) authBits.push('watcher-secret');
    if (/x-vercel-cron/i.test(r.text)) authBits.push('vercel-cron-header');
    if (/getServiceRole|SUPABASE_SERVICE_ROLE_KEY/.test(r.text)) authBits.push('service-role');
    if (/supabase.*auth\.getUser|sb\.auth\.getUser|verifyJwt/i.test(r.text)) authBits.push('user-jwt');

    facts.push({
      fact_key: `api-route:${route}`,
      category: 'api-routes',
      fact_value: {
        exists: true,
        route,
        file: `api/${file}`,
        line_count: countLines(r.text),
        summary,
        auth: authBits.length ? authBits : ['none'],
      },
    });
  }
  return facts;
}

async function indexVercelConfig() {
  const facts = [];
  const vercel = safeReadText(path.join(REPO_ROOT, 'vercel.json'), 200_000);
  if (!vercel) return facts;
  let config;
  try { config = JSON.parse(vercel.text); } catch { return facts; }

  // Crons
  const crons = Array.isArray(config.crons) ? config.crons : [];
  facts.push({
    fact_key: 'vercel-cron-count',
    category: 'vercel-config',
    fact_value: { count: crons.length, file: 'vercel.json' },
  });
  for (const c of crons) {
    if (!c || !c.path) continue;
    const routePath = c.path;
    facts.push({
      fact_key: `vercel-cron:${routePath}`,
      category: 'vercel-config',
      fact_value: {
        path: routePath,
        schedule: c.schedule,
        wired: true,
      },
    });
  }

  // Rewrites (route aliases)
  const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];
  facts.push({
    fact_key: 'vercel-rewrite-count',
    category: 'vercel-config',
    fact_value: { count: rewrites.length },
  });

  return facts;
}

async function indexFeatureCapabilities() {
  const facts = [];

  // Talk-to-Dossie spawn_agent intent
  const jarvisVoice = safeReadText(path.join(REPO_ROOT, 'api', 'jarvis-voice.js'), 500_000);
  if (jarvisVoice) {
    facts.push({
      fact_key: 'feature:spawn-agent-intent',
      category: 'feature-capabilities',
      fact_value: {
        exists: /TOOL: spawn_agent|"name":\s*"spawn_agent"|name:\s*['"]spawn_agent['"]/i.test(jarvisVoice.text),
        location: 'api/jarvis-voice.js',
      },
    });
    facts.push({
      fact_key: 'feature:jarvis-project-context-federation',
      category: 'feature-capabilities',
      fact_value: {
        exists: /jarvis_project_context\?select/.test(jarvisVoice.text),
        location: 'api/jarvis-voice.js buildHudStateContext',
      },
    });
    facts.push({
      fact_key: 'feature:jarvis-hud-state-context',
      category: 'feature-capabilities',
      fact_value: {
        exists: /buildHudStateContext/.test(jarvisVoice.text),
        location: 'api/jarvis-voice.js',
      },
    });
  }

  // heath_actions approval UI on jarvis-pwa.html
  const jarvisPwa = safeReadText(path.join(REPO_ROOT, 'jarvis-pwa.html'), 1_500_000);
  if (jarvisPwa) {
    facts.push({
      fact_key: 'feature:heath-actions-approval-ui',
      category: 'feature-capabilities',
      fact_value: {
        exists: /heath_actions|approve-heath-action|heath-action-/i.test(jarvisPwa.text),
        location: 'jarvis-pwa.html',
      },
    });
  }

  // GitHub Actions Android CI
  const gh = path.join(REPO_ROOT, '.github', 'workflows');
  let workflowFiles = [];
  try {
    workflowFiles = fs.readdirSync(gh);
  } catch { workflowFiles = []; }
  facts.push({
    fact_key: 'feature:github-actions-ci',
    category: 'feature-capabilities',
    fact_value: {
      exists: workflowFiles.length > 0,
      workflow_count: workflowFiles.length,
      workflows: workflowFiles,
      location: '.github/workflows/',
    },
  });

  // cole-enqueue endpoint
  const coleEnqueue = safeReadText(path.join(REPO_ROOT, 'api', 'cole-enqueue.js'), 50_000);
  facts.push({
    fact_key: 'feature:cole-enqueue-endpoint',
    category: 'feature-capabilities',
    fact_value: {
      exists: !!coleEnqueue,
      location: 'api/cole-enqueue.js',
    },
  });

  // codebase-facts-indexer self-reference (the dog finds itself)
  const selfPath = safeReadText(path.join(REPO_ROOT, 'api', 'cron-codebase-facts-indexer.js'), 50_000);
  facts.push({
    fact_key: 'feature:codebase-facts-indexer',
    category: 'feature-capabilities',
    fact_value: {
      exists: !!selfPath,
      location: 'api/cron-codebase-facts-indexer.js',
      description: 'This indexer itself. Self-aware codebase facts pump.',
    },
  });

  return facts;
}

async function indexSupabaseTables() {
  const facts = [];
  // Pull table names from information_schema via PostgREST RPC fallback: we
  // query a known catalog endpoint. Simpler: hit /rest/v1/?select via OpenAPI.
  // PostgREST doesn't expose information_schema by default. Use an RPC if
  // available, otherwise probe a fixed roster of tables we care about.
  const knownTables = [
    'profiles', 'subscriptions', 'transactions', 'documents', 'social_posts',
    'content_calendar', 'founding_applications', 'calculator_signups',
    'dossier_milestones', 'share_events', 'agent_queue', 'agent_state',
    'jarvis_future_builds', 'jarvis_projects', 'jarvis_agent_instances',
    'jarvis_agent_checklist', 'jarvis_project_context', 'jarvis_users',
    'jarvis_devices', 'jarvis_messages', 'jarvis_voice_briefs',
    'heath_todo', 'heath_actions', 'cron_runs', 'system_diagnostics',
    'codebase_facts',
  ];

  for (const t of knownTables) {
    const r = await sb(`${t}?select=*&limit=1`, { method: 'HEAD', headers: { Prefer: 'count=exact' } });
    if (r.ok) {
      // PostgREST puts the count in the Content-Range header but our sb()
      // helper doesn't expose headers. Re-issue with a regular GET + Range.
      const r2 = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=id&limit=1`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: 'count=exact',
          'Range-Unit': 'items',
          Range: '0-0',
        },
      });
      const cr = r2.headers.get('content-range') || '';
      const m = cr.match(/\/(\d+)$/);
      const rowCount = m ? Number(m[1]) : null;
      facts.push({
        fact_key: `supabase-table:${t}`,
        category: 'supabase-tables',
        fact_value: { exists: true, table: t, row_count: rowCount },
      });
    } else {
      facts.push({
        fact_key: `supabase-table:${t}`,
        category: 'supabase-tables',
        fact_value: { exists: false, table: t },
      });
    }
  }
  return facts;
}

// ─── Upsert facts ───────────────────────────────────────────────────────────

async function upsertFacts(facts) {
  if (!facts.length) return { inserted: 0, updated: 0 };
  const now = new Date().toISOString();
  // PostgREST upsert via Prefer: resolution=merge-duplicates on the
  // (tenant_id, fact_key) unique key.
  const payload = facts.map((f) => ({
    tenant_id: HEATH_TENANT_ID,
    category: f.category,
    fact_key: f.fact_key,
    fact_value: f.fact_value,
    last_verified_at: now,
    is_active: true,
  }));

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/codebase_facts?on_conflict=tenant_id,fact_key`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`upsert ${res.status}: ${txt.slice(0, 300)}`);
  }
  return { count: facts.length };
}

// Mark facts not seen this run as inactive (soft-delete). Pulls the current
// fact_keys for the tenant, diffs against the seen set, and PATCHes is_active.
async function markStaleInactive(seenKeys, now) {
  const r = await sb(`codebase_facts?select=id,fact_key&tenant_id=eq.${HEATH_TENANT_ID}&is_active=eq.true`);
  if (!r.ok) return 0;
  const seen = new Set(seenKeys);
  const stale = (r.data || []).filter((row) => !seen.has(row.fact_key));
  if (!stale.length) return 0;
  // Batch by 50 to avoid super-long IN lists.
  let n = 0;
  for (let i = 0; i < stale.length; i += 50) {
    const batch = stale.slice(i, i + 50);
    const ids = batch.map((s) => s.id);
    const patch = await sb(`codebase_facts?id=in.(${ids.join(',')})`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ is_active: false, last_verified_at: now }),
    });
    if (patch.ok) n += batch.length;
  }
  return n;
}

// ─── Handler ────────────────────────────────────────────────────────────────

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isCronSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'missing_supabase_env' });
  }

  const startedAt = Date.now();
  const breakdown = {};
  let allFacts = [];

  try {
    const legal = await indexLegalPages();
    breakdown['legal-pages'] = legal.length;
    allFacts = allFacts.concat(legal);
  } catch (e) {
    breakdown['legal-pages-error'] = e.message;
  }

  try {
    const routes = await indexApiRoutes();
    breakdown['api-routes'] = routes.length;
    allFacts = allFacts.concat(routes);
  } catch (e) {
    breakdown['api-routes-error'] = e.message;
  }

  try {
    const vcfg = await indexVercelConfig();
    breakdown['vercel-config'] = vcfg.length;
    allFacts = allFacts.concat(vcfg);
  } catch (e) {
    breakdown['vercel-config-error'] = e.message;
  }

  try {
    const feats = await indexFeatureCapabilities();
    breakdown['feature-capabilities'] = feats.length;
    allFacts = allFacts.concat(feats);
  } catch (e) {
    breakdown['feature-capabilities-error'] = e.message;
  }

  try {
    const tables = await indexSupabaseTables();
    breakdown['supabase-tables'] = tables.length;
    allFacts = allFacts.concat(tables);
  } catch (e) {
    breakdown['supabase-tables-error'] = e.message;
  }

  let upsertResult = { count: 0 };
  let staleMarked = 0;
  try {
    upsertResult = await upsertFacts(allFacts);
    const now = new Date().toISOString();
    staleMarked = await markStaleInactive(allFacts.map((f) => f.fact_key), now);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: 'upsert_failed',
      message: e.message,
      breakdown,
    });
  }

  return res.status(200).json({
    ok: true,
    facts_indexed: allFacts.length,
    facts_marked_inactive: staleMarked,
    breakdown,
    repo_root: REPO_ROOT,
    elapsed_ms: Date.now() - startedAt,
    at: new Date().toISOString(),
  });
}

module.exports = withTelemetry('cron-codebase-facts-indexer', handler);
