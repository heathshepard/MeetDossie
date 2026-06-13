# Carter Spec — Agent Message Bus (Sage isolation fix, structural)

**From:** Atlas
**Date:** 2026-06-12
**Trigger:** Heath flagged that Sage is "isolated" from the rest of the agent ecosystem
**Investigation report:** `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Engineering\sage-telegram-isolation-fix-2026-06-12.md`
**Awaiting Heath approval before Carter starts.**

---

## Problem statement

Sage has her own dedicated bot (`DossieSageBot` / `TELEGRAM_SAGE_BOT_TOKEN`). She receives partial context (daily social digest, weekly analytics, trends, competitor scan) into her chat. She CANNOT see:

1. Heath's directives to Cole (those flow via Claude Code local polling against Claudy bot — no server-side hook)
2. Status reports from Atlas, Carter, Pierce, Hadley, Sterling, Quinn (those go to Claudy chat — Sage's bot doesn't see them)
3. What other agents are currently doing

Similarly: Atlas, Carter, etc. cannot see what Sage is doing or what Heath asked her last.

We need a shared event bus so every agent can read recent cross-agent traffic.

---

## Goal

Build `agent_messages` table in Supabase, plus a thin write/read helper, plus edit existing crons/webhooks to write to it on every Telegram send. Then edit Sage's webhook to read from it as additional context.

---

## Scope — IN

1. Migration: `agent_messages` table + indexes
2. New file: `api/_lib/agent-bus.js` with `writeMessage()` and `readForAgent()` helpers
3. Edit `api/sage-webhook.js` — when building Sage's prompt, ALSO pull last 20 `agent_messages` where `to_agent IS NULL OR to_agent='sage'` AND `ts > NOW() - INTERVAL '24 hours'` and append as a `<recent_agent_activity>` block to her system prompt
4. Edit the following files to call `writeMessage()` on every successful Telegram send (in addition to whatever they already do):
   - `api/cron-morning-ops-digest.js` (from='cole', channel='cron')
   - `api/cron-sage-fb-digest.js` (from='sage', channel='cron')
   - `api/cron-sage-intelligence.js` (from='sage', channel='cron')
   - `api/cron-sage-trends.js` (from='sage', channel='cron')
   - `api/cron-social-digest.js` (from='sage', channel='cron')
   - `api/cron-analytics-sync.js` (from='cole', channel='cron')
   - `api/cron-competitor-monitor.js` (from='sage', channel='cron')
   - `api/cron-process-agent-requests.js` (from=row.to_agent, to_agent='sage', channel='cron')
   - `api/sage-webhook.js` itself (from='heath'/role=user; from='sage'/role=assistant on every turn, channel='telegram')
5. New file: `api/cron-mirror-claudy-to-bus.js` — runs every 2 min, polls Claudy's `getUpdates` (with offset tracked in new `bus_state` table), writes Heath's inbound messages to `agent_messages` as `from_agent='heath'`. **HEATH MUST CONFIRM this won't fight with Claude Code's local polling FIRST.** If yes, skip this file; instead, Cole writes to the bus from his own session via a memory-file rule.

## Scope — OUT

- DO NOT touch the DossieMarketingBot approval flows (`api/cron-send-for-approval.js`, `api/group-post-callback.js`). They use callback buttons that depend on the bot identity — leave them alone.
- DO NOT touch the `scripts/atlas-*.js` and `scripts/sage-fb-*.js` operational scripts in this pass. They run locally and don't currently need bus access. Add to bus in a Phase 2 if needed.
- DO NOT change which bot any cron uses. Bot identity stays the same; we're adding a SECOND write (to the bus) alongside the existing Telegram send.

---

## Migration SQL

```sql
-- migrations/2026-06-12_agent_messages.sql

create table if not exists agent_messages (
  id          uuid primary key default gen_random_uuid(),
  ts          timestamptz not null default now(),
  from_agent  text not null,
  to_agent    text,
  channel     text not null,
  body        text not null,
  meta        jsonb not null default '{}'::jsonb,
  read_by     text[] not null default array[]::text[]
);

create index if not exists agent_messages_to_agent_ts_idx
  on agent_messages (to_agent, ts desc);

create index if not exists agent_messages_from_agent_ts_idx
  on agent_messages (from_agent, ts desc);

create index if not exists agent_messages_ts_idx
  on agent_messages (ts desc);

-- RLS: service-role only, no public access
alter table agent_messages enable row level security;

-- bus_state for Claudy poller offset (only created if we ship the poller)
create table if not exists bus_state (
  key   text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
```

Migration applied via Supabase MCP `apply_migration` after Heath approves.

---

## `api/_lib/agent-bus.js` skeleton

```js
'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function writeMessage({ from_agent, to_agent = null, channel, body, meta = {} }) {
  if (!from_agent || !channel || !body) {
    console.warn('[agent-bus] writeMessage missing required fields');
    return { ok: false };
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/agent_messages`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ from_agent, to_agent, channel, body: String(body).slice(0, 8000), meta }),
    });
    return { ok: res.ok };
  } catch (err) {
    console.warn('[agent-bus] writeMessage failed:', err && err.message);
    return { ok: false };
  }
}

async function readForAgent(agent, { hours = 24, limit = 20 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/agent_messages?` +
    `or=(to_agent.is.null,to_agent.eq.${encodeURIComponent(agent)})` +
    `&ts=gte.${since}` +
    `&order=ts.desc&limit=${limit}` +
    `&select=ts,from_agent,to_agent,channel,body,meta`;
  try {
    const res = await fetch(url, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows.reverse() : [];
  } catch (err) {
    console.warn('[agent-bus] readForAgent failed:', err && err.message);
    return [];
  }
}

module.exports = { writeMessage, readForAgent };
```

---

## Sage webhook integration

In `api/sage-webhook.js`, before calling Anthropic, prepend recent bus activity to her system prompt:

```js
const { readForAgent } = require('./_lib/agent-bus.js');

// Inside the handler, after loading history and BEFORE callSage:
const busRows = await readForAgent('sage', { hours: 24, limit: 15 });
const busBlock = busRows.length
  ? `\n\n## Recent cross-agent activity (last 24h)\n` +
    busRows.map(r => `- [${r.ts}] ${r.from_agent}${r.to_agent ? ` → ${r.to_agent}` : ' (broadcast)'}: ${r.body.slice(0, 280)}`).join('\n')
  : '';
const augmentedPrompt = SAGE_SYSTEM_PROMPT + busBlock;
// pass augmentedPrompt instead of SAGE_SYSTEM_PROMPT to callSage
```

Also write Heath's inbound message and Sage's reply to the bus:
```js
// after storeMessage(chatId, 'user', userText, ...)
await writeMessage({ from_agent: 'heath', to_agent: 'sage', channel: 'telegram', body: userText });
// after storeMessage(chatId, 'sage', reply, ...)
await writeMessage({ from_agent: 'sage', to_agent: null, channel: 'telegram', body: reply });
```

---

## Test plan

1. After migration: `select count(*) from agent_messages` returns 0
2. Trigger `api/cron-social-digest.js` manually → verify a row is written with `from_agent='sage'`
3. DM Sage "what's the latest from the team?" → verify her reply references the social digest content
4. Trigger `api/cron-process-agent-requests.js` with a fake Carter response → verify a row with `from_agent='carter', to_agent='sage'`
5. Verify Sage's next DM includes the Carter context

---

## Rollback

If anything breaks: drop `agent_messages` table, revert each edited file. No data loss because we're additive — every existing Telegram send still happens, we only ADD a Supabase insert.

---

## Carter's instructions

1. Apply migration first via Supabase MCP
2. Create `api/_lib/agent-bus.js` exactly as specced
3. Edit `api/sage-webhook.js` for read + bus writes
4. Edit the 8 crons listed in Scope IN — for each, find the Telegram `sendMessage` `fetch()` call and add a `writeMessage()` call directly after on success
5. Ship to staging, push to staging branch
6. Hand off to Quinn for verification before merging to main

**Do NOT ship the Claudy poller (`cron-mirror-claudy-to-bus.js`) until Heath confirms it won't fight Claude Code's local polling.** Without it, Heath's directives to Cole still won't reach Sage — that's Phase 2.
