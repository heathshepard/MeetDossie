#!/usr/bin/env node
'use strict';
/**
 * PreToolUse guard — blocks Write/Edit calls that would put a literal secret
 * into a tracked file, per CLAUDE.md Section 15 (SECURITY RULES —
 * NON-NEGOTIABLE): "NEVER hardcode auth tokens, API keys, or secrets in
 * source code" and "NEVER use the one-shot bypass token pattern."
 *
 * heathshepard/MeetDossie is a PUBLIC repo. The 2026-05-06 bypass commit
 * (f3700b2) proved reverts don't undo public exposure — this hook exists to
 * stop that class of mistake before it ever touches disk, not to clean up
 * after.
 *
 * Wired to PreToolUse, matcher "Write|Edit" in .claude/settings.json.
 *
 * Contract: Claude Code blocks a PreToolUse tool call when the hook exits
 * with code 2; stderr is surfaced back to the model as the block reason.
 * Any other exit code (including on our own errors) allows the call through
 * — a guard that fails closed on its own bugs would be worse than no guard,
 * so this only ever blocks on a confirmed pattern match.
 *
 * Deliberately narrow: known secret-format prefixes/shapes only (not a
 * generic high-entropy scanner), to keep false positives near zero on a
 * codebase full of legitimate env-var NAMES, docs, and test fixtures.
 */
const fs = require('fs');
const path = require('path');

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
  process.exit(0); // can't parse -> nothing to guard, fail open
}

const toolName = input.tool_name || '';
if (toolName !== 'Write' && toolName !== 'Edit') process.exit(0);

const toolInput = input.tool_input || {};
const filePath = String(toolInput.file_path || '');

// Never guard the hook's own source (it necessarily contains these patterns
// as literal regexes, not secrets) or the log file it might write to.
if (filePath.endsWith(path.join('.claude', 'hooks', 'guard-secrets.js'))) {
  process.exit(0);
}

// Combine every text field that could carry new content into the file.
const candidates = [
  toolInput.content,      // Write
  toolInput.new_string,   // Edit
].filter((v) => typeof v === 'string');

const text = candidates.join('\n');
if (!text) process.exit(0);

// Known secret shapes. Kept to formats with enough structure that a match
// is almost certainly a real credential, not prose or a var name.
const PATTERNS = [
  { name: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Stripe live secret key', re: /\b(sk|rk)_live_[0-9a-zA-Z]{16,}\b/ },
  { name: 'Stripe webhook signing secret', re: /\bwhsec_[0-9a-zA-Z]{16,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'PEM private key block', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { name: 'JWT (3-segment)', re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'one-shot bypass token pattern', re: /\b(ONE_SHOT_TOKEN|BYPASS_TOKEN|BYPASS_SECRET)\s*[:=]\s*['"][^'"]{6,}['"]/ },
];

// Skip obvious placeholders so real docs/examples don't false-positive.
function isPlaceholder(match) {
  const s = match.toLowerCase();
  return /xxxx|placeholder|example|your[-_]?key|redacted|dummy|fake|sample|\*{4,}/.test(s);
}

const hits = [];
for (const { name, re } of PATTERNS) {
  const m = text.match(re);
  if (m && !isPlaceholder(m[0])) {
    hits.push(`${name} (matched: ${m[0].slice(0, 12)}...)`);
  }
}

if (hits.length === 0) process.exit(0);

const reason =
  `BLOCKED by guard-secrets.js: ${filePath || '(unknown file)'} appears to contain a live secret ` +
  `— ${hits.join('; ')}. Per CLAUDE.md Section 15, secrets live in Vercel env vars only, never in ` +
  `tracked source. Reference the env var NAME instead, or if this really is a placeholder, rephrase ` +
  `it clearly (e.g. "sk-xxxx-EXAMPLE") so it doesn't read as a real key.`;

process.stderr.write(reason + '\n');
process.exit(2);
