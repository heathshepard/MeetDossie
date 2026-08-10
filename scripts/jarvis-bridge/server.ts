#!/usr/bin/env bun
/**
 * jarvis-bridge channel for Claude Code.
 *
 * Two-way channel that lets Heath talk to THIS live Claude Code session by
 * voice through the Jarvis PWA (meetdossie.com/myjarvis), instead of going
 * through a separate spawned "Build mode" worker (scripts/claude-code-worker.js,
 * api/jarvis-claude-code.js — untouched by this file, still works as before).
 *
 * Transport: a private Supabase Storage bucket (`jarvis-bridge`), one JSON
 * object per turn at turns/<turn_id>.json. Deliberately NOT a WebSocket relay:
 * this process only ever makes outbound HTTPS calls to Supabase, so it works
 * through NAT/firewalls with zero router config and no exposed local port —
 * same shape as every other local poller already in this repo
 * (scripts/claude-code-worker.js, scripts/agent-queue-poller.js). No DB
 * migration needed either — Storage objects, not a table.
 *
 * Flow:
 *   1. Heath talks to Jarvis. The PWA transcribes speech to text and POSTs it
 *      to /api/jarvis-bridge-turn (owner-gated — only heath.shepard@kw.com's
 *      Supabase session can write a turn). That endpoint writes
 *      turns/<id>.json = {status:"pending", user_message, created_at}.
 *   2. THIS process polls the bucket. When it finds a pending turn, it flips
 *      it to "delivered" and injects the text into this live session via
 *      notifications/claude/channel — a real user turn, same tools, same
 *      agent-dispatch, same Playwright access as anything typed here.
 *   3. This session calls the `reply` tool with its answer. The tool writes
 *      {status:"answered", reply_text} back onto the same object.
 *   4. Jarvis's poll of GET /api/jarvis-bridge-turn?id=<id> sees "answered"
 *      and speaks the reply through the existing ElevenLabs TTS pipeline
 *      (/api/jarvis-voice?op=tts) — the same voice-out path already wired
 *      for Quick mode.
 *
 * Credentials live in ~/.claude/channels/jarvis-bridge/.env — SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY — loaded the same way the telegram channel loads
 * its bot token (server.ts in external_plugins/telegram). Never committed to
 * the repo, never printed to stdout/stderr.
 *
 * Run standalone for testing:
 *   claude --dangerously-load-development-channels server:jarvis-bridge -p "..."
 * (research-preview channels aren't on the approved allowlist yet — this flag
 * is required until Anthropic curates it onto the default list, same as any
 * other custom channel.)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const STATE_DIR = process.env.JARVIS_BRIDGE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'jarvis-bridge')
const ENV_FILE = join(STATE_DIR, '.env')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })

// Load ~/.claude/channels/jarvis-bridge/.env into process.env. Real env wins.
// Same pattern as the telegram channel — plugin-spawned servers don't get an
// env block from Claude Code, so this is where the credentials live.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    // "Real env wins" — except Vercel's literal `[SENSITIVE]` placeholder,
    // which can leak into the ambient shell (e.g. from `vercel env pull`
    // done earlier in the same terminal) and is never a usable value.
    if (m && (process.env[m[1]] === undefined || process.env[m[1]] === '[SENSITIVE]')) {
      process.env[m[1]] = m[2]
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const BUCKET = 'jarvis-bridge'
const PREFIX = 'turns/'
const POLL_MS = Math.max(500, parseInt(process.env.JARVIS_BRIDGE_POLL_MS || '1500', 10))
const STALE_MS = 60 * 60 * 1000 // clean up abandoned turns after 1h regardless of status

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  process.stderr.write(
    `jarvis-bridge channel: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required\n` +
      `  set in ${ENV_FILE}\n` +
      `  format:\n    SUPABASE_URL=https://pgwoitbdiyubjugwufhk.supabase.co\n    SUPABASE_SERVICE_ROLE_KEY=eyJ...\n`,
  )
  process.exit(1)
}

process.on('unhandledRejection', err => {
  process.stderr.write(`jarvis-bridge channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`jarvis-bridge channel: uncaught exception: ${err}\n`)
})

type Turn = {
  status: 'pending' | 'delivered' | 'answered' | 'error'
  user_message: string
  reply_text?: string
  created_at: string
  delivered_at?: string
  answered_at?: string
}

function sb(path: string): string {
  return `${SUPABASE_URL}/storage/v1/${path}`
}
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  }
}

async function listTurns(): Promise<{ name: string }[]> {
  const res = await fetch(sb(`object/list/${BUCKET}`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: PREFIX, limit: 100, sortBy: { column: 'created_at', order: 'asc' } }),
  })
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as { name: string }[]
}

async function getTurn(id: string): Promise<Turn | null> {
  const res = await fetch(sb(`object/${BUCKET}/${PREFIX}${id}.json`), { headers: authHeaders() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`get failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Turn
}

async function putTurn(id: string, turn: Turn): Promise<void> {
  const res = await fetch(sb(`object/${BUCKET}/${PREFIX}${id}.json`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', 'x-upsert': 'true' }),
    body: JSON.stringify(turn),
  })
  if (!res.ok) throw new Error(`put failed: ${res.status} ${await res.text()}`)
}

async function deleteTurn(id: string): Promise<void> {
  await fetch(sb(`object/${BUCKET}/${PREFIX}${id}.json`), { method: 'DELETE', headers: authHeaders() }).catch(() => {})
}

const mcp = new Server(
  { name: 'jarvis-bridge', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      'Messages from the jarvis-bridge channel are Heath talking by voice through the Jarvis PWA (meetdossie.com/myjarvis) on his phone or desktop, transcribed to text before they reach you. They arrive as <channel source="jarvis-bridge" chat_id="...">.',
      '',
      'This is a live voice conversation, not a chat window Heath is reading — keep replies short and speakable (a few sentences, plain language), the way you would talk out loud, not a wall of markdown or a bulleted list. He will hear this read aloud by ElevenLabs TTS, not see it rendered. If the answer genuinely needs a list, a table, or something he needs to copy, say so briefly and note it will be easier to see on screen than to hear.',
      '',
      'Reply with the reply tool, passing chat_id back exactly as given in the inbound tag. Always call reply, even briefly ("On it, give me a sec" or "Done") — there is no other way for Heath to know you received the message; your transcript output never reaches him, only what you send through the tool.',
      '',
      'Only Heath reaches this channel. The Vercel endpoint that feeds it (api/jarvis-bridge-turn.js) checks his Supabase auth session and only accepts heath.shepard@kw.com before a message is ever written to the bucket this channel reads — you do not need to re-verify the sender.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Speak a reply back to Heath through Jarvis. Pass chat_id exactly as given in the inbound <channel> tag.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The turn id from the inbound <channel chat_id="..."> tag.' },
          text: { type: 'string', description: 'What to say back. Keep it short and speakable — this gets read aloud.' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const chat_id = String(args.chat_id ?? '').trim()
        const text = String(args.text ?? '')
        if (!chat_id) throw new Error('chat_id required')
        if (!text) throw new Error('text required')
        const existing = await getTurn(chat_id)
        if (!existing) throw new Error(`turn ${chat_id} not found — it may have expired or been cleaned up`)
        await putTurn(chat_id, {
          ...existing,
          status: 'answered',
          reply_text: text,
          answered_at: new Date().toISOString(),
        })
        return { content: [{ type: 'text', text: 'sent' }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())

// Without this, when Claude Code closes the MCP connection (session ends),
// this process would keep polling Supabase forever as a zombie.
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('jarvis-bridge channel: shutting down\n')
  setTimeout(() => process.exit(0), 500)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)

// ---- poll loop --------------------------------------------------------------
// seenPending dedups within this process's lifetime so a turn already
// delivered (or answered) this run doesn't get re-notified every tick.
const seen = new Set<string>()

async function tick(): Promise<void> {
  if (shuttingDown) return
  let entries: { name: string }[]
  try {
    entries = await listTurns()
  } catch (err) {
    process.stderr.write(`jarvis-bridge channel: list failed: ${err}\n`)
    return
  }

  for (const entry of entries) {
    const id = entry.name.replace(/\.json$/, '')
    if (seen.has(id)) continue

    let turn: Turn | null
    try {
      turn = await getTurn(id)
    } catch {
      continue
    }
    if (!turn) continue

    const createdMs = new Date(turn.created_at || 0).getTime()
    if (Date.now() - createdMs > STALE_MS) {
      seen.add(id)
      void deleteTurn(id)
      continue
    }

    if (turn.status !== 'pending') {
      if (turn.status === 'answered') seen.add(id)
      continue
    }

    seen.add(id) // claim before the await below so a slow response doesn't double-deliver
    try {
      await putTurn(id, { ...turn, status: 'delivered', delivered_at: new Date().toISOString() })
    } catch (err) {
      process.stderr.write(`jarvis-bridge channel: failed to mark delivered ${id}: ${err}\n`)
      seen.delete(id)
      continue
    }

    mcp
      .notification({
        method: 'notifications/claude/channel',
        params: {
          content: turn.user_message,
          meta: { chat_id: id, ts: turn.created_at },
        },
      })
      .catch(err => {
        process.stderr.write(`jarvis-bridge channel: failed to deliver inbound to Claude: ${err}\n`)
      })
  }
}

setInterval(() => {
  void tick()
}, POLL_MS)
void tick()

process.stderr.write(`jarvis-bridge channel: polling ${BUCKET}/${PREFIX} every ${POLL_MS}ms\n`)
