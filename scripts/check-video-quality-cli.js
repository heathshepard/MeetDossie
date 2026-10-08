#!/usr/bin/env node
//
// scripts/check-video-quality-cli.js
//
// The local/CLI entry point for the video quality gate. This is the file
// api/_lib/verify-video-quality.js's own header already names as its intended
// invocation path, and the exact command scripts/queue-finished-videos.py's
// run_quality_gate() already shells out to. It did not exist until now —
// which meant Pipeline B's gate call returned None on every single video, and
// None is treated (correctly) as fail-closed. Every video going through
// ingestion was being held. This file closes that gap; it does not loosen a
// single rule.
//
// WHY A NODE CLI RATHER THAN PYTHON: Vercel serverless cannot run ffmpeg (see
// api/cron-render-videos.js), so the gate has to run where the binaries are —
// locally. But the gate's vision checks reuse api/_lib/verify-video-quality.js's
// Anthropic transport, which is JS. Rather than reimplement the measurable
// rules in Python and let the two copies drift, the Python ingestion shells
// out to this and parses one JSON line.
//
// CONTRACT (fixed by queue-finished-videos.py — do not change it casually):
//   node scripts/check-video-quality-cli.js --video <path> [--cover <path>]
//   → exactly ONE line of JSON on stdout: {pass, rules, failedRules, detail}
//   → all human-readable diagnostics go to STDERR, never stdout
//   → exit 0 = gate ran and the video PASSED
//     exit 2 = gate ran and the video FAILED (a real verdict, not an error)
//     exit 1 = the gate could not run at all (bad args, unreadable file, throw)
//   Callers MUST treat "no parseable JSON" as a hard failure, never as skip.
//
// FAIL-CLOSED: this deliberately never swallows an error into a pass. If the
// gate throws before producing a verdict, we still emit a JSON line with
// pass:false so a caller parsing stdout gets an explicit rejection rather than
// silence it might misread.
//
// Flags:
//   --video <path>     required. Local path to the .mp4 under test.
//   --cover <path>     explicit cover asset. The gate fails without one
//                      (cover_asset_present is blocking, never optional).
//   --video-url <url>  remote video instead of a local path.
//   --cover-url <url>  remote cover instead of a local path.
//   --cta-url <url>    the CTA as it appears on the end card. ADDS a blocking
//                      `cta_url_resolves` rule (DNS + HTTP < 400). Optional so
//                      every existing caller keeps working unchanged; when it
//                      IS supplied a dead link is a hard FAIL. A CTA that is a
//                      sentence rather than a link ("Text me for a private
//                      showing") is reported as skipped, never as a silent
//                      pass. See scripts/_lib/cta-url-resolve.js.
//   --platforms <csv>  the video_library row's real platforms, comma-
//                      separated (e.g. "facebook,twitter,linkedin"). Selects
//                      vertical vs horizontal rules — see
//                      api/_lib/verify-video-quality.js's classifyOrientation().
//                      Omit only for pre-2026-09-17 callers that want the
//                      old vertical-only default; a real ingestion caller
//                      should always pass this.
//   --orientation <o>  explicit 'vertical' | 'horizontal' | 'vertical_long'
//                      override, only when --platforms isn't available.
//                      'vertical_long' is the 9:16 LONG lane (40-90s) that
//                      the dual-cut producer uses for the CORE+OPTIONAL cut
//                      going to YouTube Shorts / Facebook / LinkedIn. It is
//                      explicit-only: passing those platform names instead
//                      would classify the row HORIZONTAL and demand 16:9.
//   --pretty           ALSO write a human-readable rule table to stderr.
//   --json-only        suppress the stderr table (default when not a TTY).

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- env ----
// Must run BEFORE requiring verify-video-quality.js: that module reads
// process.env at module-load time (ANTHROPIC_API_KEY, CRON_SECRET, SUPABASE_*),
// so a later load would leave them undefined and fail every vision rule closed.
function loadEnvLocal() {
  const candidates = [];
  // Normal case: repo root is one level up from scripts/.
  candidates.push(path.join(__dirname, '..', '.env.local'));
  // Worktree case: .env.local is gitignored and therefore only exists in the
  // main working tree, not in .claude/worktrees/<name>/. Walk up to it.
  const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const here = path.join(__dirname, '..');
  const idx = here.indexOf(marker);
  if (idx > 0) candidates.push(path.join(here.slice(0, idx), '.env.local'));

  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      // Strip a UTF-8 BOM: a BOM silently corrupts the FIRST key name, which
      // reads downstream as a rotated/invalid credential rather than a parse
      // bug (memory: env-local-bom-breaks-first-var.md).
      const raw = fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
        // Never let a file value clobber a real exported env var.
        if (!process.env[key]) process.env[key] = val;
      }
      return envPath;
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}

const loadedEnv = loadEnvLocal();

// ---------------------------------------------------------------- args ----
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
function flag(name) {
  return process.argv.includes(name);
}

function emit(result, exitCode) {
  // Exactly one JSON line on stdout. Nothing else may ever be written there.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(exitCode);
}

async function main() {
  const videoPath = arg('--video');
  const videoUrl = arg('--video-url');
  const coverPath = arg('--cover');
  const coverUrl = arg('--cover-url');
  const ctaUrl = arg('--cta-url');
  const platformsArg = arg('--platforms');
  const platforms = platformsArg
    ? platformsArg.split(',').map((p) => p.trim()).filter(Boolean)
    : undefined;
  const orientation = arg('--orientation') || undefined;
  const wantTable = flag('--pretty') || (process.stderr.isTTY && !flag('--json-only'));

  if (!videoPath && !videoUrl) {
    process.stderr.write(
      'usage: node scripts/check-video-quality-cli.js --video <path> [--cover <path>]\n'
      + '       (or --video-url <url> [--cover-url <url>])\n',
    );
    emit({
      pass: false,
      rules: { cli_invocation: { pass: false, blocking: true, note: 'no --video/--video-url supplied' } },
      failedRules: ['cli_invocation'],
      detail: {},
    }, 1);
  }

  if (videoPath && !fs.existsSync(videoPath)) {
    emit({
      pass: false,
      rules: { video_file_accessible: { pass: false, blocking: true, note: `no such file: ${videoPath}` } },
      failedRules: ['video_file_accessible'],
      detail: {},
    }, 1);
  }

  process.stderr.write(`[quality-gate] env: ${loadedEnv || 'none found (vision rules will fail closed)'}\n`);
  process.stderr.write(`[quality-gate] video: ${videoPath || videoUrl}\n`);
  process.stderr.write(`[quality-gate] cover: ${coverPath || coverUrl || '(none — cover_asset_present will FAIL)'}\n`);
  process.stderr.write(`[quality-gate] platforms/orientation: ${platforms ? platforms.join(',') : (orientation || '(none — defaults to vertical)')}\n`);

  const { checkVideoQuality } = require(path.join(__dirname, '..', 'api', '_lib', 'verify-video-quality.js'));

  const result = await checkVideoQuality({
    videoPath: videoPath || undefined,
    videoUrl: videoUrl || undefined,
    coverPath: coverPath || undefined,
    coverUrl: coverUrl || undefined,
    platforms,
    orientation,
  });

  // ---- additive rule: does the CTA actually go anywhere? -------------------
  // Deliberately merged in HERE rather than inside checkVideoQuality(): that
  // function is also called at publish time by gateBeforePublish() against a
  // video_library row, which has no CTA field to check. Keeping the rule on
  // the CLI means the supply path (scripts/daily-video-supply.js, which always
  // passes --cta-url) is covered without changing publish-time behaviour.
  if (ctaUrl) {
    const { checkCtaUrl } = require(path.join(__dirname, '_lib', 'cta-url-resolve.js'));
    const cta = await checkCtaUrl(ctaUrl);
    result.rules.cta_url_resolves = {
      pass: cta.pass,
      blocking: true,
      note: cta.skipped ? `skipped: ${cta.note}` : cta.note,
    };
    if (!cta.pass) {
      result.failedRules = [...(result.failedRules || []), 'cta_url_resolves'];
      result.pass = false;
    }
    result.detail = { ...(result.detail || {}), cta_url: cta.url, cta_status: cta.status };
  }

  if (wantTable) {
    process.stderr.write('\n  rule                            verdict  note\n');
    process.stderr.write(`  ${'-'.repeat(88)}\n`);
    for (const [name, r] of Object.entries(result.rules)) {
      const verdict = r.pass ? 'PASS   ' : (r.blocking ? 'FAIL   ' : 'warn   ');
      process.stderr.write(`  ${name.padEnd(30)}  ${verdict}  ${(r.note || '').slice(0, 120)}\n`);
    }
    process.stderr.write(`  ${'-'.repeat(88)}\n`);
    process.stderr.write(`  detail: ${JSON.stringify(result.detail)}\n`);
    process.stderr.write(`  VERDICT: ${result.pass ? 'PASS' : `FAIL (${result.failedRules.join(', ')})`}\n\n`);
  }

  emit(result, result.pass ? 0 : 2);
}

main().catch((err) => {
  // A throw here is still a verdict: fail-closed, and say why on stderr.
  process.stderr.write(`[quality-gate] threw: ${(err && err.stack) || err}\n`);
  emit({
    pass: false,
    rules: { gate_executed: { pass: false, blocking: true, note: `gate threw: ${(err && err.message) || err}` } },
    failedRules: ['gate_executed'],
    detail: {},
  }, 1);
});
