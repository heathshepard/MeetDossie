#!/usr/bin/env node
/**
 * env-local.js — find and load .env.local, including from a git worktree.
 *
 * ===================================================================
 * THE SILENT FAILURE THIS FIXES
 * ===================================================================
 * edit.js and audio-chain.js both resolved .env.local as
 * `path.join(__dirname, '..', '..', '.env.local')` — the repo root.
 *
 * `.env.local` is gitignored, so it exists ONLY in the main checkout. Every
 * git worktree under .claude/worktrees/ has no copy. Agents run isolated in
 * worktrees. So inside a worktree the file is simply not there, the key is
 * never loaded, and detectIsolationPermission() returns
 *   { status: 'error', reason: 'no usable ELEVENLABS_API_KEY in this environment' }
 * which isolationPrePass() dutifully treats as "isolation unavailable" and
 * falls back to the EQ chain — logging a warning nobody reads and producing
 * a video with raw room tone.
 *
 * That is almost certainly why no render ever used Audio Isolation despite
 * the feature being fully implemented: not a bug in the isolation code, a
 * bug in where the key was looked for.
 *
 * Resolution order:
 *   1. an explicit path argument
 *   2. walking up from __dirname (covers a normal checkout)
 *   3. the MAIN worktree's root, via `git rev-parse --path-format=absolute
 *      --git-common-dir` — .git/worktrees/<name>/.. is the main checkout
 *   4. $MEETDOSSIE_ROOT, if set
 *
 * Never logs a value. Reports only which PATH was used and which NAMES were
 * set, because a "key not found" that prints nothing is how this hid.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function candidates(explicit) {
  const out = [];
  if (explicit) out.push(explicit);

  // Walk up from this file.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    out.push(path.join(dir, '.env.local'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  // The main worktree, when we are running inside a linked worktree.
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (common) out.push(path.join(path.dirname(common), '.env.local'));
  } catch { /* not a repo, or no git — fine */ }

  if (process.env.MEETDOSSIE_ROOT) out.push(path.join(process.env.MEETDOSSIE_ROOT, '.env.local'));
  return out;
}

/**
 * load — sets any variable not already in process.env.
 * @returns {{path:string|null, names:string[], searched:string[]}}
 */
function load(explicit, { quiet = false } = {}) {
  const searched = candidates(explicit);
  const found = searched.find(f => { try { return fs.existsSync(f); } catch { return false; } });
  if (!found) {
    if (!quiet) {
      console.warn(`[env-local] NO .env.local FOUND. Searched ${searched.length} locations including the main worktree root.\n` +
        `  Anything keyed off an API key will now silently take its fallback path. That is the failure mode, not a warning to ignore.`);
    }
    return { path: null, names: [], searched };
  }
  const names = [];
  // Strip a UTF-8 BOM — with it, the FIRST variable's name comes out as
  // "﻿FOO" and that one var is silently missing while every other one
  // loads, which reads exactly like a rotated key.
  const text = fs.readFileSync(found, 'utf8').replace(/^﻿/, '');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    names.push(m[1]);
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
  if (!quiet) console.log(`[env-local] loaded ${names.length} names from ${found}`);
  return { path: found, names, searched };
}

/** requireKeys — fail loudly and by NAME when something required is absent. */
function requireKeys(...keys) {
  const missing = keys.filter(k => !process.env[k] || process.env[k] === '[SENSITIVE]');
  if (missing.length) {
    throw new Error(`Missing required env var(s): ${missing.join(', ')}. Loaded from ${load(null, { quiet: true }).path || 'nowhere'}.`);
  }
}

module.exports = { load, requireKeys, candidates };
if (require.main === module) {
  const r = load(process.argv[2]);
  console.log(JSON.stringify({ path: r.path, count: r.names.length, names: r.names }, null, 2));
}
