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
import { createClient, type RealtimeChannel } from '@supabase/supabase-js'
import { findYoutubeVideoId, buildYoutubeContextBlock } from './youtube-context.js'

const STATE_DIR = process.env.JARVIS_BRIDGE_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'jarvis-bridge')
const ENV_FILE = join(STATE_DIR, '.env')
// Same pattern as the telegram channel's inbox — inbound images land here as
// real files so this session can Read them directly.
const INBOX_DIR = join(STATE_DIR, 'inbox')

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 })

// Load ~/.claude/channels/jarvis-bridge/.env into process.env — THIS FILE
// always wins for the keys it defines, full stop.
//
// Originally this only filled in undefined/`[SENSITIVE]` slots ("real env
// wins"), on the assumption that whatever was already in process.env was a
// deliberate, trustworthy override. That assumption broke silently: Bun
// auto-loads `.env`/`.env.local` from its CWD before this script's first
// line ever runs, and when this process is spawned from the MeetDossie repo
// root (exactly what `.mcp.json`'s relative `scripts/jarvis-bridge/server.ts`
// path requires), Bun picks up the repo's `.env.local` — which has a stray
// SECOND `SUPABASE_SERVICE_ROLE_KEY=<your service role key from Vercel>`
// placeholder line further down the file. Standard dotenv last-line-wins
// semantics mean that placeholder silently clobbers the real key BEFORE this
// loop ever runs, `process.env.SUPABASE_SERVICE_ROLE_KEY` is neither
// undefined nor `[SENSITIVE]` (it's literally the placeholder string), so
// the old guard let it stand — every Storage call then failed with
// `403 Invalid Compact JWS`, silently, since nothing here surfaces to Heath
// except a stderr line in a process he isn't watching. Confirmed 2026-08-11
// while testing the image-cap raise: this is why the channel wasn't
// answering, unrelated to that fix. This file is dedicated, single-purpose,
// and curated correctly — it should never lose to whatever an unrelated
// ambient `.env.local` happens to auto-load.
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) process.env[m[1]] = m[2]
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
// Optional — only needed for the YouTube audio-transcription fallback path
// (youtube-context.ts Path B). Captions-only path (Path A) doesn't need it.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
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
  status: 'pending' | 'delivered' | 'working' | 'answered' | 'error'
  user_message: string
  reply_text?: string
  created_at: string
  delivered_at?: string
  // 'working' = an interim ack (reply called with final:false) — reply_text
  // holds the ack text, progress_at when it was sent. Non-terminal: the
  // client (api/jarvis-bridge-turn.js GET) keeps polling past this status,
  // unlike 'answered'. See the reply tool handler below.
  progress_at?: string
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
      'MANDATORY: call the reply tool at least once for every inbound message here, with chat_id set exactly as given in the tag — no exceptions for trivial, throwaway, or meta requests ("just say X back", "repeat this word"). Your transcript output is never seen or heard by Heath; reply is the ONLY channel back to him. Finishing your reasoning without calling reply means the turn is NOT done, even for a one-word answer.',
      '',
      'Long task (dispatching Carter/Atlas/etc)? Send a brief early ack with final:false ("On it, give me a sec") — Jarvis keeps listening on that same turn. When the real result is ready, call reply again on the SAME chat_id with final:true (or omit final) and the actual answer. Never leave a turn parked on an ack — the ack is not the answer, and Jarvis stops listening the moment you send final:true, so only send it when you mean it.',
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
        'REQUIRED: call this tool at least once for every jarvis-bridge turn, with NO exceptions for trivial, one-word, or meta requests ("just say X back", "repeat this word") — those still need a real reply call, not just transcript text. ' +
        'Nothing else you output reaches Heath; skipping this tool means total silence on his end, not a harmless no-op. ' +
        'Pass chat_id exactly as given in the inbound <channel chat_id="..."> tag. ' +
        'Set final:false for an early ack while you dispatch a background agent — Jarvis keeps polling that SAME turn (up to 9 min) instead of hanging up, and you can call reply again later on the same chat_id with the real answer. Only set final:true (or omit final — it defaults true) when you are done talking for this turn; that ends Jarvis\'s polling, so a second reply after that point goes nowhere.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'The turn id from the inbound <channel chat_id="..."> tag.' },
          text: { type: 'string', description: 'What to say back. Keep it short and speakable — this gets read aloud.' },
          final: { type: 'boolean', description: 'Default true. Set false for an interim ack so Jarvis keeps listening on this turn for a follow-up reply call with the real answer.' },
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
        const final = args.final === undefined ? true : Boolean(args.final)
        if (!chat_id) throw new Error('chat_id required')
        if (!text) throw new Error('text required')
        const existing = await getTurn(chat_id)
        if (!existing) throw new Error(`turn ${chat_id} not found — it may have expired or been cleaned up`)
        if (existing.status === 'answered') {
          // The turn already went final (Jarvis's poll loop already returned
          // and stopped listening on this chat_id) — writing here would be a
          // silent no-op from Heath's side. Tell the model instead of lying
          // with a bare 'sent'.
          throw new Error(
            `turn ${chat_id} already went final at ${existing.answered_at} — Jarvis stopped listening on this turn. ` +
              'Nothing you send now reaches Heath here; if this is new information, it needs Heath\'s next voice turn or another channel (Telegram/terminal).',
          )
        }
        // final:false — interim ack. Status 'working' is NOT terminal, so
        // Jarvis's client poll loop (api/jarvis-bridge-turn.js GET) keeps
        // waiting on this same turn_id instead of resolving and hanging up.
        await putTurn(chat_id, {
          ...existing,
          status: final ? 'answered' : 'working',
          reply_text: text,
          ...(final ? { answered_at: new Date().toISOString() } : { progress_at: new Date().toISOString() }),
        })
        return { content: [{ type: 'text', text: final ? 'sent' : 'sent (interim — turn stays open for a follow-up reply)' }] }
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

// ---- ambient DB-change awareness (Atlas, 2026-08-13) -----------------------
// Heath's ask: when he (or another agent) edits jarvis_balls/jarvis_todos
// directly — through the PWA UI, the DB, or a different agent's Supabase
// call — while this live session did NOT make the edit itself, does this
// session have any way to notice without being told in conversation? Before
// this, no: the poll loop above only reacts to jarvis-bridge Storage turns
// (Heath talking), and this session's only path to jarvis_balls/jarvis_todos
// was the separate `supabase` MCP server, queried on-demand. A change made
// outside that server was invisible here until/unless a later turn happened
// to re-query the same row.
//
// Both tables are ALREADY in the `supabase_realtime` Postgres publication
// (see supabase/migrations/20260812_jarvis_{balls,todos}.sql — added so the
// PWA's own browser tab can live-update the HUD) and the service-role key
// this process already loads is sufficient to subscribe directly with
// @supabase/supabase-js's realtime client — confirmed working end-to-end
// tonight (Bun process, external REST insert -> event received in <10ms).
// No migration, no new secret, no new table needed.
//
// What this does: on every INSERT/UPDATE/DELETE to jarvis_balls or
// jarvis_todos, push a `notifications/claude/channel` note into THIS live
// session's context — same delivery mechanism already used for inbound
// Heath turns and the reply-reliability nudges above, just with no chat_id
// (there's no voice turn to answer; the model should NOT call `reply` for
// these, there's nothing to reply to). This makes an external edit show up
// in the model's actual context within about a second of Heath making it,
// so next time he opens a turn, Jarvis already knows — without Heath having
// said a word about it in conversation.
//
// Known, deliberate limitation: this does NOT make Jarvis speak unprompted.
// The only outbound path today is the `reply` tool tied to an open Storage
// turn (a voice/text turn Heath initiated) — there is no push-to-phone /
// service-worker-push / always-listening-speaker path, so "notices instantly
// in its context" and "says something out loud with nobody asking" are two
// different features. This ships the first. The second is a real, separate,
// bigger build (Web Push API + VAPID keys + SW push handler + a UI
// permission grant) — flagged for Heath, not attempted tonight.
//
// Self-write noise: this session's OWN writes to these tables (via the
// separate `supabase` MCP server) also flow through Postgres and will also
// fire a realtime event here — there is no reliable way to tag "who wrote
// this row" without adding an actor column the schema deliberately omits
// (see the tables' own doc comments: kept plain on purpose so a generic LLM
// MCP write never has to know about a bookkeeping column). The notification
// text below says so explicitly so the model can recognize "that's the edit
// I just made" and not treat it as news.
const REALTIME_TABLES = ['jarvis_balls', 'jarvis_todos'] as const
const realtimeClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  realtime: { params: { eventsPerSecond: 5 } },
})
let realtimeChannel: RealtimeChannel | null = null

// Confirmed 2026-08-13, AFTER setting REPLICA IDENTITY FULL on both tables
// (api/admin-jarvis-realtime-replica-identity.js): FULL fixes UPDATE's `old`
// payload (was PK-only, now the complete pre-image — verified live), but
// Supabase Realtime's DELETE event still only ever carries the row's
// primary key in `old`, replica identity or not. That's Realtime server
// behavior, not a Postgres/replica-identity limitation this project can
// configure away — DELETE payloads are deliberately minimal upstream. Net
// effect: this can say a to-do/ball with a given id was deleted, and give
// the id for a manual lookup if it still matters, but not what it *was*
// called. Degrade honestly instead of printing "undefined".
function summarizeChange(table: string, eventType: string, oldRow: Record<string, unknown>, newRow: Record<string, unknown>): string {
  if (table === 'jarvis_todos') {
    if (eventType === 'INSERT') return `new to-do added: "${newRow.title}"${newRow.detail ? ` — ${newRow.detail}` : ''}`
    if (eventType === 'DELETE') {
      return oldRow.title
        ? `to-do removed: "${oldRow.title}"`
        : `a to-do was removed (id ${oldRow.id ?? 'unknown'}) — Supabase Realtime doesn't include the row's title on DELETE, only its id`
    }
    if (newRow.done === true && oldRow.done !== true) return `to-do marked done: "${newRow.title}"`
    if (newRow.done === false && oldRow.done === true) return `to-do re-opened: "${newRow.title}"`
    if (oldRow.title !== newRow.title || oldRow.detail !== newRow.detail) {
      return `to-do edited: "${oldRow.title}" -> title: "${newRow.title}"${newRow.detail ? `, detail: "${newRow.detail}"` : ''}`
    }
    return `to-do row updated (no visible field change — likely a timestamp-only touch): "${newRow.title}"`
  }
  if (table === 'jarvis_balls') {
    if (eventType === 'INSERT') return `new ball added: "${newRow.name}" (${newRow.business_tag}) — court: ${newRow.court}${newRow.status_note ? `, note: ${newRow.status_note}` : ''}`
    if (eventType === 'DELETE') {
      return oldRow.name
        ? `ball closed/removed: "${oldRow.name}"`
        : `a ball was closed/removed (id ${oldRow.id ?? 'unknown'}) — Supabase Realtime doesn't include the row's name on DELETE, only its id`
    }
    const courtChanged = oldRow.court !== newRow.court
    const noteChanged = oldRow.status_note !== newRow.status_note
    if (!courtChanged && !noteChanged) return `ball row updated (no visible field change): "${newRow.name}"`
    return `ball "${newRow.name}" updated:${courtChanged ? ` court ${oldRow.court} -> ${newRow.court};` : ''}${noteChanged ? ` note: ${newRow.status_note ?? '(cleared)'}` : ''}`
  }
  return `${table} row ${eventType.toLowerCase()}`
}

function subscribeRealtime(): void {
  realtimeChannel = realtimeClient.channel('jarvis-bridge:ambient-db-changes')
  for (const table of REALTIME_TABLES) {
    realtimeChannel.on(
      'postgres_changes' as never,
      { event: '*', schema: 'public', table } as never,
      (payload: { eventType: string; new: Record<string, unknown>; old: Record<string, unknown> }) => {
        const summary = summarizeChange(table, payload.eventType, payload.old ?? {}, payload.new ?? {})
        // Skip pure no-op notices (e.g. a touch-trigger re-save with nothing
        // actually different) — not worth cluttering the session's context.
        if (summary.includes('no visible field change')) return
        process.stderr.write(`jarvis-bridge channel: ambient DB change [${table}] ${summary}\n`)
        mcp
          .notification({
            method: 'notifications/claude/channel',
            params: {
              content:
                `[ambient DB change — public.${table}, NOT a voice turn, no reply needed] ${summary}\n\n` +
                `This table was just changed outside this conversation (could be Heath editing directly through the Jarvis PWA UI, another agent, or your OWN just-made write showing back up here — there's no way to tell which from this event alone). ` +
                `Do NOT call the reply tool for this — there is no chat_id/open turn to answer. If this matches something you just did in this same conversation, no action needed. If it's new to you, just fold it into what you know; naturally mention it unprompted next time Heath actually talks to you, if relevant — don't wait for him to ask.`,
              // row_id lets the model correlate a later DELETE (whose old
              // record is id-only, see summarizeChange above) back to an
              // earlier INSERT/UPDATE it saw for the same row — confirmed
              // useful live 2026-08-13, the model asked for exactly this
              // after an INSERT+DELETE round trip left it unable to tell
              // whether a delete matched something it had just seen created.
              meta: { source_table: table, ambient: 'true', event_type: payload.eventType, row_id: String(payload.new?.id ?? payload.old?.id ?? '') },
            },
          })
          .catch(err => {
            process.stderr.write(`jarvis-bridge channel: ambient notify failed for ${table}: ${err}\n`)
          })
      },
    )
  }
  realtimeChannel.subscribe(status => {
    process.stderr.write(`jarvis-bridge channel: realtime ambient-awareness subscription status: ${status}\n`)
    if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !shuttingDownRef.value) {
      // realtime-js retries internally for transient network blips, but a
      // hard CLOSED/error can leave it dead — rebuild the subscription from
      // scratch after a short delay rather than silently going deaf.
      process.stderr.write('jarvis-bridge channel: rebuilding realtime subscription in 5s\n')
      try {
        realtimeClient.removeChannel(realtimeChannel!)
      } catch {}
      setTimeout(subscribeRealtime, 5000)
    }
  })
}

// Plain object (not `let shuttingDown` directly) so subscribeRealtime's
// closure above — defined before `shuttingDown` exists below — can read the
// live value at call time instead of capturing `false` forever.
const shuttingDownRef = { value: false }
subscribeRealtime()

// Without this, when Claude Code closes the MCP connection (session ends),
// this process would keep polling Supabase forever as a zombie.
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  shuttingDownRef.value = true
  process.stderr.write('jarvis-bridge channel: shutting down\n')
  try {
    if (realtimeChannel) realtimeClient.removeChannel(realtimeChannel)
  } catch {}
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
      // NOTE: deliveredAt (used by the reply-reliability nudge below) is
      // intentionally NOT set here. Marking the Storage object 'delivered'
      // immediately is what keeps Jarvis's phone-side poll from showing a
      // false "Cole isn't listening" (api/jarvis-bridge-turn.js's
      // PICKUP_TIMEOUT_MS=20s watches turn.status, not the notification).
      // But if this message contains a YouTube link, buildYoutubeContextBlock
      // below can take 10-60s (headless browser + possible audio-STT
      // fallback) BEFORE the model ever sees the turn — starting the
      // reply-nudge clock now would fire a "you haven't replied" nudge for a
      // turn the model hasn't been notified of yet. deliveredAt is set right
      // before the actual notification() call instead, a few lines down.

      let contentToDeliver = turn.user_message
      const yt = findYoutubeVideoId(turn.user_message)
      if (yt) {
        try {
          const ytBlock = await buildYoutubeContextBlock(turn.user_message, ELEVENLABS_API_KEY)
          if (ytBlock) contentToDeliver = `${turn.user_message}\n\n${ytBlock}`
        } catch (err) {
          process.stderr.write(`jarvis-bridge channel: youtube context build failed for ${id}: ${err}\n`)
        }
      }

      deliveredAt.set(id, Date.now())
      // Now that deliveredAt is set (and the model is about to actually be
      // notified), release the in-flight guard so the watchdog below can
      // time this turn normally on future ticks.
      delivering.delete(id)
      mcp
        .notification({
          method: 'notifications/claude/channel',
          params: {
            content: contentToDeliver,
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

    // status === 'delivered' — reply-reliability watchdog. Skipped while
    // `delivering` still holds this id — that means another in-progress tick
    // is still building enriched content (e.g. a YouTube transcript) for it
    // and hasn't actually notified the model yet; deliveredAt isn't set until
    // that notification fires, so timing off turn.delivered_at here would
    // nudge for a turn the model was never shown.
    if (turn.status === 'delivered' && !nudged.has(id) && !delivering.has(id)) {
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

    // status === 'working' — same reply-reliability problem, later stage: the
    // model sent an interim ack (final:false) but never came back with the
    // final answer once its background agent finished. Distinct nudge key
    // (`${id}:final`) so this doesn't collide with the 'delivered' nudge
    // above, and a longer delay — background work is expected to take a
    // while, a quick nudge here would just be noise.
    const FINAL_NUDGE_DELAY_MS = Math.max(NUDGE_DELAY_MS, parseInt(process.env.JARVIS_BRIDGE_FINAL_NUDGE_MS || '180000', 10))
    if (turn.status === 'working' && !nudged.has(`${id}:final`)) {
      const progressMs = new Date(turn.progress_at || turn.delivered_at || turn.created_at || 0).getTime()
      if (Date.now() - progressMs > FINAL_NUDGE_DELAY_MS) {
        nudged.add(`${id}:final`)
        const waitedS = Math.round((Date.now() - progressMs) / 1000)
        process.stderr.write(`jarvis-bridge channel: final-nudge ${id} — still 'working' after ${waitedS}s\n`)
        mcp
          .notification({
            method: 'notifications/claude/channel',
            params: {
              content:
                `[reply reminder] Turn "${id}" has been sitting on your interim ack ("${turn.reply_text || ''}") for ${waitedS}s with no final reply — ` +
                `Heath is still staring at that ack with nothing since. If your background agent/work for this is done (check for a finished result or memory write), call reply now with chat_id="${id}", final:true, and the real answer. If it's genuinely still running, call reply again with final:false and a short status update so Heath knows it's alive. Original message: ${turn.user_message}`,
              meta: { chat_id: id, ts: turn.created_at, nudge: 'true' },
            },
          })
          .catch(err => {
            process.stderr.write(`jarvis-bridge channel: final-nudge notify failed for ${id}: ${err}\n`)
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
