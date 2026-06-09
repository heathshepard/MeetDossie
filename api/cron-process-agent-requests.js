'use strict';

// Vercel Serverless Function: /api/cron-process-agent-requests
//
// Picks up pending agent_requests rows and executes them via a Sonnet call
// using the target agent's system prompt. On success:
//   1. Writes response_text + status='complete' to agent_requests
//   2. Inserts a row into sage_conversations (role='sage') so Sage's webhook
//      sees it in next history load
//   3. Sends a Telegram message to Heath via the Sage bot
//
// Auth: Bearer ${CRON_SECRET} (cron-job.org sends this header)
// Schedule: every 1 minute via cron-job.org (Vercel cron cap reached)
// Vercel maxDuration: 60s — processes up to MAX_PER_RUN requests per minute.
//
// Phase 1 limits:
//  - Cole is NOT processed here (loop risk). [COLE: ...] markers are routed
//    by Sage's webhook to Heath's Telegram chat as a "Sage wants Cole to X"
//    notification instead.
//  - Rate limit: max 10 requests per source_chat_id per hour.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_SAGE_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;

const SONNET_MODEL = 'claude-sonnet-4-6';
const MAX_PER_RUN = 5;            // up to 5 requests per cron tick
const MAX_REPLY_CHARS = 3800;
const RATE_LIMIT_PER_HOUR = 10;   // per source_chat_id

const AGENT_PROMPTS = {
  carter: require('./_lib/agent-prompts/carter.js'),
  atlas: require('./_lib/agent-prompts/atlas.js'),
  pierce: require('./_lib/agent-prompts/pierce.js'),
  hadley: require('./_lib/agent-prompts/hadley.js'),
  quinn: require('./_lib/agent-prompts/quinn.js'),
};

// ─── Supabase REST helper ─────────────────────────────────────────────────────

async function supaFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendSageTelegram(chatId, text) {
  if (!TELEGRAM_SAGE_BOT_TOKEN) {
    console.warn('[cron-process-agent-requests] TELEGRAM_SAGE_BOT_TOKEN not set — skipping');
    return false;
  }
  const chunks = [];
  let s = String(text || '');
  while (s.length > 0) {
    chunks.push(s.slice(0, MAX_REPLY_CHARS));
    s = s.slice(MAX_REPLY_CHARS);
  }
  let allOk = true;
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_SAGE_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[cron-process-agent-requests] Telegram failed:', res.status, body.slice(0, 200));
      allOk = false;
    }
  }
  return allOk;
}

// ─── Anthropic ────────────────────────────────────────────────────────────────

async function callAgent(agent, requestText) {
  const systemPrompt = AGENT_PROMPTS[agent];
  if (!systemPrompt) throw new Error(`no_prompt_for_agent:${agent}`);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: requestText }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('[cron-process-agent-requests] Anthropic error:', res.status, text.slice(0, 300));
    throw new Error(`anthropic_${res.status}`);
  }
  const data = JSON.parse(text);
  return data?.content?.[0]?.text || '';
}

// ─── Rate limit check ─────────────────────────────────────────────────────────

async function isRateLimited(sourceChatId) {
  if (!sourceChatId) return false;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { ok, data } = await supaFetch(
    `agent_requests?source_chat_id=eq.${encodeURIComponent(sourceChatId)}&created_at=gte.${encodeURIComponent(oneHourAgo)}&select=id`,
  );
  if (!ok || !Array.isArray(data)) return false;
  return data.length > RATE_LIMIT_PER_HOUR;
}

// ─── Update helpers ───────────────────────────────────────────────────────────

async function markStatus(requestId, patch) {
  return supaFetch(
    `agent_requests?request_id=eq.${encodeURIComponent(requestId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
}

async function logToSageConversation(chatId, text) {
  if (!chatId) return;
  return supaFetch('sage_conversations', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      chat_id: String(chatId),
      role: 'sage',
      text: String(text || ''),
      telegram_message_id: null,
    }),
  });
}

// ─── Single request processor ─────────────────────────────────────────────────

async function processOne(row) {
  const agentRaw = String(row.to_agent || '').toLowerCase();

  // Phase 1: Cole is relay-only, should never land here. Defensive skip.
  if (agentRaw === 'cole') {
    await markStatus(row.request_id, {
      status: 'failed',
      response_text: 'cole_relay_only_phase1',
      completed_at: new Date().toISOString(),
    });
    return { id: row.request_id, status: 'skipped_cole' };
  }

  if (!AGENT_PROMPTS[agentRaw]) {
    await markStatus(row.request_id, {
      status: 'failed',
      response_text: `unsupported_agent:${agentRaw}`,
      completed_at: new Date().toISOString(),
    });
    return { id: row.request_id, status: 'unsupported' };
  }

  // Rate-limit check
  if (await isRateLimited(row.source_chat_id)) {
    await markStatus(row.request_id, {
      status: 'failed',
      response_text: 'rate_limited',
      completed_at: new Date().toISOString(),
    });
    return { id: row.request_id, status: 'rate_limited' };
  }

  // Mark in_progress so we don't double-pick if this run overlaps the next tick
  await markStatus(row.request_id, { status: 'in_progress' });

  let replyText;
  try {
    replyText = await callAgent(agentRaw, row.request_text);
  } catch (err) {
    await markStatus(row.request_id, {
      status: 'failed',
      response_text: `agent_call_error:${err && err.message ? err.message : String(err)}`,
      completed_at: new Date().toISOString(),
    });
    return { id: row.request_id, status: 'error', error: err && err.message };
  }

  if (!replyText) {
    await markStatus(row.request_id, {
      status: 'failed',
      response_text: 'empty_reply',
      completed_at: new Date().toISOString(),
    });
    return { id: row.request_id, status: 'empty' };
  }

  const agentName = agentRaw.charAt(0).toUpperCase() + agentRaw.slice(1);
  const wrapped = `📨 ${agentName} reports:\n\n${replyText}`;

  // Persist to agent_requests
  await markStatus(row.request_id, {
    status: 'complete',
    response_text: replyText,
    completed_at: new Date().toISOString(),
  });

  // Log into Sage's conversation thread so she sees it next time
  await logToSageConversation(row.source_chat_id, wrapped);

  // Notify Heath in Telegram via the Sage bot
  if (row.source_chat_id) {
    await sendSageTelegram(row.source_chat_id, wrapped);
  }

  return { id: row.request_id, status: 'complete', agent: agentRaw };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isCronSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `missing_env:${missing.join(',')}` });
  }

  // Pull pending requests, oldest first
  const { ok, data, status } = await supaFetch(
    `agent_requests?status=eq.pending&order=created_at.asc&limit=${MAX_PER_RUN}&select=request_id,from_agent,to_agent,request_text,source_chat_id,source_message_id`,
  );
  if (!ok) {
    return res.status(500).json({ ok: false, error: `supabase_${status}` });
  }
  if (!Array.isArray(data) || data.length === 0) {
    return res.status(200).json({ ok: true, processed: 0, results: [] });
  }

  const results = [];
  for (const row of data) {
    try {
      const r = await processOne(row);
      results.push(r);
    } catch (err) {
      console.error('[cron-process-agent-requests] processOne crashed:', err && err.message);
      results.push({
        id: row.request_id,
        status: 'crashed',
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  return res.status(200).json({
    ok: true,
    processed: results.length,
    results,
  });
};
