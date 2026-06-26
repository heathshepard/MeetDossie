'use strict';

// api/cron-fanout-builds-to-agent-queues.js
// =============================================================================
// THE PRODUCER. Fans out jarvis_future_builds (status=building, not archived)
// into the per-agent agent_queue so agents never sit idle.
//
// MAPPING RULES (in order; first match wins)
//   1. description / title keywords → agent
//      - memo / legal / ToS / DoD / compliance / privacy / disclosure   → hadley
//      - cron / migration / infra / deploy / vercel / supabase / queue / observability / metric → atlas
//      - UI / React / Dossie product / workspace / button / modal / app.html / workspace.html / form / signature → carter
//      - marketing / outreach / drip / activation / customer success / onboarding / refer → pierce
//      - social / video / Zernio / Submagic / Creatomate / TikTok / FB group / IG / persona → sage
//      - QA / Playwright / staging-verify / test / APV                  → quinn
//      - reliability / KPI drift / alert / SLO / cron health            → ridge
//      - stocks / crypto / portfolio / robinhood / equity / option       → sterling
//   2. unmatched → atlas (default + flag in metadata.ambiguous=true so Cole reviews)
//
// IDEMPOTENCY
//   Dedupe key = source_table + ':' + source_id (lives in metadata.source_key).
//   Existing row with same key → skip insert (no update — once dispatched, the
//   agent_queue row owns the lifecycle).
//
// DEPENDENCY CHAINS (multi-agent DoD)
//   If the description has a "## Handoff chain" block of the form:
//       Hadley → Atlas → Carter
//   we create N rows with depends_on wiring. Hadley row has no deps; Atlas row
//   depends on Hadley row id; Carter row depends on Atlas row id.
//
// AUTH
//   Bearer ${CRON_SECRET} OR x-vercel-cron header.
//
// SCHEDULE
//   Every 6h at minute 10 (10 min after the reconciler's :00 run) so the
//   reconciler's writes are flushed before we fan out.
//
// OWNER
//   Atlas, 2026-06-25 (SV-ENG-AGENT-QUEUE-PRODUCER).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const VALID_AGENTS = new Set([
  'carter', 'atlas', 'hadley', 'pierce', 'sage', 'quinn', 'ridge', 'sterling',
]);

// Keyword → agent. Order matters: most specific first.
const KEYWORD_RULES = [
  // hadley — legal / DoD
  { agent: 'hadley',   pattern: /\b(memo|legal|tos|terms[- ]of[- ]service|compliance|privacy[- ]policy|gdpr|ccpa|trec[- ]disclosure|esign[- ]act|ueta|llc|dod|definition[- ]of[- ]done|hadley)\b/i },
  // atlas — infra / platform
  { agent: 'atlas',    pattern: /\b(cron|migration|infra|infrastructure|deploy|vercel|supabase|edge function|observability|env var|env keys|backup|dns|build pipeline|service role|agent queue|orchestration|telemetry|atlas)\b/i },
  // quinn — QA
  { agent: 'quinn',    pattern: /\b(qa|playwright|staging[- ]verify|smoke test|regression|test suite|apv|verify[- ]rerun|quinn)\b/i },
  // ridge — reliability
  { agent: 'ridge',    pattern: /\b(reliability|kpi drift|slo|sli|error budget|on[- ]call|alert(?:ing)?|dead cron|cron health|incident review|ridge)\b/i },
  // sage — social/video
  { agent: 'sage',     pattern: /\b(social|zernio|submagic|creatomate|tiktok|instagram|fb group|facebook group|persona|reel|video render|content calendar|posting schedule|hook|caption|sage)\b/i },
  // pierce — growth/CS
  { agent: 'pierce',   pattern: /\b(marketing|outreach|drip|activation|customer success|onboarding|refer|reactivation|cold email|founder reactivation|pierce)\b/i },
  // sterling — markets
  { agent: 'sterling', pattern: /\b(stock|crypto|portfolio|robinhood|equity|option|earnings|fda date|token unlock|backtest|sterling)\b/i },
  // carter — product code (broadest; last among matched)
  { agent: 'carter',   pattern: /\b(react|ui|workspace|app\.html|workspace\.html|button|modal|form fill|signature|trec[- ]form|dossie product|component|frontend|jsx|tsx|carter)\b/i },
];

function classify(title, description) {
  const blob = `${title || ''}\n${description || ''}`;
  const matches = [];
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(blob)) matches.push(rule.agent);
  }
  if (matches.length === 0) return { agent: 'atlas', ambiguous: true, matches: [] };
  if (matches.length === 1) return { agent: matches[0], ambiguous: false, matches };
  // Multi-match — pick the first (KEYWORD_RULES is ordered by specificity);
  // mark ambiguous so Cole can re-route if needed.
  return { agent: matches[0], ambiguous: true, matches };
}

// ─── Handoff chain parser ─────────────────────────────────────────────────────
//
// Looks for `Handoff chain:` or `Chain:` followed by an arrow-delimited list:
//   Handoff chain: Hadley → Atlas → Carter
//   chain: hadley -> atlas -> carter

function parseHandoffChain(description) {
  if (!description) return null;
  const m = description.match(/(?:handoff\s+chain|chain)\s*:\s*([A-Za-z →>\-]+)/i);
  if (!m) return null;
  const raw = m[1];
  const parts = raw.split(/\s*(?:→|->|>)\s*/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const chain = parts.filter(a => VALID_AGENTS.has(a));
  if (chain.length < 2) return null;
  return chain;
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

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

// ─── Existing-dedupe lookup ───────────────────────────────────────────────────

async function fetchExistingFanoutKeys() {
  // We dedupe across ALL agent_queue rows (any status) that carry a
  // metadata.source_key — so if a row already shipped, we don't re-fanout it.
  // The metadata->>source_key JSONB lookup uses the GIN index if present;
  // even without, this scans ~hundreds of rows which is fine.
  const { ok, data } = await sb(
    `agent_queue?select=id,agent_name,metadata,status&metadata=not.is.null&limit=5000`,
  );
  if (!ok || !Array.isArray(data)) return new Set();
  const keys = new Set();
  for (const r of data) {
    const sk = r.metadata && r.metadata.source_key;
    if (sk) keys.add(`${r.agent_name}:${sk}`);
  }
  return keys;
}

// ─── Insert helpers ───────────────────────────────────────────────────────────

async function insertQueueRow(payload) {
  return sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(payload),
  });
}

function buildPayload({ agent, title, brief, priority, venture, sourceTable, sourceId, sourceKey, ambiguous, dependsOn }) {
  const meta = {
    source_table: sourceTable,
    source_id: sourceId,
    source_key: sourceKey,
    fanout_at: new Date().toISOString(),
  };
  if (ambiguous) meta.ambiguous = true;
  return {
    agent_name: agent,
    task_subject: (title || '(no subject)').slice(0, 280),
    task_brief: (brief || '(no brief)').slice(0, 8000),
    priority: typeof priority === 'number' ? priority : 3,
    venture: venture || 'general',
    status: 'pending',
    depends_on: Array.isArray(dependsOn) && dependsOn.length ? dependsOn : [],
    metadata: meta,
  };
}

// ─── Main fanout ──────────────────────────────────────────────────────────────

async function fanout() {
  const stats = {
    source_rows: 0,
    fanned_out: 0,
    chained_rows: 0,
    skipped_duplicates: 0,
    ambiguous: 0,
    by_agent: {},
    errors: [],
  };

  // 1. Pull source rows.
  const sel = await sb(
    `jarvis_future_builds?status=eq.building&archived_at=is.null` +
    `&select=id,title,description,score,source,source_key&limit=500`,
  );
  if (!sel.ok || !Array.isArray(sel.data)) {
    return { ...stats, errors: [`source_fetch_failed:${sel.status}`] };
  }
  stats.source_rows = sel.data.length;

  // 2. Build dedupe set.
  const existing = await fetchExistingFanoutKeys();

  // 3. Iterate.
  for (const build of sel.data) {
    const sourceKey = `jarvis_future_builds:${build.id}`;
    const priority = build.score && build.score > 0 ? Math.max(1, Math.min(5, 6 - Math.ceil(build.score / 20))) : 3;
    // ^ score 1-100 → priority 1 (highest) for high scores, 5 for low. Cole-enqueue
    //   sets explicit priority; the fanout uses score as a fallback.

    // Detect explicit handoff chain.
    const chain = parseHandoffChain(build.description);

    if (chain) {
      // Multi-agent chain. Insert rows with sequential depends_on.
      let lastId = null;
      let chainSkippedAny = false;
      const chainAgents = [];
      for (let i = 0; i < chain.length; i++) {
        const agent = chain[i];
        const dedupKey = `${agent}:${sourceKey}`;
        if (existing.has(dedupKey)) {
          stats.skipped_duplicates += 1;
          chainSkippedAny = true;
          continue;
        }
        const payload = buildPayload({
          agent,
          title: `[${i + 1}/${chain.length}] ${build.title}`,
          brief: build.description,
          priority,
          venture: 'general',
          sourceTable: 'jarvis_future_builds',
          sourceId: build.id,
          sourceKey,
          ambiguous: false,
          dependsOn: lastId ? [lastId] : [],
        });
        const ins = await insertQueueRow(payload);
        if (ins.ok && Array.isArray(ins.data) && ins.data[0]) {
          const newId = ins.data[0].id;
          existing.add(dedupKey);
          stats.fanned_out += 1;
          stats.chained_rows += 1;
          stats.by_agent[agent] = (stats.by_agent[agent] || 0) + 1;
          chainAgents.push(agent);
          lastId = newId;
        } else {
          stats.errors.push(`chain_insert_failed ${sourceKey} ${agent}: ${ins.status}`);
        }
      }
      continue;
    }

    // Single-agent classification.
    const cls = classify(build.title, build.description);
    const dedupKey = `${cls.agent}:${sourceKey}`;
    if (existing.has(dedupKey)) {
      stats.skipped_duplicates += 1;
      continue;
    }
    if (cls.ambiguous) stats.ambiguous += 1;

    const payload = buildPayload({
      agent: cls.agent,
      title: build.title,
      brief: build.description,
      priority,
      venture: 'general',
      sourceTable: 'jarvis_future_builds',
      sourceId: build.id,
      sourceKey,
      ambiguous: cls.ambiguous,
      dependsOn: [],
    });

    const ins = await insertQueueRow(payload);
    if (ins.ok) {
      existing.add(dedupKey);
      stats.fanned_out += 1;
      stats.by_agent[cls.agent] = (stats.by_agent[cls.agent] || 0) + 1;
    } else {
      stats.errors.push(`insert_failed ${sourceKey}: ${ins.status}`);
    }
  }

  stats.errors = stats.errors.slice(0, 20);
  return stats;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isCronSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `missing_env:${missing.join(',')}` });
  }

  try {
    const stats = await fanout();
    return res.status(200).json({ ok: true, at: new Date().toISOString(), ...stats });
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.error('[cron-fanout-builds-to-agent-queues] fatal', msg);
    return res.status(500).json({ ok: false, error: msg.slice(0, 500) });
  }
}

module.exports = withTelemetry('cron-fanout-builds-to-agent-queues', handler);

// Exports for unit testing.
module.exports.classify = classify;
module.exports.parseHandoffChain = parseHandoffChain;
