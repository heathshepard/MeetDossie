'use strict';

// api/cole-enqueue.js
// =============================================================================
// Cole/Jarvis async-work enqueue endpoint. Replaces direct Agent-tool spawning
// for any task that is not gating the very next Telegram reply.
//
// POST /api/cole-enqueue
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body:
//   {
//     target_agent: "carter" | "atlas" | "hadley" | "pierce" | "sage"
//                 | "quinn" | "ridge" | "sterling",
//     title: string (max 280 chars),
//     description: string (the task brief; max 8000 chars),
//     priority: 1-5 (1 = highest; default 3),
//     depends_on: optional uuid[] (other agent_queue.id values),
//     venture: optional string (default 'general'),
//     source: optional string (free-text, e.g. 'cole-chat', 'dod', 'memo'),
//     create_future_build: optional boolean (default true) — also create a
//                          jarvis_future_builds row so the HUD shows it.
//   }
//
// Response:
//   { ok: true, queue_id, future_build_id?, target_agent }
//
// OWNER: Atlas, 2026-06-25 (SV-ENG-AGENT-QUEUE-PRODUCER).

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const HEATH_TENANT_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';

const VALID_AGENTS = new Set([
  'carter', 'atlas', 'hadley', 'pierce', 'sage', 'quinn', 'ridge', 'sterling',
]);

// Pre-flight dup-build rejection patterns (atlas 2026-06-27 codebase-facts
// indexer). Each pattern matches obvious "build a thing that already exists"
// requests against the codebase_facts catalog. Conservative — only reject
// when the title clearly says "build X" AND the corresponding fact_key
// exists=true. Anything ambiguous goes through.
//
// Format: { fact_keys: [...], build_patterns: [/regex/], display_name: '...' }
const DUP_BUILD_PATTERNS = [
  {
    fact_keys: ['privacy-policy-page'],
    build_patterns: [
      /\bbuild\b.*\bprivacy\b/i,
      /\bcreate\b.*\bprivacy policy\b/i,
      /\bdraft\b.*\bprivacy policy\b/i,
      /\bwrite\b.*\bprivacy policy\b/i,
      /no privacy policy/i,
      /privacy policy.*does(?:n't|n.t| not) exist/i,
    ],
    display_name: 'Privacy Policy',
  },
  {
    fact_keys: ['terms-of-service-page'],
    build_patterns: [
      /\bbuild\b.*\bterms\b/i,
      /\bcreate\b.*\bterms of service\b/i,
      /\bdraft\b.*\bterms of service\b/i,
      /\bwrite\b.*\bterms\b.*\bservice\b/i,
      /no terms of service/i,
      /no.*ToS/,
      /terms.*does(?:n't|n.t| not) exist/i,
    ],
    display_name: 'Terms of Service',
  },
  {
    fact_keys: ['calculator-page'],
    build_patterns: [
      /\bbuild\b.*\bTREC calculator\b/i,
      /\bcreate\b.*\bTREC calculator\b/i,
    ],
    display_name: 'TREC Calculator page',
  },
  {
    fact_keys: ['founding-page'],
    build_patterns: [
      /\bbuild\b.*\bfounding (?:member )?page\b/i,
      /\bcreate\b.*\bfounding (?:member )?page\b/i,
    ],
    display_name: 'Founding member page',
  },
  {
    fact_keys: ['feature:codebase-facts-indexer'],
    build_patterns: [
      /\bbuild\b.*\bcodebase facts indexer\b/i,
      /\bcreate\b.*\bcodebase facts indexer\b/i,
    ],
    display_name: 'Codebase facts indexer',
  },
];

async function preflightCheckDupBuild(title, description) {
  const haystack = `${title}\n${description}`;

  for (const pattern of DUP_BUILD_PATTERNS) {
    const matches = pattern.build_patterns.some((re) => re.test(haystack));
    if (!matches) continue;

    // Check each fact_key — if any says exists=true and is_active, reject.
    const keysParam = pattern.fact_keys.map((k) => `"${k}"`).join(',');
    const r = await sb(
      `codebase_facts?select=fact_key,fact_value&tenant_id=eq.${HEATH_TENANT_ID}` +
      `&is_active=eq.true&fact_key=in.(${keysParam})`
    );
    if (!r.ok || !Array.isArray(r.data)) continue;

    const existing = r.data.filter((row) => row.fact_value && row.fact_value.exists === true);
    if (existing.length > 0) {
      const where = existing[0].fact_value.path || existing[0].fact_value.route || existing[0].fact_value.location || 'in the repo';
      return {
        block: true,
        reason: 'duplicate_build_rejected',
        display_name: pattern.display_name,
        location: where,
        message: `${pattern.display_name} already exists at ${where}. Not enqueueing a build task. If you want to update it, set source='update' in the task body or describe the specific change needed.`,
      };
    }
  }

  return { block: false };
}

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  const targetAgent = String(body.target_agent || '').toLowerCase().trim();
  const title       = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const priority    = Number.isFinite(body.priority) ? Math.max(1, Math.min(5, Math.floor(body.priority))) : 3;
  const dependsOn   = Array.isArray(body.depends_on) ? body.depends_on.filter(x => typeof x === 'string') : [];
  const venture     = (body.venture && String(body.venture).trim()) || 'general';
  const source      = (body.source && String(body.source).trim()) || 'cole-enqueue';
  const createFutureBuild = body.create_future_build === false ? false : true;

  if (!VALID_AGENTS.has(targetAgent)) {
    return res.status(400).json({ ok: false, error: `invalid_target_agent:${targetAgent}` });
  }
  if (!title) {
    return res.status(400).json({ ok: false, error: 'title_required' });
  }
  if (!description) {
    return res.status(400).json({ ok: false, error: 'description_required' });
  }

  // 0. Pre-flight: codebase_facts dup-build check (atlas 2026-06-27).
  //    Skip if the source explicitly opts in to update mode.
  if (body.skip_dup_check !== true && source !== 'update') {
    try {
      const preflight = await preflightCheckDupBuild(title, description);
      if (preflight.block) {
        return res.status(409).json({
          ok: false,
          error: preflight.reason,
          display_name: preflight.display_name,
          location: preflight.location,
          message: preflight.message,
          hint: 'If you want to update an existing thing, set source="update" in the body or pass skip_dup_check=true.',
        });
      }
    } catch (e) {
      // Soft-fail: if codebase_facts table is unavailable, proceed with the
      // enqueue. The indexer might not have run yet.
      console.warn('[cole-enqueue] preflight check failed (non-fatal):', e.message);
    }
  }

  // 1. Optionally create the jarvis_future_builds row first so the queue row
  //    can reference its id. Idempotent via source_key UNIQUE constraint
  //    (tenant_id, source_key).
  let futureBuildId = null;
  if (createFutureBuild) {
    const sourceKey = `manual:cole-enqueue:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fbPayload = {
      tenant_id: HEATH_TENANT_ID,
      title: title.slice(0, 280),
      description: description.slice(0, 8000),
      source,
      source_key: sourceKey,
      status: 'building',
      score: priority ? (6 - priority) * 20 : null,
      updated_at: new Date().toISOString(),
    };
    const fb = await sb('jarvis_future_builds', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(fbPayload),
    });
    if (fb.ok && Array.isArray(fb.data) && fb.data[0]) {
      futureBuildId = fb.data[0].id;
    } else {
      // Soft-fail: still proceed with queue insert.
      console.warn('[cole-enqueue] future_build insert failed', fb.status, JSON.stringify(fb.data).slice(0, 200));
    }
  }

  // 2. Insert the agent_queue row.
  const queuePayload = {
    agent_name: targetAgent,
    task_subject: title.slice(0, 280),
    task_brief: description.slice(0, 8000),
    priority,
    depends_on: dependsOn,
    venture,
    status: 'pending',
    metadata: {
      source,
      source_table: futureBuildId ? 'jarvis_future_builds' : null,
      source_id: futureBuildId,
      source_key: futureBuildId ? `jarvis_future_builds:${futureBuildId}` : `cole-enqueue:${Date.now()}`,
      enqueued_at: new Date().toISOString(),
      enqueued_by: 'cole',
    },
  };
  const ins = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(queuePayload),
  });
  if (!ins.ok || !Array.isArray(ins.data) || !ins.data[0]) {
    return res.status(500).json({
      ok: false,
      error: `queue_insert_failed:${ins.status}`,
      detail: ins.data,
    });
  }

  return res.status(200).json({
    ok: true,
    queue_id: ins.data[0].id,
    future_build_id: futureBuildId,
    target_agent: targetAgent,
    priority,
    depends_on: dependsOn,
  });
};
