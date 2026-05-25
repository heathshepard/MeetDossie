#!/usr/bin/env node
// scripts/generate-ai-video.js
//
// AI video pipeline demo: content_calendar topic + persona → Kling 2.5 b-roll
// → Creatomate render → video URL.
//
// This is a demonstration script, not a cron. Run manually to verify the full
// AI video pipeline end-to-end once FAL_KEY is set in Vercel.
//
// Usage (local — requires CRON_SECRET + other env vars in .env.local):
//   node scripts/generate-ai-video.js --topic cost_math --persona brenda
//
// Usage (calling deployed staging endpoint):
//   STAGE_URL=https://meet-dossie-nc8tcpjt5-heathshepard-6590s-projects.vercel.app \
//   node scripts/generate-ai-video.js --topic morning_brief --persona patricia
//
// Required env vars (in Vercel env vars or .env.local):
//   CRON_SECRET          - shared secret for internal API endpoints
//   CREATOMATE_API_KEY   - Creatomate render API
//   FAL_KEY              - fal.ai API key (sign up at fal.ai, add credits, copy key)
//
// Cost per run:
//   B-roll clip (5s):     ~$0.84 (5 * $0.168/sec via fal.ai)
//   Creatomate render:    ~$0.01 (flat per render on current plan)
//   Total per video:      ~$0.85
//   Monthly (30 videos):  ~$25.50 — include in budget before enabling at scale

"use strict";

// ---------------------------------------------------------------------------
// Topic → cinematic prompt map
// ---------------------------------------------------------------------------
// Each entry should describe a visually rich, emotionally resonant scene that
// matches the Dossie brand: warm, professional, Texas real estate context.
// Keep prompts under 200 chars. No generic office scenes.
// ---------------------------------------------------------------------------

const PROMPT_MAP = {
  cost_math:
    "tired female real estate agent at desk late at night reviewing documents and bills, warm desk lamp, cinematic slow dolly push, shallow depth of field",

  morning_brief:
    "woman smiling at smartphone with morning coffee, sunlit kitchen, golden hour light, slow zoom in, soft bokeh background",

  trec_deadlines:
    "close-up of calendar and TREC contract documents on wooden desk, selective focus, warm amber tones, cinematic rack focus",

  pipeline_visibility:
    "professional woman at laptop reviewing colorful dashboard charts, bright modern home office, natural window light, slow push in",

  control:
    "confident female real estate agent standing in a luxury Texas home entryway, arms crossed, warm interior light, subtle slow zoom",

  tc_replacement:
    "empty desk chair with sticky notes scattered on desk, transaction files stacked, warm overhead light, cinematic slow pull back",

  deadline_stress:
    "close-up of phone screen showing urgent notification alerts, blurred agent in background looking anxious, warm tones, shallow focus",

  closing_day:
    "real estate agent handing over house keys to smiling couple, suburban Texas home exterior, golden hour, cinematic slow zoom out",

  document_signing:
    "hands signing real estate contract on polished desk, pen and papers, warm directional light, extreme close-up macro shot",

  team_scale:
    "female real estate broker looking at multiple screens showing transaction files, modern brokerage office, warm ambient light, slow dolly",
};

const DEFAULT_PROMPT =
  "professional female real estate agent reviewing paperwork at desk, warm light, cinematic slow push, Texas suburban setting";

// ---------------------------------------------------------------------------
// Creatomate template (same as existing pipeline)
// ---------------------------------------------------------------------------
const CREATOMATE_TEMPLATE_ID = "791117d0-665c-4cd0-ba5f-a767f8921f9b";

// ---------------------------------------------------------------------------
// Persona → voiceover sample (for demo renders — production pulls from DB)
// ---------------------------------------------------------------------------
const PERSONA_SAMPLE_VOICEOVER = {
  brenda:
    "Managing six deals at once used to mean six chances to miss something. Dossie tracks every deadline, every document, every follow-up -- so nothing slips. This is what control actually looks like. This is Dossie. Texas agents -- meetdossie.com slash founding.",
  patricia:
    "Part-time hours, full-time results. Dossie handles the file work while Patricia focuses on clients. Every deadline cited to the paragraph. Every document in one place. This is Dossie. Texas agents -- meetdossie.com slash founding.",
  victor:
    "Eighty transactions a year. Every deadline tracked. Every file organized. No TC required. The pipeline view is the file. The work is the deal. This is Dossie. Texas agents -- meetdossie.com slash founding.",
};

const PERSONA_NAMES = {
  brenda: "Brenda Castillo",
  patricia: "Patricia Torres",
  victor: "Victor Reyes",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    topic: "cost_math",
    persona: "brenda",
    baseUrl: process.env.STAGE_URL || "https://meetdossie.com",
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--topic" && args[i + 1]) result.topic = args[++i];
    if (args[i] === "--persona" && args[i + 1]) result.persona = args[++i];
    if (args[i] === "--base-url" && args[i + 1]) result.baseUrl = args[++i];
    if (args[i] === "--dry-run") result.dryRun = true;
  }
  return result;
}

async function callGenerateBroll({ baseUrl, cronSecret, prompt, duration_seconds, aspect_ratio }) {
  const url = `${baseUrl}/api/generate-broll`;
  console.log(`[generate-ai-video] POST ${url}`);
  console.log(`[generate-ai-video] prompt: "${prompt.slice(0, 80)}..."`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cronSecret}`,
    },
    body: JSON.stringify({ prompt, duration_seconds, aspect_ratio }),
  });

  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(`generate-broll failed (${res.status}): ${data.error || JSON.stringify(data)}`);
  }
  return data; // { url, duration, model, aspect_ratio }
}

async function callCreatomate({ creatomateApiKey, videoUrl, voiceover, personaName, caption }) {
  console.log(`[generate-ai-video] Calling Creatomate template ${CREATOMATE_TEMPLATE_ID}`);

  const res = await fetch("https://api.creatomate.com/v2/renders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creatomateApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      template_id: CREATOMATE_TEMPLATE_ID,
      modifications: {
        "Image-K8V": videoUrl, // AI-generated b-roll replaces screen recording
        "Persona-Name": personaName,
        Caption: caption,
        Voiceover: voiceover,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Creatomate error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data; // { id, status, url, ... }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { topic, persona, baseUrl, dryRun } = parseArgs();

  console.log(`\n[generate-ai-video] --- AI Video Pipeline ---`);
  console.log(`  topic:   ${topic}`);
  console.log(`  persona: ${persona}`);
  console.log(`  baseUrl: ${baseUrl}`);
  console.log(`  dryRun:  ${dryRun}`);
  console.log(``);

  const cronSecret = process.env.CRON_SECRET;
  const creatomateApiKey = process.env.CREATOMATE_API_KEY;

  if (!cronSecret) {
    console.error("[generate-ai-video] ERROR: CRON_SECRET env var not set");
    process.exit(1);
  }
  if (!creatomateApiKey) {
    console.error("[generate-ai-video] ERROR: CREATOMATE_API_KEY env var not set");
    process.exit(1);
  }

  // Resolve cinematic prompt from topic map
  const brollPrompt = PROMPT_MAP[topic] || DEFAULT_PROMPT;
  const voiceover = PERSONA_SAMPLE_VOICEOVER[persona] || PERSONA_SAMPLE_VOICEOVER.brenda;
  const personaName = PERSONA_NAMES[persona] || PERSONA_NAMES.brenda;
  const caption = `Dossie handles every deadline, document, and follow-up so ${personaName.split(" ")[0]} can focus on clients. ${topic.replace(/_/g, " ")} -- handled.`;

  console.log(`[generate-ai-video] b-roll prompt: "${brollPrompt}"`);
  console.log(`[generate-ai-video] persona name:  ${personaName}`);
  console.log(`[generate-ai-video] voiceover len: ${voiceover.length} chars`);
  console.log(`[generate-ai-video] estimated cost: ~$0.84 (b-roll 5s) + ~$0.01 (Creatomate) = ~$0.85`);
  console.log(``);

  if (dryRun) {
    console.log("[generate-ai-video] --dry-run set. Skipping API calls. Exiting cleanly.");
    return;
  }

  // Step 1: Generate AI b-roll via fal.ai Kling 2.5
  console.log("[generate-ai-video] Step 1: Generating b-roll via fal.ai Kling 2.5...");
  let brollResult;
  try {
    brollResult = await callGenerateBroll({
      baseUrl,
      cronSecret,
      prompt: brollPrompt,
      duration_seconds: 5,
      aspect_ratio: "9:16",
    });
  } catch (err) {
    console.error("[generate-ai-video] b-roll generation failed:", err.message);
    process.exit(1);
  }

  console.log(`[generate-ai-video] b-roll ready: ${brollResult.url}`);
  console.log(`  model:        ${brollResult.model}`);
  console.log(`  duration:     ${brollResult.duration}s`);
  console.log(`  aspect_ratio: ${brollResult.aspect_ratio}`);
  console.log(``);

  // Step 2: Pass AI clip to Creatomate for final assembly
  console.log("[generate-ai-video] Step 2: Sending to Creatomate for final render...");
  let renderResult;
  try {
    renderResult = await callCreatomate({
      creatomateApiKey,
      videoUrl: brollResult.url,
      voiceover,
      personaName,
      caption,
    });
  } catch (err) {
    console.error("[generate-ai-video] Creatomate render failed:", err.message);
    process.exit(1);
  }

  console.log(`\n[generate-ai-video] --- DONE ---`);
  console.log(`  Creatomate render ID: ${renderResult.id || "(see raw below)"}`);
  console.log(`  Status:               ${renderResult.status || "submitted"}`);
  console.log(`  Video URL:            ${renderResult.url || "(pending — poll /api/check-creatomate-render)"}`);
  console.log(``);
  console.log("Full render response:", JSON.stringify(renderResult, null, 2));
}

main().catch((err) => {
  console.error("[generate-ai-video] Unhandled error:", err);
  process.exit(1);
});
