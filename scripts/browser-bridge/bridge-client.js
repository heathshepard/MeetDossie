#!/usr/bin/env node
/**
 * browser-bridge client -- what THIS Claude Code session runs (via the Bash
 * tool) to act inside Heath's real, logged-in Chrome tab.
 *
 * Transport: same proven shape as scripts/jarvis-bridge/server.ts -- a
 * private Supabase Storage bucket (`browser-bridge`, separate from
 * `jarvis-bridge`'s bucket since this is a different interaction shape:
 * one-shot action requests/results, not conversational turns), one JSON
 * object per command at commands/<id>.json. This process only ever makes
 * outbound HTTPS calls to Supabase -- no exposed port, works through
 * NAT/firewalls, same as everything else in this repo.
 *
 * Flow:
 *   1. This script writes commands/<id>.json = {status:"pending", action, params, created_at}.
 *   2. The Windows-side native host (native-host/host.js), spawned by Chrome
 *      when the extension connects, polls the same bucket, claims the
 *      command, and relays it to the extension's background service worker
 *      over the native messaging stdio channel.
 *   3. Read-only actions (navigate/snapshot/screenshot) execute immediately
 *      in the armed tab. State-changing actions (click/type) queue in the
 *      extension popup for Heath's explicit Approve/Reject click.
 *   4. The extension sends the result back over stdio; the host writes it
 *      onto the same commands/<id>.json object as status:"done"/"error".
 *   5. This script polls for that terminal status and prints the result as
 *      JSON on stdout.
 *
 * Usage:
 *   node scripts/browser-bridge/bridge-client.js <action> '<json-params>' [--timeout-ms N]
 *
 * Actions: navigate {url}, snapshot {}, screenshot {}, click {selector},
 * type {selector, text}, status {} (checks armed/connection state without
 * queuing any page action).
 *
 * Credentials: reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from this
 * repo's .env.local (same values jarvis-bridge already uses) via
 * lib/env.js -- no separate secret needed on the WSL side.
 */
const crypto = require('crypto')
const path = require('path')
const { loadEnvFile } = require('./lib/env')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const envFromFile = loadEnvFile(path.join(REPO_ROOT, '.env.local'))
// Vercel's `[SENSITIVE]` placeholder can leak into the ambient shell env
// (confirmed 2026-08-24 -- this exact session had SUPABASE_URL="[SENSITIVE]"
// pre-set), so an ambient var equal to that literal string must NOT shadow
// the real value in .env.local. Treat it as absent, not as a fatal value.
const envSupabaseUrl = process.env.SUPABASE_URL && process.env.SUPABASE_URL !== '[SENSITIVE]' ? process.env.SUPABASE_URL : undefined
const envServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY !== '[SENSITIVE]' ? process.env.SUPABASE_SERVICE_ROLE_KEY : undefined
const SUPABASE_URL = envSupabaseUrl || envFromFile.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = envServiceRoleKey || envFromFile.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || SUPABASE_URL === '[SENSITIVE]') {
  console.error('browser-bridge client: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not resolvable from .env.local')
  process.exit(1)
}

const BUCKET = 'browser-bridge'
const PREFIX = 'commands/'

function sb(p) {
  return `${SUPABASE_URL}/storage/v1/${p}`
}
function authHeaders(extra) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(extra || {}),
  }
}
function bust(url) {
  return `${url}${url.includes('?') ? '&' : '?'}_cb=${Date.now()}`
}

async function putCommand(id, obj) {
  const res = await fetch(sb(`object/${BUCKET}/${PREFIX}${id}.json`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': 'no-cache, no-store, max-age=0, must-revalidate' }),
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`put failed: ${res.status} ${await res.text()}`)
}

async function getCommand(id) {
  const res = await fetch(bust(sb(`object/${BUCKET}/${PREFIX}${id}.json`)), {
    headers: authHeaders({ 'Cache-Control': 'no-cache' }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`get failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

async function main() {
  const [, , action, paramsJson, ...rest] = process.argv
  if (!action) {
    console.error('usage: bridge-client.js <action> [json-params] [--timeout-ms N]')
    process.exit(1)
  }
  let params = {}
  if (paramsJson && !paramsJson.startsWith('--')) {
    try {
      params = JSON.parse(paramsJson)
    } catch (err) {
      console.error(`invalid JSON params: ${err.message}`)
      process.exit(1)
    }
  }
  const timeoutIdx = rest.indexOf('--timeout-ms')
  // Default 90s: read actions resolve in a couple seconds, but click/type
  // sit waiting on Heath's popup Approve/Reject click, which can genuinely
  // take a while if he's away from the keyboard.
  const timeoutMs = timeoutIdx >= 0 ? parseInt(rest[timeoutIdx + 1], 10) : 90000

  const id = crypto.randomUUID()
  await putCommand(id, { status: 'pending', action, params, created_at: new Date().toISOString() })

  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 1000))
    const cmd = await getCommand(id).catch(() => null)
    if (!cmd) continue
    if (cmd.status === 'done') {
      console.log(JSON.stringify({ ok: true, result: cmd.result }, null, 2))
      return
    }
    if (cmd.status === 'error') {
      console.log(JSON.stringify({ ok: false, error: cmd.error }, null, 2))
      process.exitCode = 1
      return
    }
    // pending / dispatched -- keep waiting
  }
  console.log(JSON.stringify({ ok: false, error: `timed out after ${timeoutMs}ms waiting for the native host / extension to pick this up -- is the extension armed and Chrome running with the native host registered?`, command_id: id }, null, 2))
  process.exitCode = 1
}

main().catch(err => {
  console.error('browser-bridge client: fatal:', err)
  process.exit(1)
})
