// scripts/claude-code-task-handlers/fable_script_gen.js
//
// Fable Script Generation — runs the Fable-5 short-form script prompt against
// Claude via `claude --print` (Heath's Max subscription, free at the margin)
// instead of the pay-per-token Anthropic API.
//
// This is the flagship handler for the Claude Code CLI worker pattern — every
// other batch script-gen task should follow the same shape.
//
// Contract:
//   { payload: {
//       hook: string (required),          — the 3-6 word cold open
//       persona: string (default 'brenda') — brenda | patricia | victor | heath
//       platform: string (default 'ig')   — ig | tiktok | reels | linkedin
//       target_length_seconds: int (default 45)
//       feature_focus: string (optional)  — Dossie feature to spotlight
//       tone_notes: string (optional)     — free-text vibe direction
//       model: 'sonnet' | 'opus' (default 'sonnet')
//     }
//   }
//
// Returns (stored on agent_queue.metadata.result):
//   {
//     ok: true,
//     script: string,           — the ready-to-record VO script
//     shot_list: string[],      — 3-6 kinetic-type shot directions
//     hook_variants: string[],  — 3 alternate opener rewrites
//     estimated_seconds: int,
//     model_used: string,
//     max_billed: true,         — always true for this worker
//   }
//
// COST WIN
//   Old API path (Sonnet 4.5): ~30k input + 4k output ≈ $0.15/run.
//   Nightly × 30 days = $4.50/mo. This handler = $0/run (Max flat rate).
//
// LLM CALL STRATEGY
//   We shell out to `claude --print` with a single-turn prompt. --output-format
//   json returns { result: string, ... }. We don't stream — we're producing a
//   ~400-word script, latency doesn't matter (this is background work).
//
//   `claude --print` inherits Heath's logged-in Max session automatically.
//   The worker process does NOT need ANTHROPIC_API_KEY.
//
// Owner: Atlas, 2026-07-07.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME_DIR = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Heath Shepard';
const CLAUDE_EXE_DIRECT = path.join(
  process.env.APPDATA || path.join(HOME_DIR, 'AppData', 'Roaming'),
  'npm', 'node_modules', '@anthropic-ai/claude-code', 'bin', 'claude.exe'
);
const CLAUDE_BIN = (() => {
  try { if (fs.existsSync(CLAUDE_EXE_DIRECT)) return CLAUDE_EXE_DIRECT; } catch {}
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
})();

const SPAWN_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per Fable run

const PERSONA_VOICE = {
  brenda:   'Brenda — 52-year-old KW top producer, warm/blunt, 20 years experience, second-person direct address. Southern speech but not exaggerated. Uses "y\'all" sparingly.',
  patricia: 'Patricia — 39-year-old San Antonio agent, energetic, storyteller. Frames things as "here\'s the shift" moments.',
  victor:   'Victor — Austin-based agent, analytical, LinkedIn-friendly. Leads with a metric, ends with a question.',
  heath:    'Heath — the founder himself. First-person. Blunt, builder-tone. Cites the product change directly. No persona-voice — this is Heath speaking as Heath.',
};

const PLATFORM_RULES = {
  ig:       'Instagram Reels: caption hook by 0:02, cut every 2-3s, no watermark burn-in, end on soft CTA (link in bio not typed).',
  tiktok:   'TikTok: text-on-screen carries the story, cut every 1-2s, algorithm favors face-to-camera hook + product cut.',
  reels:    'Facebook Reels: mirror TikTok pacing, slightly less aggressive cutting, more warmth in VO.',
  linkedin: 'LinkedIn: 60-90s, business tone, 1-2 statistics, no aggressive cuts, opens with a claim + proof.',
};

function buildPrompt(payload) {
  const persona = String(payload.persona || 'brenda').toLowerCase();
  const platform = String(payload.platform || 'ig').toLowerCase();
  const hook = String(payload.hook || '').slice(0, 200);
  const feature = payload.feature_focus ? String(payload.feature_focus).slice(0, 200) : '';
  const tone = payload.tone_notes ? String(payload.tone_notes).slice(0, 500) : '';
  const seconds = Number.isFinite(payload.target_length_seconds) ? payload.target_length_seconds : 45;

  const personaVoice = PERSONA_VOICE[persona] || PERSONA_VOICE.brenda;
  const platformRule = PLATFORM_RULES[platform] || PLATFORM_RULES.ig;

  return [
    `# Fable 5 Script Gen — batch task`,
    ``,
    `You are the Fable 5 short-form video director for Dossie (meetdossie.com — an AI transaction coordinator for Texas REALTORS).`,
    ``,
    `## Voice`,
    personaVoice,
    ``,
    `## Platform`,
    platformRule,
    ``,
    `## This script`,
    `- Cold open hook: **${hook}**`,
    `- Target length: ${seconds} seconds`,
    feature ? `- Feature to spotlight: ${feature}` : '',
    tone ? `- Tone direction: ${tone}` : '',
    ``,
    `## Constraints`,
    `- ${persona === 'heath' ? 'First-person as Heath (founder). No persona.' : 'Third-person / second-person as ' + persona + '.'} Never use "I" as a persona — only Heath uses "I".`,
    `- Dossie is always "she/her." Warm, capable, never corporate.`,
    `- No em-dashes. No corporate throat-clearing ("In today's fast-paced market…"). No fabricated stats.`,
    `- Kinetic type on-screen must reinforce, not restate.`,
    `- Do NOT imply the agent has been using Dossie for months or years — say "recently" / "over the last few weeks".`,
    ``,
    `## Return ONLY this JSON on the very last line (no code fences, no prose after):`,
    ``,
    `{"script":"<the full ready-to-record VO, plain text with natural line breaks>","shot_list":["<3-6 kinetic-type shot directions, each 4-10 words>","..."],"hook_variants":["<alt opener 1>","<alt opener 2>","<alt opener 3>"],"estimated_seconds":<int>}`,
    ``,
    `You may think through this above the final line. The final line MUST be valid JSON on a single line.`,
  ].filter(Boolean).join('\n');
}

function runClaude(prompt, model, log) {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [
      '--print',
      '--model', model,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];

    log(`spawn claude --print model=${model} bin=${CLAUDE_BIN}`);

    let stdoutBuf = '';
    let stderrBuf = '';
    let killed = false;

    const child = spawn(CLAUDE_BIN, args, {
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      return resolve({ ok: false, error: `stdin write failed: ${e.message}`, duration_ms: 0 });
    }

    const timer = setTimeout(() => {
      killed = true;
      log(`TIMEOUT after ${SPAWN_TIMEOUT_MS}ms — killing`);
      try { child.kill('SIGKILL'); } catch {}
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
    child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `claude spawn error: ${err.message}`, duration_ms: Date.now() - started, stderr: stderrBuf });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration_ms = Date.now() - started;

      if (killed) {
        return resolve({ ok: false, error: `timeout after ${Math.round(SPAWN_TIMEOUT_MS/60000)}min`, duration_ms, stderr: stderrBuf.slice(-2000) });
      }

      if (code !== 0) {
        return resolve({
          ok: false,
          error: `claude exited ${code}: ${stderrBuf.slice(-500) || '(no stderr)'}`,
          duration_ms,
          stdout: stdoutBuf.slice(-2000),
          stderr: stderrBuf.slice(-2000),
        });
      }

      // Parse the --output-format json envelope.
      let envelope = null;
      try { envelope = JSON.parse(stdoutBuf); } catch { /* fall through */ }

      const rawText = (envelope && typeof envelope.result === 'string')
        ? envelope.result
        : stdoutBuf;

      resolve({ ok: true, raw: rawText, envelope, duration_ms });
    });
  });
}

function extractJsonTail(text) {
  // The prompt asks for JSON on the very last line. Find the last '{' that
  // starts a well-formed JSON object.
  const trimmed = String(text || '').trim();
  // Try the whole thing first (in case model returned only JSON).
  try { return JSON.parse(trimmed); } catch {}

  // Walk backwards for the last '{'.
  const lastBrace = trimmed.lastIndexOf('{');
  if (lastBrace >= 0) {
    const candidate = trimmed.slice(lastBrace);
    try { return JSON.parse(candidate); } catch {}
    // Try trimming trailing prose after the closing '}'
    const lastClose = candidate.lastIndexOf('}');
    if (lastClose > 0) {
      try { return JSON.parse(candidate.slice(0, lastClose + 1)); } catch {}
    }
  }

  return null;
}

module.exports = async function fableScriptGenHandler({ payload, task_id, log }) {
  log(`fable_script_gen start payload=${JSON.stringify({
    hook: payload.hook,
    persona: payload.persona,
    platform: payload.platform,
    seconds: payload.target_length_seconds,
  })}`);

  // Validate the minimum inputs.
  if (!payload || !payload.hook || typeof payload.hook !== 'string') {
    return { ok: false, summary: 'payload.hook (string) is required', error: 'missing_hook' };
  }

  const model = String(payload.model || 'sonnet').toLowerCase();
  if (!['sonnet', 'opus', 'haiku'].includes(model)) {
    return { ok: false, summary: `invalid model: ${model}`, error: 'invalid_model' };
  }

  const prompt = buildPrompt(payload);

  const runResult = await runClaude(prompt, model, log);
  if (!runResult.ok) {
    return {
      ok: false,
      summary: `claude call failed: ${runResult.error}`,
      error: runResult.error,
      result: { duration_ms: runResult.duration_ms, stderr: runResult.stderr },
    };
  }

  const parsed = extractJsonTail(runResult.raw);
  if (!parsed) {
    // Return the raw output so Heath / debug can see what the model said even
    // if JSON parsing failed.
    return {
      ok: false,
      summary: `claude returned but JSON tail did not parse (raw len=${runResult.raw.length})`,
      error: 'json_parse_failed',
      result: {
        raw_tail: runResult.raw.slice(-800),
        duration_ms: runResult.duration_ms,
        model_used: model,
      },
    };
  }

  // Basic sanity check on the required fields.
  const required = ['script', 'shot_list', 'hook_variants', 'estimated_seconds'];
  const missing = required.filter((k) => parsed[k] === undefined || parsed[k] === null);
  if (missing.length > 0) {
    return {
      ok: false,
      summary: `claude JSON missing fields: ${missing.join(',')}`,
      error: 'missing_fields',
      result: { parsed, model_used: model, duration_ms: runResult.duration_ms },
    };
  }

  log(`fable_script_gen success script_len=${String(parsed.script).length} shots=${(parsed.shot_list || []).length}`);

  return {
    ok: true,
    summary: `Fable script generated (${parsed.estimated_seconds}s, ${String(parsed.script).split(/\s+/).length} words). Model: ${model}. Max-billed: yes.`,
    result: {
      script: String(parsed.script).slice(0, 8000),
      shot_list: Array.isArray(parsed.shot_list) ? parsed.shot_list.slice(0, 12).map(String) : [],
      hook_variants: Array.isArray(parsed.hook_variants) ? parsed.hook_variants.slice(0, 6).map(String) : [],
      estimated_seconds: Number(parsed.estimated_seconds) || 0,
      model_used: model,
      max_billed: true,
      duration_ms: runResult.duration_ms,
      persona: payload.persona || 'brenda',
      platform: payload.platform || 'ig',
      hook: payload.hook,
    },
  };
};
