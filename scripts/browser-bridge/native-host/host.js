#!/usr/bin/env node
/**
 * Cole Browser Bridge -- native messaging host.
 *
 * Runs on Windows (spawned BY Chrome, not by Heath directly) the moment the
 * extension's background service worker calls chrome.runtime.connectNative.
 * Chrome owns this process's lifecycle: it launches it when the port opens
 * and kills it (closes stdin) when the port disconnects -- that is standard,
 * documented Chrome Native Messaging behavior
 * (https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
 * not a security bypass. This process's own job while alive:
 *
 *   1. Speak Chrome's native messaging stdio protocol to the extension
 *      (4-byte little-endian length prefix + UTF-8 JSON, both directions).
 *   2. Poll the `browser-bridge` Supabase Storage bucket for commands Cole
 *      (the WSL-side bridge-client.js) queued as commands/<id>.json,
 *      status:"pending".
 *   3. Forward each one to the extension as {type:"command", command}.
 *   4. Wait for the matching {type:"result", command_id, ok, result, error}
 *      back from the extension, then write the terminal status back onto
 *      the same Storage object so bridge-client.js's poll loop sees it.
 *
 * Nothing here ever listens on a network port -- outbound HTTPS to
 * Supabase only, same trust boundary as scripts/jarvis-bridge/server.ts.
 *
 * Credentials: %USERPROFILE%\.browser-bridge\.env (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY) -- written by install-native-host.ps1, which
 * copies the already-configured jarvis-bridge values rather than asking
 * Heath to paste secrets into a new place.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { loadEnvFile } = require('../lib/env')

const STATE_DIR = path.join(os.homedir(), '.browser-bridge')
try {
  fs.mkdirSync(STATE_DIR, { recursive: true })
} catch {}

const LOG_FILE = path.join(STATE_DIR, 'host.log')
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`
  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

const envFromFile = loadEnvFile(path.join(STATE_DIR, '.env'))
const SUPABASE_URL = process.env.SUPABASE_URL || envFromFile.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || envFromFile.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  log('FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing --', STATE_DIR + '\\.env not found or incomplete')
  process.exit(1)
}

const BUCKET = 'browser-bridge'
const PREFIX = 'commands/'
const POLL_MS = 1500

function sb(p) {
  return `${SUPABASE_URL}/storage/v1/${p}`
}
function authHeaders(extra) {
  return { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, ...(extra || {}) }
}
function bust(url) {
  return `${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now()}`
}

async function listCommands() {
  const res = await fetch(sb(`object/list/${BUCKET}`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: PREFIX, limit: 50, sortBy: { column: 'created_at', order: 'asc' } }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`)
  return await res.json()
}
async function getCommandObj(id) {
  const res = await fetch(bust(sb(`object/${BUCKET}/${PREFIX}${id}.json`)), {
    headers: authHeaders({ 'Cache-Control': 'no-cache' }),
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`get failed: ${res.status} ${await res.text()}`)
  return await res.json()
}
async function putCommandObj(id, obj) {
  const res = await fetch(sb(`object/${BUCKET}/${PREFIX}${id}.json`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': 'no-cache, no-store, max-age=0, must-revalidate' }),
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`put failed: ${res.status} ${await res.text()}`)
}

// ---- Chrome native messaging stdio protocol --------------------------------

function sendToExtension(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(json.length, 0)
  process.stdout.write(header)
  process.stdout.write(json)
}

let stdinBuffer = Buffer.alloc(0)
const pendingByCommandId = new Map() // command_id -> resolve(resultMsg)

function onStdinData(chunk) {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk])
  while (true) {
    if (stdinBuffer.length < 4) return
    const len = stdinBuffer.readUInt32LE(0)
    if (stdinBuffer.length < 4 + len) return
    const jsonBuf = stdinBuffer.slice(4, 4 + len)
    stdinBuffer = stdinBuffer.slice(4 + len)
    let msg
    try {
      msg = JSON.parse(jsonBuf.toString('utf8'))
    } catch (err) {
      log('bad JSON from extension:', err.message)
      continue
    }
    handleExtensionMessage(msg)
  }
}

function handleExtensionMessage(msg) {
  log('from extension:', msg)
  if (msg && msg.type === 'result' && msg.command_id) {
    const resolve = pendingByCommandId.get(msg.command_id)
    if (resolve) {
      pendingByCommandId.delete(msg.command_id)
      resolve(msg)
    }
  }
}

process.stdin.on('data', onStdinData)
process.stdin.on('end', () => {
  log('stdin closed -- Chrome disconnected the port, exiting')
  process.exit(0)
})

// ---- poll loop --------------------------------------------------------------

const claimed = new Set()
const RESULT_TIMEOUT_MS = 6 * 60 * 1000 // generous -- click/type wait on Heath's popup approval

async function dispatchOne(id, cmd) {
  claimed.add(id)
  try {
    await putCommandObj(id, { ...cmd, status: 'dispatched', dispatched_at: new Date().toISOString() })
  } catch (err) {
    log('failed to mark dispatched', id, String(err))
    claimed.delete(id)
    return
  }

  const resultPromise = new Promise(resolve => {
    pendingByCommandId.set(id, resolve)
    setTimeout(() => {
      if (pendingByCommandId.has(id)) {
        pendingByCommandId.delete(id)
        resolve({ type: 'result', command_id: id, ok: false, error: `no response from extension within ${RESULT_TIMEOUT_MS}ms -- is it armed and connected?` })
      }
    }, RESULT_TIMEOUT_MS)
  })

  sendToExtension({ type: 'command', command: { id, action: cmd.action, params: cmd.params || {} } })

  const result = await resultPromise
  try {
    await putCommandObj(id, {
      ...cmd,
      status: result.ok ? 'done' : 'error',
      result: result.ok ? result.result : undefined,
      error: result.ok ? undefined : result.error,
      completed_at: new Date().toISOString(),
    })
  } catch (err) {
    log('failed to write final result for', id, String(err))
  }
}

async function tick() {
  let entries
  try {
    entries = await listCommands()
  } catch (err) {
    log('list failed:', String(err))
    return
  }
  for (const entry of entries) {
    const id = entry.name.replace(/\.json$/, '')
    if (claimed.has(id)) continue
    let cmd
    try {
      cmd = await getCommandObj(id)
    } catch {
      continue
    }
    if (!cmd || cmd.status !== 'pending') continue
    void dispatchOne(id, cmd)
  }
}

log('native host started, pid', process.pid)
setInterval(() => {
  void tick()
}, POLL_MS)
void tick()
