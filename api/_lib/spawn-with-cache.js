// api/_lib/spawn-with-cache.js
// ============================================================================
// Anthropic prompt-caching helper.
//
// Why: every agent spawn re-processes ~50k tokens of memory (CLAUDE.md +
// agent_role_memory backbone + DoD docs + handoffs). Anthropic's ephemeral
// prompt cache (5-min lifetime) lets us pay ~90% less on input tokens and
// shave ~50% off TTFB for repeat spawns of the same role.
//
// The cache key is the EXACT bytes of the prefix that comes before the
// cache_control marker (system block + any tool block + messages prefix).
// To get cache hits we must keep that prefix byte-identical across calls.
// Per-task variable text goes AFTER the marker.
//
// Anthropic docs: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
// SDK supports `cache_control: { type: 'ephemeral' }` on system blocks, tool
// definitions, and individual message blocks.
//
// Usage:
//   const Anthropic = require('@anthropic-ai/sdk');
//   const { messagesCreateCached, recordCacheUsage } = require('./_lib/spawn-with-cache');
//   const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
//
//   const result = await messagesCreateCached(client, {
//     model: 'claude-sonnet-4-6',
//     systemStatic: BIG_MEMORY_PREFIX,        // cached — keep byte-identical
//     systemVariable: 'Today is 2026-06-20.', // not cached — per-call dynamic
//     tools: TOOLS,                           // cached if non-empty
//     messages: [{ role: 'user', content: task }],
//     max_tokens: 2000,
//     metadata: { tenant_id, agent_role, instance_id },  // for analytics
//   });
//
//   // result.content / result.usage are the normal Anthropic shape.
//   // result.cache_metrics = { cached_tokens, cache_hit, savings_estimate }
//
// Owner: Atlas (atlas_5, 2026-06-20 Agent Speed Unlock).
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Anthropic pricing (per 1M tokens). Cache reads are 10% of normal input cost.
// Cache writes are 1.25x normal input cost (first-time penalty). Numbers
// rounded to a single source of truth; refresh when Anthropic publishes
// new rates.
const PRICING_PER_M = {
  'claude-opus-4-7':           { in: 15.00, out: 75.00 },
  'claude-opus-4-7-1m':        { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6':         { in:  3.00, out: 15.00 },
  'claude-haiku-4-5-20251001': { in:  0.80, out:  4.00 },
};

const CACHE_READ_MULTIPLIER  = 0.10;   // cached read = 10% of normal input price
const CACHE_WRITE_MULTIPLIER = 1.25;   // cache write = 125% of normal input price

function pricingFor(model) {
  return PRICING_PER_M[model] || PRICING_PER_M['claude-sonnet-4-6'];
}

/**
 * Wraps anthropic.messages.create() with cache_control markers on the
 * static prefix (system + tools). Returns the raw API result PLUS a
 * cache_metrics object derived from the usage block.
 *
 * @param {Anthropic} client            initialized @anthropic-ai/sdk client
 * @param {object}    opts
 * @param {string}    opts.model        e.g. 'claude-sonnet-4-6'
 * @param {string}    opts.systemStatic large static system prompt (cached)
 * @param {string}   [opts.systemVariable] small per-call addendum (NOT cached)
 * @param {Array}    [opts.tools]        anthropic tools array (cached if non-empty)
 * @param {Array}     opts.messages      conversation messages
 * @param {number}   [opts.max_tokens]   default 2000
 * @param {object}   [opts.tool_choice]
 * @param {object}   [opts.metadata]     analytics tags
 * @param {boolean}  [opts.recordAnalytics=true] log to agent_spawn_metrics
 * @returns {Promise<object>} { ...anthropicResult, cache_metrics }
 */
async function messagesCreateCached(client, opts) {
  const {
    model,
    systemStatic,
    systemVariable = '',
    tools = [],
    messages,
    max_tokens = 2000,
    tool_choice,
    metadata = {},
    recordAnalytics = true,
  } = opts;

  if (!client || typeof client.messages?.create !== 'function') {
    throw new Error('messagesCreateCached: client missing or has no messages.create');
  }
  if (!systemStatic || typeof systemStatic !== 'string') {
    throw new Error('messagesCreateCached: systemStatic (string) is required');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messagesCreateCached: messages array required');
  }

  // System is sent as an array of typed blocks so the static prefix can
  // carry cache_control. The variable block (if any) is appended without
  // cache_control so per-call text does NOT invalidate the cache prefix.
  const systemBlocks = [
    {
      type: 'text',
      text: systemStatic,
      cache_control: { type: 'ephemeral' },
    },
  ];
  if (systemVariable && systemVariable.trim()) {
    systemBlocks.push({ type: 'text', text: systemVariable });
  }

  // Tools — only the LAST tool needs cache_control to mark the boundary.
  // Anthropic caches everything up to and including the last cache_control
  // marker in the prefix.
  let toolsParam;
  if (Array.isArray(tools) && tools.length > 0) {
    toolsParam = tools.map((t, idx) => {
      if (idx === tools.length - 1) {
        return { ...t, cache_control: { type: 'ephemeral' } };
      }
      return t;
    });
  }

  const reqBody = {
    model,
    max_tokens,
    system: systemBlocks,
    messages,
  };
  if (toolsParam) reqBody.tools = toolsParam;
  if (tool_choice) reqBody.tool_choice = tool_choice;

  const t0 = Date.now();
  let result;
  let lastErr;
  // Exponential backoff on 429 / 529 (overloaded). 3 retries max.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      result = await client.messages.create(reqBody);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      if (status === 429 || status === 529 || status === 503) {
        const waitMs = Math.min(8000, 500 * Math.pow(2, attempt));
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  if (lastErr) throw lastErr;
  const elapsed = Date.now() - t0;

  // Anthropic usage block:
  //   input_tokens               — uncached portion
  //   cache_creation_input_tokens — first-time cache write
  //   cache_read_input_tokens    — cache hit on prior identical prefix
  //   output_tokens
  const usage = (result && result.usage) || {};
  const inputTokens         = usage.input_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens     = usage.cache_read_input_tokens || 0;
  const outputTokens        = usage.output_tokens || 0;

  const price = pricingFor(model);
  const inputCost   = (inputTokens / 1_000_000)         * price.in;
  const writeCost   = (cacheCreationTokens / 1_000_000) * price.in * CACHE_WRITE_MULTIPLIER;
  const readCost    = (cacheReadTokens / 1_000_000)     * price.in * CACHE_READ_MULTIPLIER;
  const outputCost  = (outputTokens / 1_000_000)        * price.out;
  const totalCost   = inputCost + writeCost + readCost + outputCost;

  // What it WOULD have cost without caching (all input at full price).
  const baselineInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
  const baselineCost = (baselineInputTokens / 1_000_000) * price.in + outputCost;
  const savings = baselineCost - totalCost;

  const cacheHit = cacheReadTokens > 0;

  const cache_metrics = {
    cache_hit: cacheHit,
    cache_read_tokens:     cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    uncached_input_tokens: inputTokens,
    output_tokens:         outputTokens,
    total_cost_usd:        Math.round(totalCost * 1_000_000) / 1_000_000,
    baseline_cost_usd:     Math.round(baselineCost * 1_000_000) / 1_000_000,
    savings_usd:           Math.round(savings * 1_000_000) / 1_000_000,
    duration_ms:           elapsed,
    model,
  };

  // Fire-and-forget analytics insert (don't block the response).
  if (recordAnalytics && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    recordCacheUsage({ ...cache_metrics, ...metadata }).catch((e) => {
      console.warn('[spawn-with-cache] analytics insert failed:', e.message);
    });
  }

  return { ...result, cache_metrics };
}

/**
 * Insert a row into agent_spawn_metrics. Fire-and-forget; failures are
 * logged but never thrown.
 */
async function recordCacheUsage(row) {
  try {
    const payload = {
      model:                 row.model,
      cache_hit:             !!row.cache_hit,
      cache_read_tokens:     row.cache_read_tokens || 0,
      cache_creation_tokens: row.cache_creation_tokens || 0,
      uncached_input_tokens: row.uncached_input_tokens || 0,
      output_tokens:         row.output_tokens || 0,
      total_cost_usd:        row.total_cost_usd || 0,
      baseline_cost_usd:     row.baseline_cost_usd || 0,
      savings_usd:           row.savings_usd || 0,
      duration_ms:           row.duration_ms || 0,
      tenant_id:             row.tenant_id || null,
      agent_role:            row.agent_role || null,
      instance_id:           row.instance_id || null,
      task_id:               row.task_id || null,
      endpoint:              row.endpoint || null,
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/agent_spawn_metrics`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.warn(`[spawn-with-cache] metrics insert ${res.status}: ${t.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn('[spawn-with-cache] recordCacheUsage error:', err.message);
  }
}

module.exports = {
  messagesCreateCached,
  recordCacheUsage,
  pricingFor,
  PRICING_PER_M,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
};
