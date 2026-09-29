#!/usr/bin/env node
'use strict';
/**
 * PostToolUse hook — mirrors every memory file Cole writes under
 * .claude/projects/*.md into the jarvis_project_context table via
 * POST /api/cole-write-context, so the memory index survives session drops
 * and Jarvis's next voice turn can see it.
 *
 * Closes docs/BACKLOG-ENGINEERING.md E3: "/api/cole-write-context was built
 * and is called by nothing" — the endpoint (Owner: Atlas, atlas_12) has
 * existed since 2026-06-26 with zero callers; jarvis_project_context's
 * newest row was 70 days stale. TECH-DEBT.md's self-improvement item #1
 * ("cross-session Jarvis memory mirror") names exactly this fix: "pick the
 * trigger — a hook on memory writes is the obvious one — and wire it."
 *
 * Wired to PostToolUse, matcher "Write" in .claude/settings.json. Fires
 * AFTER the write already happened, so it can never block or undo it —
 * mirroring is best-effort only. Every outcome (success, skip, failure) is
 * logged to .claude/hooks/memory-index-mirror.log instead of surfacing to
 * the model; this must never interrupt Cole's actual memory-writing turn.
 *
 * Per CLAUDE.md Section 15: CRON_SECRET is read from .env.local (never
 * hardcoded, never echoed). If it isn't available locally, this hook skips
 * and logs it — the documented "ask Heath to run the curl" pattern doesn't
 * apply to a background mirror hook, so it just no-ops rather than prompt.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_DIR = path.resolve(__dirname, '..', '..');
const PROJECTS_DIR = path.join(REPO_DIR, '.claude', 'projects');
const LOG_PATH = path.join(REPO_DIR, '.claude', 'hooks', 'memory-index-mirror.log');
const SITE_URL = process.env.COLE_CONTEXT_SITE_URL || 'https://meetdossie.com';

function log(msg) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {
    // best effort only
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch (e) {
    return '';
  }
}

// Loads CRON_SECRET from .env.local without ever printing it, mirroring the
// pattern already used by scripts/seed-agent-memory.js.
function loadCronSecret() {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  try {
    const envPath = path.join(REPO_DIR, '.env.local');
    if (!fs.existsSync(envPath)) return null;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^CRON_SECRET=(.*)$/);
      if (m) {
        let v = m[1].trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        return v || null;
      }
    }
  } catch (e) {
    log(`Failed reading .env.local: ${e.message}`);
  }
  return null;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// Pulls a title (first markdown heading, else humanized filename) and a
// speakable summary (first real paragraph after the title, else first
// non-empty line) out of the memory file content.
function deriveTitleAndSummary(content, fallbackKey) {
  const lines = content.split(/\r?\n/);
  let title = null;
  let summaryLines = [];
  let pastTitle = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!title) {
      const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) {
        title = headingMatch[1].trim();
        pastTitle = true;
        continue;
      }
      if (line) {
        // No heading at the top — use this first non-empty line as title.
        title = line.replace(/^#+\s*/, '').slice(0, 280);
        pastTitle = true;
        continue;
      }
      continue;
    }
    if (!pastTitle) continue;
    if (!line) {
      if (summaryLines.length > 0) break; // end of first paragraph
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) break; // hit next heading before any body text
    summaryLines.push(line);
    if (summaryLines.join(' ').length > 400) break;
  }

  if (!title) title = fallbackKey.replace(/[-_]+/g, ' ').replace(/\.md$/i, '');
  let summary = summaryLines.join(' ').trim();
  if (!summary) summary = `Memory file ${fallbackKey} (no body text found to summarize).`;
  summary = summary.slice(0, 2000);

  return { title: title.slice(0, 280), summary };
}

function postJson(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.write(data);
    req.end();
  });
}

(async () => {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch (e) {
    process.exit(0); // can't parse -> nothing to mirror
  }

  const toolName = input.tool_name || '';
  if (toolName !== 'Write') process.exit(0);

  const toolInput = input.tool_input || {};
  const filePath = String(toolInput.file_path || '');
  const normalized = filePath.replace(/\\/g, '/');
  const projectsDirNormalized = PROJECTS_DIR.replace(/\\/g, '/');

  if (!normalized.startsWith(projectsDirNormalized + '/') || !normalized.toLowerCase().endsWith('.md')) {
    process.exit(0); // not a memory file write, nothing to do
  }

  // Tool succeeded? PostToolUse fires either way; only mirror real writes.
  const toolResponse = input.tool_response || {};
  if (toolResponse.error) {
    log(`Skipping mirror for ${filePath}: tool_response reported an error`);
    process.exit(0);
  }

  const content = typeof toolInput.content === 'string' ? toolInput.content : '';
  if (!content.trim()) {
    log(`Skipping mirror for ${filePath}: empty content`);
    process.exit(0);
  }

  const relPath = path.relative(REPO_DIR, filePath).replace(/\\/g, '/');
  const baseName = path.basename(filePath, path.extname(filePath));
  const key = slugify(baseName);
  if (!key) {
    log(`Skipping mirror for ${filePath}: could not derive a key`);
    process.exit(0);
  }

  const { title, summary } = deriveTitleAndSummary(content, baseName);

  const cronSecret = loadCronSecret();
  if (!cronSecret) {
    log(`Skipping mirror for ${filePath}: CRON_SECRET unavailable locally (per CLAUDE.md Section 15, not embedding a bypass)`);
    process.exit(0);
  }

  try {
    const res = await postJson(
      `${SITE_URL.replace(/\/$/, '')}/api/cole-write-context`,
      {
        key,
        title,
        summary,
        status: 'active',
        priority: 3,
        source_memory_path: relPath,
        tags: ['memory-mirror'],
      },
      { Authorization: `Bearer ${cronSecret}` }
    );
    if (res.status >= 200 && res.status < 300) {
      log(`Mirrored ${relPath} -> jarvis_project_context key=${key} (HTTP ${res.status})`);
    } else {
      log(`Mirror failed for ${relPath}: HTTP ${res.status} ${res.body.slice(0, 300)}`);
    }
  } catch (e) {
    log(`Mirror request errored for ${relPath}: ${e.message}`);
  }

  process.exit(0); // PostToolUse never blocks
})();
