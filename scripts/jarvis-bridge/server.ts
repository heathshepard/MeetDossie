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
// Same pattern as the telegram channel's inbox — inbound images land here as
// real files so this session can Read them directly.
const INBOX_DIR = join(STATE_DIR, 'inbox')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

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
  // Optional inbound image (Jarvis chat attach button). Sent as base64 by
  // api/jarvis-bridge-turn.js — this process decodes it to a local file on
  // delivery (see deliverTurn) and strips it from the object afterward so
  // the blob isn't re-uploaded on every subsequent status write.
  image_base64?: string
  image_media_type?: string
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

// Confirmed 2026-08-10: Supabase Storage's object GET is served through a
// CDN edge cache that does NOT reliably respect a fresh upload for anywhere
// from several seconds up to ~90s, regardless of the cache-control we send —
// a real write can read back stale on the exact same URL long after it
// landed. Cache-bust every read with a throwaway query param (the object
// path/identity is unaffected; Storage ignores unknown query params for
// resolving the object, but a CDN keying on full URL treats it as a fresh
// entry) and mark uploads no-store so nothing legitimately caches them.
function bust(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now()}`
}

async function getTurn(id: string): Promise<Turn | null> {
  const res = await fetch(bust(sb(`object/${BUCKET}/${PREFIX}${id}.json`)), {
    headers: authHeaders({ 'Cache-Control': 'no-cache' }),
    cache: 'no-store',
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`get failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as Turn
}

async function putTurn(id: string, turn: Turn): Promise<void> {
  const res = await fetch(sb(`object/${BUCKET}/${PREFIX}${id}.json`), {
    method: 'POST',
    headers: authHeaders({
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
    }),
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
    // Kept under ~2000 chars deliberately — Claude Code silently truncates
    // MCP server `instructions` at 2048 chars (confirmed via debug log:
    // "Server instructions truncated from 2376 to 2048 chars" when an
    // earlier, more verbose draft of this text quietly lost its last
    // paragraph). If you extend this, re-check the length stays well clear
    // of that cap — a silent truncation here is exactly the kind of bug
    // that would re-introduce the reply-reliability problem this text
    // exists to fix.
    instructions: [
      'Messages from the jarvis-bridge channel are Heath talking by voice through the Jarvis PWA (meetdossie.com/myjarvis), transcribed to text before they reach you. They arrive as <channel source="jarvis-bridge" chat_id="...">. If the tag has an image_path attribute, Read that file — a photo Heath attached through the Jarvis UI.',
      '',
      "This is a live voice conversation, not a chat window Heath is reading — keep replies short and speakable (a few sentences, plain language), not a wall of markdown or a bulleted list. He hears this read aloud by ElevenLabs TTS, never sees it rendered. If the answer genuinely needs a list/table/something to copy, say so briefly and note it's easier to see on screen than to hear.",
      '',
      'MANDATORY: call the reply tool exactly once for every inbound message here, with chat_id set exactly as given in the tag — no exceptions for trivial, throwaway, or meta requests ("just say X back", "repeat this word"). Your transcript output is never seen or heard by Heath; reply is the ONLY channel back to him. Finishing your reasoning without calling reply means the turn is NOT done, even for a one-word answer.',
      '',
      'Long task (dispatching Carter/Atlas/etc)? You still only get one reply per turn — send a brief early ack ("On it, give me a sec") or wait for the final result, but never go silent while you work.',
      '',
      'If a later <channel> message is tagged as a reply reminder for a chat_id you already saw, your first pass dropped the reply call — call reply immediately with your best answer, don\'t second-guess whether it\'s "worth" one.',
      '',
      'Only Heath reaches this channel. api/jarvis-bridge-turn.js checks his Supabase auth session and only accepts heath.shepard@kw.com before a message is ever written here — you do not need to re-verify the sender.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send your answer back to Heath through Jarvis (spoken aloud by TTS). ' +
        'REQUIRED: call this tool exactly once for every jarvis-bridge turn, with NO exceptions for trivial, one-word, or meta requests ("just say X back", "repeat this word") — those still need a real reply call, not just transcript text. ' +
        'Nothing else you output reaches Heath; skipping this tool means total silence on his end, not a harmless no-op. ' +
        'Pass chat_id exactly as given in the inbound <channel chat_id="..."> tag.',
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

// Inbound image handling — mirrors the telegram channel's inbox pattern
// (~/.claude/channels/telegram/inbox/<ts>-<id>.<ext>, referenced via
// meta.image_path so the receiving session Reads it directly). The Jarvis
// chat attach button already resizes to <=1024px and base64-encodes
// client-side (jarvis-pwa.html resizeImageForVision) before it ever reaches
// api/jarvis-bridge-turn.js, so decoding here is cheap.
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function writeInboundImage(id: string, base64: string, mediaType: string | undefined): string | undefined {
  try {
    const ext = EXT_BY_MIME[(mediaType || '').toLowerCase()] || 'jpg'
    const path = join(INBOX_DIR, `${Date.now()}-${id}.${ext}`)
    writeFileSync(path, Buffer.from(base64, 'base64'))
    return path
  } catch (err) {
    process.stderr.write(`jarvis-bridge channel: failed to write inbound image for ${id}: ${err}\n`)
    return undefined
  }
}

// ---- poll loop --------------------------------------------------------------
// `answered` is a terminal dedup — once a turn is confirmed answered (or
// expired/errored) this process never looks at it again. `delivering` guards
// against re-claiming a still-pending turn mid-flight. `deliveredAt` +
// `nudged` back the reply-reliability watchdog below: the model occasionally
// (observed ~2/5 in early testing, concentrated on trivial/meta prompts —
// "just repeat this word") reasons about a channel turn without ever
// invoking the `reply` tool, since nothing in the channel/MCP spec can force
// a tool call for an injected notification (channel content lands as a
// normal prompt turn with ordinary auto tool_choice — confirmed against the
// compiled CLI, no tool_choice override exists for channel-origin turns).
// The only real fix available is a runtime safety net: if a turn sits
// "delivered" without flipping to "answered" for NUDGE_DELAY_MS, re-inject a
// second notification explicitly telling the session to call reply now for
// that chat_id. This recovers a dropped reply within seconds instead of
// leaving Jarvis to time out after 9 minutes.
const answered = new Set<string>()
const delivering = new Set<string>()
const deliveredAt = new Map<string, number>()
const nudged = new Set<string>()
const NUDGE_DELAY_MS = Math.max(10000, parseInt(process.env.JARVIS_BRIDGE_NUDGE_MS || '45000', 10))

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
    if (answered.has(id)) continue

    let turn: Turn | null
    try {
      turn = await getTurn(id)
    } catch {
      continue
    }
    if (!turn) continue

    const createdMs = new Date(turn.created_at || 0).getTime()
    if (Date.now() - createdMs > STALE_MS) {
      answered.add(id)
      void deleteTurn(id)
      continue
    }

    if (turn.status === 'answered' || turn.status === 'error') {
      answered.add(id)
      continue
    }

    if (turn.status === 'pending') {
      if (delivering.has(id)) continue // already claimed this run, put() in flight
      delivering.add(id)

      const imagePath = turn.image_base64 ? writeInboundImage(id, turn.image_base64, turn.image_media_type) : undefined
      // Strip the (potentially large) base64 blob before writing back — it's
      // already on disk locally, no reason to keep re-uploading it to
      // Storage on every subsequent status write (delivered, then answered).
      const { image_base64: _img, image_media_type: _mime, ...turnWithoutImage } = turn

      try {
        await putTurn(id, { ...turnWithoutImage, status: 'delivered', delivered_at: new Date().toISOString() })
      } catch (err) {
        process.stderr.write(`jarvis-bridge channel: failed to mark delivered ${id}: ${err}\n`)
        delivering.delete(id)
        continue
      }
      deliveredAt.set(id, Date.now())

      mcp
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content: turn.user_message,
            meta: {
              chat_id: id,
              ts: turn.created_at,
              ...(imagePath ? { image_path: imagePath } : {}),
            },
          },
        })
        .catch(err => {
          process.stderr.write(`jarvis-bridge channel: failed to deliver inbound to Claude: ${err}\n`)
        })
      continue
    }

    // status === 'delivered' — reply-reliability watchdog.
    if (turn.status === 'delivered' && !nudged.has(id)) {
      const deliveredMs = deliveredAt.get(id) ?? new Date(turn.delivered_at || turn.created_at || 0).getTime()
      if (Date.now() - deliveredMs > NUDGE_DELAY_MS) {
        nudged.add(id)
        const waitedS = Math.round((Date.now() - deliveredMs) / 1000)
        process.stderr.write(`jarvis-bridge channel: nudging ${id} — no reply after ${waitedS}s\n`)
        mcp
          .notification({
            method: 'notifications/claude/channel',
            params: {
              content:
                `[reply reminder] You have NOT called the reply tool yet for this turn, sent ${waitedS}s ago — ` +
                `Heath has heard nothing so far. Call reply now with chat_id="${id}" and your best answer, even if brief. ` +
                `Original message: ${turn.user_message}`,
              meta: { chat_id: id, ts: turn.created_at, nudge: 'true' },
            },
          })
          .catch(err => {
            process.stderr.write(`jarvis-bridge channel: nudge notify failed for ${id}: ${err}\n`)
          })
      }
    }
  }
}

setInterval(() => {
  void tick()
}, POLL_MS)
void tick()

process.stderr.write(`jarvis-bridge channel: polling ${BUCKET}/${PREFIX} every ${POLL_MS}ms\n`)
