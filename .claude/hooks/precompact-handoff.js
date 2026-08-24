#!/usr/bin/env node
'use strict';
/**
 * PreCompact hook — writes a fresh HANDOFF.md before this session's context
 * gets compacted (manual /compact or automatic auto-compact).
 *
 * Claude Code's native "prompt"-type hook is only available for tool events
 * (PreToolUse/PostToolUse/PermissionRequest), not for PreCompact — so this is
 * a "command" hook that itself spawns a real `claude -p` model turn, which is
 * the documented equivalent for non-tool events. It reads the tail of this
 * session's own transcript for context, then asks that one-shot model turn to
 * write HANDOFF.md using the project's own Write tool (auto-approved because
 * this repo's .claude/settings.json sets permissions.defaultMode=acceptEdits).
 *
 * Never blocks compaction: always exits 0, logs failures to
 * .claude/hooks/precompact-handoff.log instead of surfacing them.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_DIR = '/mnt/c/Users/Heath/Projects/MeetDossie';
const HANDOFF_PATH = path.join(REPO_DIR, 'HANDOFF.md');
const LOG_PATH = path.join(REPO_DIR, '.claude', 'hooks', 'precompact-handoff.log');

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

let input = {};
try {
  input = JSON.parse(readStdin() || '{}');
} catch (e) {
  log(`Failed to parse hook stdin JSON: ${e.message}`);
}

const trigger = input.trigger || 'unknown';
const sessionId = input.session_id || 'unknown';
const transcriptPath = input.transcript_path || '';
const customInstructions = input.custom_instructions || '';

// Pull recent conversation text out of the transcript JSONL. These files can
// be enormous on long-running sessions, so only tail the last N lines.
let excerpt = '';
if (transcriptPath && fs.existsSync(transcriptPath)) {
  try {
    const tail = spawnSync('tail', ['-n', '600', transcriptPath], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    });
    const lines = (tail.stdout || '').split('\n').filter(Boolean);
    const chunks = [];
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const type = obj.type;
      if (type !== 'user' && type !== 'assistant') continue;
      const content = obj.message && obj.message.content;
      if (typeof content === 'string') {
        chunks.push(`[${type}] ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'text' && block.text) {
            chunks.push(`[${type}] ${block.text}`);
          } else if (block && block.type === 'tool_use' && block.name) {
            chunks.push(`[${type}:tool_use] ${block.name}`);
          } else if (block && block.type === 'tool_result') {
            chunks.push(`[${type}:tool_result] (output omitted)`);
          }
        }
      }
    }
    excerpt = chunks.join('\n').slice(-24000); // cap ~24k chars of context
  } catch (e) {
    log(`Failed to read transcript at ${transcriptPath}: ${e.message}`);
  }
}

if (!excerpt) {
  excerpt = '(no transcript excerpt available for this run)';
}

const prompt = `You are generating a HANDOFF.md for a Claude Code session in the MeetDossie repo (session ${sessionId}) that is about to be compacted (trigger: ${trigger}${customInstructions ? `, custom instructions: ${customInstructions}` : ''}).

Read the recent conversation excerpt below and OVERWRITE ${HANDOFF_PATH} with a concise state summary using exactly these headings, in this order:

# Handoff — <today's date>, trigger: ${trigger}

## Active Task
## Decisions Made
## What's Next

Only include what is actually evidenced in the excerpt below — no speculation, no filler content. If the excerpt doesn't give enough to fill a section, write "Nothing recorded" for that section instead of guessing. Use the Write tool to save the file at the exact path above. Do not ask questions, do not print commentary — just write the file and stop.

--- CONVERSATION EXCERPT (most recent last) ---
${excerpt}
--- END EXCERPT ---`;

log(`Firing for session=${sessionId} trigger=${trigger} excerptChars=${excerpt.length} transcriptPath=${transcriptPath}`);

const result = spawnSync('claude', ['-p'], {
  cwd: REPO_DIR,
  input: prompt,
  encoding: 'utf-8',
  timeout: 100000,
  maxBuffer: 20 * 1024 * 1024,
});

if (result.error) {
  log(`claude -p failed to spawn: ${result.error.message}`);
} else {
  log(`claude -p exited ${result.status}`);
  if (result.stdout) log(`stdout: ${result.stdout.slice(0, 2000)}`);
  if (result.stderr) log(`stderr: ${result.stderr.slice(0, 2000)}`);
}

// Never block compaction on this hook's outcome.
process.exit(0);
