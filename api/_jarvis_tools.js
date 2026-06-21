// api/_jarvis_tools.js
// Tool definitions + dispatcher for Jarvis (Anthropic tool_use protocol).
//
// Exports:
//   - TOOL_SPECS: full Anthropic tool spec array (filtered per tenant whitelist)
//   - dispatchTool(toolName, input, ctx): runs the tool, returns { result, error?, status, requires_approval, audit }
//
// Each tool returns either { result } on success (Claude sees this) or { error }
// (Claude sees an error message). State-changing tools set requires_approval=true
// and STOP execution; the chat handler then asks Heath verbally and on next turn
// it can pass approved=true to actually execute.
//
// Tools available in v1 (Session 2):
//   - query_supabase           (read-only SQL on allowlisted tables)
//   - read_dossie_dashboards   (curated rollups — MRR, customers, posts)
//   - send_telegram            (state-changing; gate)
//   - spawn_agent              (state-changing-ish; fires Anthropic background API; allowed without approval)
//   - web_search               (Brave Search API)
//   - set_reminder             (insert into heath_todo)
//   - read_calendar            (Google Calendar via Zapier MCP not wired yet — stubbed)
//   - web_browse               (Playwright tunnel — stubbed if no URL set)
//   - send_sms                 (stubbed; Phone Link Phase 2)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
const JARVIS_BROWSER_WORKER_URL = process.env.JARVIS_BROWSER_WORKER_URL;
const JARVIS_BROWSER_WORKER_TOKEN = process.env.JARVIS_BROWSER_WORKER_TOKEN;

// Allowlist of tables for query_supabase to read.
const READABLE_TABLES = new Set([
  'subscriptions',
  'social_posts',
  'profiles',
  'founding_applications',
  'waitlist',
  'calculator_signups',
  'heath_todo',
  'jarvis_conversations',
  'jarvis_agent_events',
  'content_calendar',
  'transactions',
  'documents',
  'action_items',
]);

// ===== Tool specs (Anthropic tool_use format) =====
// Each spec is { name, description, input_schema }. Only tools in the tenant's
// jarvis_tools whitelist make it into the live request.
const ALL_TOOLS = [
  {
    name: 'query_supabase',
    description:
      "Read-only query against Heath's Supabase. Use for counting customers, looking up a specific user, checking a post status, etc. " +
      'Returns up to 50 rows. NEVER mutates. Only the following tables are readable: ' +
      Array.from(READABLE_TABLES).join(', ') + '.',
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name to query (must be allowlisted).' },
        select: { type: 'string', description: 'Comma-separated columns. Default: *', default: '*' },
        filters: { type: 'string', description: 'Optional PostgREST filter string, e.g. "status=eq.active&priority=gte.5". Omit for all rows.' },
        order: { type: 'string', description: 'Optional order clause, e.g. "created_at.desc"' },
        limit: { type: 'integer', description: 'Max 50.', default: 25 },
      },
      required: ['table'],
    },
    requires_approval: false,
  },
  {
    name: 'read_dossie_dashboards',
    description:
      'Curated Dossie KPI rollup: active subscriber count, estimated MRR, pending social posts awaiting approval, '
      + 'today\'s scheduled posts, waitlist size, founding application backlog. Use when Heath asks "how is Dossie", '
      + '"what\'s our MRR", "how many customers", "what\'s pending", etc. Fresh on every call.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    requires_approval: false,
  },
  {
    name: 'web_search',
    description:
      'Search the live web (current news, weather, stock prices, flight status, traffic, anything outside training data). '
      + 'Returns top 5 results with titles, URLs, and short snippets.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query in plain English.' },
        max_results: { type: 'integer', description: 'Default 5, max 10.', default: 5 },
      },
      required: ['query'],
    },
    requires_approval: false,
  },
  {
    name: 'web_browse',
    description:
      'Open a URL in a headless browser, return the visible text and a screenshot URL. Use when Heath wants you to '
      + 'check a page, scrape a specific value, or verify a deployment. STATE-CHANGING actions (form submit, purchase) '
      + 'on the browsed page require explicit verbal approval.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open.' },
        action: { type: 'string', enum: ['read', 'screenshot'], default: 'read' },
      },
      required: ['url'],
    },
    requires_approval: false, // reading is fine; mutations would be a separate tool
  },
  {
    name: 'send_telegram',
    description:
      'Send a Telegram message via Claudy bot. Default recipient is Heath. STATE-CHANGING — confirm verbally before firing.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message body (Telegram-safe, no HTML).' },
        chat_id: { type: 'string', description: 'Optional alternate chat_id. Default = Heath.' },
      },
      required: ['text'],
    },
    requires_approval: true,
  },
  {
    name: 'send_sms',
    description: 'Send an SMS via the home-PC Phone Link bridge. STATE-CHANGING — confirm verbally. NOT YET WIRED in v1 — will return stub.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Phone number (E.164 like +18005551234).' },
        text: { type: 'string', description: 'Message body.' },
      },
      required: ['to', 'text'],
    },
    requires_approval: true,
  },
  {
    name: 'read_calendar',
    description:
      'Read Heath\'s Google Calendar events in a window. Returns list of events with title, start, end, location. '
      + 'NOT YET WIRED in v1 — returns stub.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'ISO start datetime.' },
        end: { type: 'string', description: 'ISO end datetime.' },
      },
      required: ['start', 'end'],
    },
    requires_approval: false,
  },
  {
    name: 'set_reminder',
    description:
      'Add an item to Heath\'s todo list (heath_todo table). Use when Heath says "remind me", "add to my list", "put on the docket".',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the item.' },
        detail: { type: 'string', description: 'Optional detail / context.' },
        deadline: { type: 'string', description: 'Optional ISO deadline.' },
        priority: { type: 'integer', description: 'Priority 1-10, default 5.', default: 5 },
        venture: { type: 'string', description: 'Optional: dossie, paralegal, plane-and-ember, kw, personal.' },
      },
      required: ['title'],
    },
    requires_approval: false, // writes Heath's own list, low risk
  },
  {
    name: 'spawn_agent',
    description:
      'Fire a background Anthropic call as a Shepard Ventures specialist agent (atlas, carter, hadley, pierce, sage, quinn, ridge, sterling). '
      + 'The agent gets the task brief, runs autonomously (returns initial response synchronously, but full work may continue). '
      + 'Records the spawn in jarvis_agent_events so the Agent Status panel updates.',
    input_schema: {
      type: 'object',
      properties: {
        agent_name: {
          type: 'string',
          enum: ['atlas', 'carter', 'hadley', 'pierce', 'sage', 'quinn', 'ridge', 'sterling'],
          description: 'Which specialist to spawn.',
        },
        task_description: { type: 'string', description: 'Plain-English brief — what Heath wants the agent to do.' },
      },
      required: ['agent_name', 'task_description'],
    },
    requires_approval: false, // spawning an agent is internal; the agent itself gates its actions
  },
];

const TOOL_BY_NAME = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));

// ===== Supabase REST helpers =====
async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPost(path, body, { prefer = 'return=representation' } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbPost ${path} -> ${res.status} ${errBody.slice(0, 200)}`);
  }
  return prefer.includes('representation') ? res.json() : null;
}

// ===== Tool implementations =====

async function tool_query_supabase(input) {
  const { table, select = '*', filters = '', order = '', limit = 25 } = input || {};
  if (!table || typeof table !== 'string') return { error: 'table is required' };
  if (!READABLE_TABLES.has(table)) {
    return { error: `Table "${table}" not allowlisted. Allowed: ${Array.from(READABLE_TABLES).join(', ')}` };
  }
  const safeSelect = String(select).slice(0, 500);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 25));

  const params = [`select=${encodeURIComponent(safeSelect)}`, `limit=${safeLimit}`];
  if (order) params.push(`order=${encodeURIComponent(order)}`);

  // Pass through filters as raw query string segments
  let url = `${table}?${params.join('&')}`;
  if (filters) url += `&${filters}`;

  try {
    const rows = await sbGet(url);
    return {
      result: {
        table,
        row_count: Array.isArray(rows) ? rows.length : 0,
        rows: Array.isArray(rows) ? rows.slice(0, safeLimit) : [],
      },
    };
  } catch (err) {
    return { error: `Query failed: ${err.message}` };
  }
}

async function tool_read_dossie_dashboards() {
  try {
    const [subs, pendingPosts, scheduledPosts, waitlist, foundingApps, postsToday] = await Promise.all([
      sbGet('subscriptions?select=id,status&status=eq.active').catch(() => []),
      sbGet('social_posts?select=id&status=eq.pending_approval').catch(() => []),
      sbGet('social_posts?select=id&status=eq.approved').catch(() => []),
      sbGet('waitlist?select=id').catch(() => []),
      sbGet('founding_applications?select=id,approved&approved=is.null').catch(() => []),
      sbGet('social_posts?select=id,platform,status&status=eq.posted&order=created_at.desc&limit=10').catch(() => []),
    ]);

    const mrr = subs.length * 29; // founding-locked estimate
    return {
      result: {
        active_subscriptions: subs.length,
        mrr_estimated_usd: mrr,
        pending_post_approvals: pendingPosts.length,
        approved_pending_publish: scheduledPosts.length,
        waitlist_size: waitlist.length,
        founding_apps_pending: foundingApps.length,
        recent_posts_count: postsToday.length,
        note: 'MRR is a $29/sub estimate; pulls active count from subscriptions.status=active.',
      },
    };
  } catch (err) {
    return { error: `Dashboard load failed: ${err.message}` };
  }
}

async function tool_web_search(input) {
  const { query, max_results = 5 } = input || {};
  if (!query) return { error: 'query is required' };
  if (!BRAVE_SEARCH_API_KEY) {
    return {
      error: 'web_search not configured — BRAVE_SEARCH_API_KEY missing. Heath can add it in Vercel env.',
    };
  }
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(10, max_results)}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': BRAVE_SEARCH_API_KEY,
      },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: `Brave Search ${res.status}: ${t.slice(0, 200)}` };
    }
    const data = await res.json();
    const results = (data.web && data.web.results) || [];
    return {
      result: {
        query,
        results: results.slice(0, max_results).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description,
        })),
      },
    };
  } catch (err) {
    return { error: `Web search failed: ${err.message}` };
  }
}

async function tool_web_browse(input) {
  const { url, action = 'read' } = input || {};
  if (!url) return { error: 'url is required' };
  if (!JARVIS_BROWSER_WORKER_URL) {
    return {
      error: 'web_browse not yet wired — JARVIS_BROWSER_WORKER_URL not set. Coming Session 2.5 (Playwright tunnel on Heath\'s home PC).',
    };
  }
  try {
    const res = await fetch(`${JARVIS_BROWSER_WORKER_URL}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: JARVIS_BROWSER_WORKER_TOKEN ? `Bearer ${JARVIS_BROWSER_WORKER_TOKEN}` : '',
      },
      body: JSON.stringify({ url, action }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { error: `Browser worker ${res.status}: ${t.slice(0, 200)}` };
    }
    const data = await res.json();
    return { result: data };
  } catch (err) {
    return { error: `Browser worker unreachable: ${err.message}` };
  }
}

async function tool_send_telegram(input) {
  const { text, chat_id } = input || {};
  if (!text || typeof text !== 'string') return { error: 'text is required' };
  if (!TELEGRAM_BOT_TOKEN) return { error: 'send_telegram not configured — TELEGRAM_BOT_TOKEN missing' };
  const recipient = chat_id || TELEGRAM_CHAT_ID;
  if (!recipient) return { error: 'No recipient chat_id and TELEGRAM_CHAT_ID env not set' };

  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: recipient, text: text.slice(0, 4000) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { error: `Telegram send failed: ${data.description || res.status}` };
    }
    return { result: { sent: true, chat_id: recipient, message_id: data.result?.message_id } };
  } catch (err) {
    return { error: `Telegram send failed: ${err.message}` };
  }
}

async function tool_send_sms(input) {
  return {
    error: 'send_sms not yet wired in v1. Phase 2 will integrate Microsoft Phone Link bridge on Heath\'s home PC. '
      + `Stub call: to=${input?.to}, text="${(input?.text || '').slice(0, 50)}..."`,
  };
}

async function tool_read_calendar(input) {
  return {
    error: 'read_calendar not yet wired in v1. Will use Google Calendar OAuth via Zapier MCP in Session 2.5. '
      + `Stub call: window ${input?.start} -> ${input?.end}`,
  };
}

async function tool_set_reminder(input, ctx) {
  const { title, detail = '', deadline = null, priority = 5, venture = 'personal' } = input || {};
  if (!title) return { error: 'title is required' };
  try {
    const row = await sbPost('heath_todo', {
      title: String(title).slice(0, 200),
      detail: String(detail).slice(0, 1000),
      action_type: 'jarvis_set_reminder',
      priority: Math.max(1, Math.min(10, Number(priority) || 5)),
      deadline: deadline || null,
      status: 'open',
      venture: String(venture).slice(0, 40),
      created_by: 'jarvis',
      metadata: { conversation_id: ctx?.conversationId || null, tenant_slug: ctx?.tenant?.slug || null },
    });
    return {
      result: {
        added: true,
        id: row[0].id,
        title: row[0].title,
        priority: row[0].priority,
        deadline: row[0].deadline,
      },
    };
  } catch (err) {
    return { error: `set_reminder failed: ${err.message}` };
  }
}

async function tool_spawn_agent(input, ctx) {
  const { agent_name, task_description } = input || {};
  if (!agent_name || !task_description) {
    return { error: 'agent_name and task_description are required' };
  }
  if (!ANTHROPIC_API_KEY) return { error: 'spawn_agent: ANTHROPIC_API_KEY not configured' };

  // 1. Write the 'spawned' event so the panel updates immediately.
  let eventId = null;
  try {
    const row = await sbPost('jarvis_agent_events', {
      tenant_id: ctx?.tenant?.id,
      agent_name,
      event_type: 'spawned',
      summary: String(task_description).slice(0, 200),
      details: { source: 'jarvis_pwa', conversation_id: ctx?.conversationId || null },
    });
    eventId = row[0].id;
  } catch (err) {
    return { error: `agent event log failed: ${err.message}` };
  }

  // 2. Fire a synchronous Anthropic call as that persona to capture a short
  //    acknowledgement. The full agent run continues in the background via a
  //    separate worker pattern (TBD); for v1 we return the acknowledgement so
  //    Heath hears a sensible immediate response.
  const personaPrompt = AGENT_PERSONA_PROMPTS[agent_name]
    || `You are ${agent_name}, a Shepard Ventures specialist. Acknowledge the task briefly and outline first 2-3 steps.`;

  try {
    const claudeRes = await Promise.race([
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 250,
          system: personaPrompt,
          messages: [{ role: 'user', content: `Heath says: ${task_description}\n\nAcknowledge in 1-2 sentences and name your first 2-3 steps. Be terse.` }],
        }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('agent ack timeout')), 8000)),
    ]);
    if (!claudeRes.ok) {
      return { error: `${agent_name} ack failed (${claudeRes.status})` };
    }
    const data = await claudeRes.json();
    const ack = (data.content?.[0]?.text || '').trim();

    // 3. Write a 'progress' event with the ack so it shows up in the panel.
    try {
      await sbPost('jarvis_agent_events', {
        tenant_id: ctx?.tenant?.id,
        agent_name,
        event_type: 'progress',
        summary: ack.slice(0, 200),
        details: { source: 'jarvis_pwa_ack', spawn_event_id: eventId },
      });
    } catch (e) { /* non-fatal */ }

    return {
      result: {
        spawned: true,
        agent: agent_name,
        event_id: eventId,
        ack,
        note: 'Agent acknowledged and is working. Status updates will flow through the Agent Status panel.',
      },
    };
  } catch (err) {
    return { error: `${agent_name} spawn failed: ${err.message}` };
  }
}

const AGENT_PERSONA_PROMPTS = {
  atlas: 'You are Atlas, Heath\'s Head of Platform Engineering. Senior staff engineer voice. Opinionated, terse, ship-fast. Acknowledge the task and name the first 2-3 concrete steps.',
  carter: 'You are Carter, Heath\'s Head of Product Engineering. You DRAFT code (Atlas ships). Acknowledge and outline what you\'ll draft and which files you\'ll touch.',
  hadley: 'You are Hadley, Heath\'s General Counsel. Lawyer voice, business-pragmatic, never alarmist. Acknowledge and name the legal angles you\'ll explore.',
  pierce: 'You are Pierce, Heath\'s Growth and Customer Success lead. Warm, founder-direct tone. Acknowledge and name your first outreach or funnel step.',
  sage: 'You are Sage, Heath\'s Head of Social Media. Acknowledge and name the platform-specific plays you\'ll set up.',
  quinn: 'You are Quinn, Heath\'s QA lead. Acknowledge and list what you\'ll test.',
  ridge: 'You are Ridge, Heath\'s reliability engineer. Acknowledge and name the failure modes you\'ll harden against.',
  sterling: 'You are Sterling, Heath\'s markets analyst. Acknowledge and name the data sources you\'ll pull.',
};

const TOOL_DISPATCHERS = {
  query_supabase: tool_query_supabase,
  read_dossie_dashboards: tool_read_dossie_dashboards,
  web_search: tool_web_search,
  web_browse: tool_web_browse,
  send_telegram: tool_send_telegram,
  send_sms: tool_send_sms,
  read_calendar: tool_read_calendar,
  set_reminder: tool_set_reminder,
  spawn_agent: tool_spawn_agent,
};

// ===== Public API =====

/**
 * Build the tool spec array filtered to the tenant's enabled tools.
 * @param {string[]} enabledNames - tool names enabled for this tenant.
 * @returns {object[]} Anthropic tool spec array.
 */
function buildToolSpecs(enabledNames) {
  const enabled = new Set(enabledNames || []);
  return ALL_TOOLS
    .filter((t) => enabled.has(t.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
}

/**
 * Dispatch a tool call from Claude.
 * @param {string} toolName
 * @param {object} input
 * @param {object} ctx - { tenant, jarvisUser, conversationId, requestId, approved? }
 * @returns {Promise<{result?, error?, requires_approval?, audit}>}
 */
async function dispatchTool(toolName, input, ctx) {
  const spec = TOOL_BY_NAME[toolName];
  if (!spec) {
    return {
      error: `Unknown tool: ${toolName}`,
      audit: { tool: toolName, ts: new Date().toISOString() },
    };
  }
  if (spec.requires_approval && !ctx?.approved) {
    return {
      requires_approval: true,
      result: {
        pending: true,
        message: `This is a state-changing action (${toolName}). Get Heath's verbal approval before executing.`,
        proposed_input: input,
      },
      audit: { tool: toolName, ts: new Date().toISOString(), gated: true },
    };
  }
  const fn = TOOL_DISPATCHERS[toolName];
  if (!fn) {
    return {
      error: `Tool dispatcher not implemented: ${toolName}`,
      audit: { tool: toolName, ts: new Date().toISOString() },
    };
  }
  const t0 = Date.now();
  try {
    const out = await fn(input, ctx);
    return {
      ...out,
      audit: {
        tool: toolName,
        ts: new Date().toISOString(),
        ms: Date.now() - t0,
        success: !out.error,
      },
    };
  } catch (err) {
    return {
      error: `Tool ${toolName} threw: ${err.message}`,
      audit: { tool: toolName, ts: new Date().toISOString(), ms: Date.now() - t0, success: false },
    };
  }
}

/**
 * Log a tool invocation to jarvis_tool_invocations.
 */
async function logToolInvocation(ctx, toolName, input, output, audit) {
  if (!ctx?.assistantMessageId || !ctx?.tenant?.id) return;
  try {
    await sbPost('jarvis_tool_invocations', {
      message_id: ctx.assistantMessageId,
      tenant_id: ctx.tenant.id,
      tool_name: toolName,
      input,
      output,
      approval_required: TOOL_BY_NAME[toolName]?.requires_approval || false,
      approval_status: TOOL_BY_NAME[toolName]?.requires_approval
        ? (ctx.approved ? 'approved' : 'pending')
        : 'n/a',
      executed_at: audit?.success ? new Date().toISOString() : null,
    }, { prefer: 'return=minimal' });
  } catch (err) {
    console.warn(`[jarvis-tools] log invocation failed: ${err.message}`);
  }
}

export { ALL_TOOLS, TOOL_BY_NAME, buildToolSpecs, dispatchTool, logToolInvocation };
