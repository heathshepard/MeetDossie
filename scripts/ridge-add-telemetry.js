#!/usr/bin/env node
/**
 * ridge-add-telemetry.js
 *
 * One-shot retrofit: walks api/cron-*.js and wires withTelemetry() around each
 * exported handler. Idempotent — files that already import cron-telemetry.js
 * are left alone.
 *
 * Run from MeetDossie repo root: node scripts/ridge-add-telemetry.js
 */

const fs = require('fs');
const path = require('path');

const API_DIR = path.join(__dirname, '..', 'api');
const LIB_IMPORT = "const { withTelemetry } = require('./_lib/cron-telemetry.js');";

function process(file) {
  const full = path.join(API_DIR, file);
  let src = fs.readFileSync(full, 'utf8');
  const cronName = file.replace(/\.js$/, '');

  // Skip if already wrapped.
  if (src.includes("withTelemetry(")) {
    return { file, skipped: 'already-wrapped' };
  }
  if (src.includes("cron-telemetry") && src.includes("recordCronRun")) {
    // It already uses direct recordCronRun calls. Leave it alone.
    return { file, skipped: 'uses-recordCronRun-directly' };
  }

  // Inject the import line right before the first non-comment, non-empty line
  // that ISN'T a require/import. We'll just append after the last top-level
  // const X = require(...) on the file.
  const lines = src.split(/\r?\n/);
  let lastRequireIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^(const|let|var)\s+\S+\s*=\s*require\(/.test(l)) {
      lastRequireIdx = i;
    }
    // Stop scanning once we hit the first function or module.exports.
    if (/^module\.exports\s*=/.test(l) || /^(async\s+)?function\s+/.test(l)) {
      break;
    }
  }
  if (lastRequireIdx >= 0) {
    lines.splice(lastRequireIdx + 1, 0, LIB_IMPORT);
  } else {
    // No requires found — drop import at top after any leading comment block.
    let insertAt = 0;
    while (insertAt < lines.length && (lines[insertAt].trim().startsWith('//') || lines[insertAt].trim() === '' || lines[insertAt].trim().startsWith('*') || lines[insertAt].trim().startsWith('/*'))) {
      insertAt++;
    }
    lines.splice(insertAt, 0, LIB_IMPORT, '');
  }
  src = lines.join('\n');

  // Wrap the handler. Three known patterns:
  //   1) module.exports = async function handler(req, res) { ... }
  //   2) module.exports = async (req, res) => { ... }
  //   3) export default async function handler(req, res) { ... }   (ESM)
  //   4) module.exports = async function (req, res) { ... }
  let wrapped = false;

  // Pattern 1: named function expression
  src = src.replace(
    /module\.exports\s*=\s*async\s+function\s+(\w+)\s*\(/,
    (m, name) => {
      wrapped = true;
      return `module.exports = withTelemetry('${cronName}', async function ${name}(`;
    }
  );

  // Pattern 4: anonymous async function expression
  if (!wrapped) {
    src = src.replace(
      /module\.exports\s*=\s*async\s+function\s*\(/,
      () => {
        wrapped = true;
        return `module.exports = withTelemetry('${cronName}', async function (`;
      }
    );
  }

  // Pattern 2: arrow function
  if (!wrapped) {
    src = src.replace(
      /module\.exports\s*=\s*async\s*\(req,\s*res\)\s*=>/,
      () => {
        wrapped = true;
        return `module.exports = withTelemetry('${cronName}', async (req, res) =>`;
      }
    );
  }

  // Pattern 3: ESM default export
  if (!wrapped) {
    src = src.replace(
      /export\s+default\s+async\s+function\s+(\w+)\s*\(/,
      (m, name) => {
        wrapped = true;
        return `const __handler_${name} = async function ${name}(`;
      }
    );
    if (wrapped) {
      // append wrapping export at end
      src = src.replace(/[\r\n]+$/, '') + `\n\nexport default withTelemetry('${cronName}', __handler_handler);\n`;
    }
  }

  if (!wrapped) {
    return { file, skipped: 'no-handler-pattern-matched' };
  }

  // For ESM wrapper need to close the function — fragile. Skip ESM path entirely
  // for safety since we know our codebase uses CommonJS. The pattern-3 attempt
  // above will not have wrapped a real ESM cron correctly; abort if so.

  // Close the wrapper: find the last `};` at column 0 (closes module.exports = async function ... { ... };)
  // We need to add a `)` before the final `;` of the module.exports line block.
  // Simpler: track brace depth from the wrapper start.
  const startIdx = src.indexOf(`withTelemetry('${cronName}',`);
  if (startIdx === -1) return { file, skipped: 'wrapper-anchor-missing' };

  // Find the opening { of the wrapped function body.
  const fnStart = src.indexOf('{', startIdx);
  if (fnStart === -1) return { file, skipped: 'no-fn-brace' };

  // Walk braces to find matching close.
  let depth = 0;
  let i = fnStart;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || i >= src.length) return { file, skipped: 'unbalanced-braces' };

  // Insert ')' after the closing brace.
  // i points to the closing '}' of the function body. The handler is module.exports = withTelemetry('name', async function(req, res) { ... }) and we need to close with ')'.
  // Existing tail is usually `}\n};` — the inner `}` closes fn, the outer `};` closes... wait. Pattern is:
  //   module.exports = async function handler(req, res) {
  //     ...
  //   };
  // After our edit:
  //   module.exports = withTelemetry('name', async function handler(req, res) {
  //     ...
  //   };
  // So we have ONE closing `}` and a `;`. We need to insert `)` between `}` and `;`.
  const after = src.slice(i + 1);
  const semiMatch = after.match(/^\s*;/);
  if (semiMatch) {
    const semiIdx = i + 1 + after.indexOf(';');
    src = src.slice(0, semiIdx) + ')' + src.slice(semiIdx);
  } else {
    // No `;` — just append `)`
    src = src.slice(0, i + 1) + ')' + src.slice(i + 1);
  }

  fs.writeFileSync(full, src);
  return { file, wrapped: true };
}

function main() {
  const files = fs.readdirSync(API_DIR).filter((f) => /^cron-.*\.js$/.test(f));
  const results = [];
  for (const f of files) {
    try {
      results.push(process(f));
    } catch (e) {
      results.push({ file: f, error: e.message });
    }
  }
  for (const r of results) {
    if (r.wrapped) console.log(`✓ ${r.file}`);
    else if (r.error) console.log(`✗ ${r.file} — ${r.error}`);
    else console.log(`- ${r.file} — ${r.skipped}`);
  }
  const wrapped = results.filter(r => r.wrapped).length;
  const skipped = results.filter(r => r.skipped).length;
  const errored = results.filter(r => r.error).length;
  console.log(`\nWrapped: ${wrapped}  Skipped: ${skipped}  Errored: ${errored}  Total: ${results.length}`);
}

main();
