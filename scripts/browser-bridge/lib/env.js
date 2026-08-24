/**
 * Minimal, dependency-free .env-style loader shared by bridge-client.js
 * (runs under WSL/bun against the repo's .env.local) and the Windows-side
 * native host (runs against %USERPROFILE%\.browser-bridge\.env).
 *
 * Not using the `dotenv` package on purpose -- it isn't actually installed
 * in this repo's node_modules despite a couple of scripts requiring it
 * (confirmed 2026-08-24), and pulling in a new dependency for two KEY=VALUE
 * lines is more than this needs. Handles the two real footguns already hit
 * elsewhere in this repo: CRLF line endings (.env.local is CRLF, see
 * env-local-bom-breaks-first-var.md) and duplicate keys, where the LAST
 * occurrence should win (mirrors how `source`/dotenv itself behaves, and
 * matches the repo's existing pattern of a `[SENSITIVE]` placeholder line
 * followed by the real value further down the same file).
 */
const fs = require('fs')

function loadEnvFile(path) {
  const out = {}
  let raw
  try {
    raw = fs.readFileSync(path, 'utf8')
  } catch {
    return out
  }
  // Strip a leading UTF-8 BOM if present -- confirmed root cause of a past
  // "first var silently dead" bug in this exact file.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.replace(/\r$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([\w.-]+)=(.*)$/)
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[m[1]] = val // last occurrence wins, same as dotenv/shell source
  }
  return out
}

module.exports = { loadEnvFile }
