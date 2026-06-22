#!/usr/bin/env node
// scripts/learn-as-agent.js
// ============================================================================
// Tiny CLI + programmatic helper for an agent instance to deposit a lesson
// into the shared agent_role_memory pool.
//
// Usage — programmatic (require):
//   const { learn } = require('./scripts/learn-as-agent.js');
//   await learn({
//     role: 'atlas',
//     title: 'ElevenLabs quota 429 -> swap to scribe_v1 STT, not Whisper',
//     content: 'When ElevenLabs returns 429 on the chat or TTS endpoint, the STT endpoint usually still works because it has a separate sub-quota. Swap to ElevenLabs scribe_v1 STT and proxy through /api/jarvis-voice?op=stt; do NOT switch to OpenAI Whisper unless ElevenLabs is fully exhausted.',
//     category: 'api_gotcha',
//     instanceId: process.env.JARVIS_INSTANCE_ID || null,
//     tags: ['elevenlabs','429','stt'],
//     accessToken: process.env.JARVIS_USER_JWT,
//   });
//
// Usage — CLI:
//   JARVIS_USER_JWT=xxx \
//   node scripts/learn-as-agent.js \
//     --role atlas \
//     --title "ElevenLabs quota 429 -> swap to scribe_v1" \
//     --content "Long lesson body here..." \
//     --category api_gotcha \
//     --tags "elevenlabs,429,stt"
//
// Owner: atlas_2, 2026-06-22.
// ============================================================================

const DEFAULT_BASE_URL =
  process.env.JARVIS_BASE_URL ||
  process.env.VERCEL_URL ||
  'https://meetdossie.com';

const VALID_ROLES = new Set([
  'atlas','carter','hadley','pierce','sage','ridge','quinn','sterling','jarvis',
]);

const VALID_CATEGORIES = new Set([
  'api_gotcha','workflow','code_pattern','external_service_quirk',
  'heath_preference','customer_pattern','legal_nuance','security',
  'cost_optimization','voice_ux',
]);

async function learn({
  role,
  title,
  content,
  category = 'workflow',
  instanceId,
  tags,
  validationStatus,
  accessToken,
  baseUrl,
  tenantId,        // optional, only used for service-side seeding
} = {}) {
  if (!role || !VALID_ROLES.has(role)) throw new Error(`learn: invalid role "${role}"`);
  if (!title || title.length < 4) throw new Error('learn: title too short');
  if (!content || content.length < 20) throw new Error('learn: content too short');
  if (category && !VALID_CATEGORIES.has(category)) {
    throw new Error(`learn: invalid category "${category}"`);
  }

  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/api/agent-memory-learn`;
  const body = {
    role,
    title,
    content,
    category,
    instance_id: instanceId || undefined,
    tags: Array.isArray(tags) ? tags : undefined,
    validation_status: validationStatus || undefined,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (tenantId) headers['X-Jarvis-Tenant-Id'] = tenantId;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`learn: ${res.status} ${json.error || text.slice(0, 200)}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv);
    if (!args.role || !args.title || !args.content) {
      console.error('Required: --role <role> --title "..." --content "..." [--category ...] [--tags a,b,c]');
      process.exit(2);
    }
    try {
      const out = await learn({
        role: args.role,
        title: args.title,
        content: args.content,
        category: args.category || 'workflow',
        instanceId: args['instance-id'] || process.env.JARVIS_INSTANCE_ID || undefined,
        tags: args.tags ? String(args.tags).split(',').map(s => s.trim()).filter(Boolean) : undefined,
        accessToken: process.env.JARVIS_USER_JWT,
        baseUrl: args['base-url'],
        tenantId: process.env.JARVIS_TENANT_ID,
      });
      console.log(JSON.stringify(out, null, 2));
    } catch (err) {
      console.error('learn failed:', err.message);
      if (err.body) console.error(JSON.stringify(err.body, null, 2));
      process.exit(1);
    }
  })();
}

module.exports = { learn, VALID_ROLES, VALID_CATEGORIES };
