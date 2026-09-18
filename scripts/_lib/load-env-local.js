'use strict';

// scripts/_lib/load-env-local.js
//
// The .env.local loader, with the two gotchas that have each cost a real
// debugging session baked in:
//
//   1. WORKTREE-AWARE. .env.local is gitignored, so it exists ONLY in the main
//      working tree -- never in .claude/worktrees/<name>/ and never in the
//      MeetDossie-scheduler checkout until its launcher copies one in. A
//      script that only looks at ../.env.local silently runs with no keys and
//      fails much later, somewhere unrelated.
//   2. BOM-STRIPPING. A UTF-8 BOM corrupts the FIRST key name only, which
//      reads downstream as a rotated/invalid credential rather than a parse
//      bug (env-local-bom-breaks-first-var.md).
//
// Never clobbers a real exported env var: an explicit `FOO=bar node ...` wins
// over the file, which is what makes a one-off override work.

const fs = require('fs');
const path = require('path');

function candidates(startDir) {
  const out = [path.join(startDir, '.env.local'), path.join(startDir, '.env.production.local')];
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const idx = startDir.indexOf(marker);
  if (idx > 0) out.unshift(path.join(startDir.slice(0, idx), '.env.local'));
  return out;
}

/** @param {string} repoRoot @returns {string[]} the files actually loaded */
function loadEnvLocal(repoRoot) {
  const loaded = [];
  for (const envPath of candidates(repoRoot)) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const raw = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
        if (!process.env[k]) process.env[k] = v;
      }
      loaded.push(envPath);
    } catch { /* try the next candidate */ }
  }
  return loaded;
}

module.exports = { loadEnvLocal };
