#!/usr/bin/env node
// scripts/spawn-jarvis-agent.js
// ============================================================================
// Orchestrator helper for Jarvis Agent Instance SOP (locked 2026-06-22).
//
// Any orchestrator (Cole on Telegram, Jarvis-PWA, a cron) calls this to spawn
// a new agent instance with a pre-loaded checklist. Wraps POST to
// /api/jarvis-spawn-agent-instance with auth.
//
// USAGE — programmatic (require):
//   const { spawnInstance } = require('./scripts/spawn-jarvis-agent.js');
//   const out = await spawnInstance({
//     agentRole: 'atlas',
//     projectTitle: 'Jarvis Agent Instance Infra',
//     projectDescription: 'Build the cloning SOP.',
//     spawnPrompt: 'Atlas, build the schema + APIs + UI.',
//     checklistItems: [{ title: 'schema migration' }, { title: 'apis' }, ...],
//     accessToken: process.env.JARVIS_USER_JWT,    // Supabase JWT for caller
//     baseUrl: 'https://meetdossie.com',           // optional
//   });
//   console.log(out.instance.instance_id);  // e.g., "atlas_4"
//
// USAGE — CLI (env-driven):
//   JARVIS_USER_JWT=xxx \
//   node scripts/spawn-jarvis-agent.js \
//     --role atlas \
//     --project "Jarvis Agent Instance Infra" \
//     --prompt "Atlas, build the schema + APIs + UI." \
//     --checklist "schema migration|apis|ui|apv"
//
// AUTH NOTES:
// - Pass a valid Supabase user JWT in `accessToken` (or env JARVIS_USER_JWT).
// - Recommended: orchestrator runs locally with .env.local that has
//   JARVIS_USER_JWT set to Heath's current session token, or uses the
//   service-role variant (TODO future) for server-to-server spawn.
// ============================================================================

const DEFAULT_BASE_URL =
  process.env.JARVIS_BASE_URL ||
  process.env.VERCEL_URL ||
  'https://meetdossie.com';

const VALID_AGENT_ROLES = new Set([
  'atlas', 'carter', 'hadley', 'pierce', 'sage',
  'ridge', 'quinn', 'sterling', 'jarvis',
]);

// Load prior learnings for this role + context BEFORE spawning so they can
// be prepended to the spawn prompt the new instance reads.
//
// Returns: { block: string, lessons: array }
// On failure: { block: '', lessons: [] } (non-fatal — spawn still happens).
async function loadPriorLearnings({ agentRole, context, baseUrl, accessToken, limit = 20 }) {
  if (!agentRole || !context) return { block: '', lessons: [] };
  try {
    const url = new URL(`${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/api/agent-memory-load`);
    url.searchParams.set('role', agentRole);
    url.searchParams.set('context', context.slice(0, 4000));
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('format', 'system_prompt');
    url.searchParams.set('bump_usage', '1');
    const headers = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      console.warn(`[spawn] loadPriorLearnings non-fatal: ${res.status}`);
      return { block: '', lessons: [] };
    }
    const block = await res.text();
    return { block: block || '', lessons: [] };
  } catch (err) {
    console.warn('[spawn] loadPriorLearnings error (non-fatal):', err.message);
    return { block: '', lessons: [] };
  }
}

async function spawnInstance({
  agentRole,
  projectId,
  projectTitle,
  projectDescription,
  spawnPrompt,
  checklistItems,
  accessToken,
  baseUrl,
  injectPriorLearnings = true,
  priorLearningsLimit = 20,
} = {}) {
  if (!agentRole || !VALID_AGENT_ROLES.has(agentRole)) {
    throw new Error(`spawnInstance: invalid agentRole "${agentRole}"`);
  }
  const token = accessToken || process.env.JARVIS_USER_JWT;
  if (!token) {
    throw new Error('spawnInstance: missing accessToken (or JARVIS_USER_JWT env)');
  }
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/api/jarvis-spawn-agent-instance`;

  // Pre-flight: load relevant prior learnings for this role and prepend them
  // to the spawn prompt so the new instance reads them in turn 1.
  let learningsBlock = '';
  if (injectPriorLearnings) {
    const ctxBits = [
      agentRole && `Agent role: ${agentRole}`,
      projectTitle && `Project: ${projectTitle}`,
      projectDescription && `Description: ${projectDescription}`,
      spawnPrompt && `Spawn prompt: ${spawnPrompt}`,
      Array.isArray(checklistItems) && checklistItems.length
        ? `Checklist: ${checklistItems.map(c => c.title).filter(Boolean).join('; ')}` : '',
    ].filter(Boolean).join('\n');
    const out = await loadPriorLearnings({
      agentRole, context: ctxBits, baseUrl, accessToken: token, limit: priorLearningsLimit,
    });
    learningsBlock = out.block || '';
  }

  const effectiveSpawnPrompt = learningsBlock
    ? `${learningsBlock}\n${spawnPrompt || ''}`.trim()
    : (spawnPrompt || undefined);

  const body = {
    agent_role: agentRole,
    project_id: projectId || undefined,
    project_title: projectTitle || undefined,
    project_description: projectDescription || undefined,
    spawn_prompt: effectiveSpawnPrompt || undefined,
    checklist_items: Array.isArray(checklistItems) ? checklistItems : undefined,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`spawnInstance: ${res.status} ${json.error || text.slice(0, 200)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  // Attach learnings metadata for caller visibility
  if (json && typeof json === 'object') {
    json.injected_prior_learnings = !!learningsBlock;
    json.prior_learnings_chars = learningsBlock ? learningsBlock.length : 0;
  }
  return json;
}

async function updateChecklistItem({
  itemId, status, evidenceFiles, commitSha, screenshotPaths, apvStatus,
  failureReason, notes, accessToken, baseUrl,
} = {}) {
  if (!itemId) throw new Error('updateChecklistItem: itemId required');
  const token = accessToken || process.env.JARVIS_USER_JWT;
  if (!token) throw new Error('updateChecklistItem: missing accessToken');
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/api/jarvis-update-checklist-item`;
  const body = {
    item_id: itemId,
    status,
    evidence_files: evidenceFiles,
    commit_sha: commitSha,
    screenshot_paths: screenshotPaths,
    apv_status: apvStatus,
    failure_reason: failureReason,
    notes,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`updateChecklistItem: ${res.status} ${json.error || ''}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

async function completeInstance({
  instanceId, finalStatus, evidenceSummary, goldTag, markProjectShipped,
  accessToken, baseUrl,
} = {}) {
  if (!instanceId) throw new Error('completeInstance: instanceId required');
  if (!finalStatus) throw new Error('completeInstance: finalStatus required');
  const token = accessToken || process.env.JARVIS_USER_JWT;
  if (!token) throw new Error('completeInstance: missing accessToken');
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/api/jarvis-complete-instance`;
  const body = {
    instance_id: instanceId,
    final_status: finalStatus,
    evidence_summary: evidenceSummary,
    gold_tag: goldTag,
    mark_project_shipped: !!markProjectShipped,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`completeInstance: ${res.status} ${json.error || ''}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

// CLI entry point (lightweight, no yargs dependency)
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv);
    if (!args.role) {
      console.error('Missing --role. Example: --role atlas');
      process.exit(2);
    }
    const checklistRaw = args.checklist ? String(args.checklist) : '';
    const checklistItems = checklistRaw
      ? checklistRaw.split('|').map(s => s.trim()).filter(Boolean).map(t => ({ title: t }))
      : [];
    try {
      const out = await spawnInstance({
        agentRole: args.role,
        projectId: args['project-id'],
        projectTitle: args.project,
        projectDescription: args.description,
        spawnPrompt: args.prompt,
        checklistItems,
        baseUrl: args['base-url'] || undefined,
      });
      console.log(JSON.stringify(out, null, 2));
    } catch (err) {
      console.error('spawn failed:', err.message);
      if (err.body) console.error(JSON.stringify(err.body, null, 2));
      process.exit(1);
    }
  })();
}

module.exports = { spawnInstance, updateChecklistItem, completeInstance, loadPriorLearnings };
