#!/usr/bin/env node
// scripts/generate-orb-video.js
//
// Generate the Cole orb smoke loop via fal.ai Kling 2.5 image-to-video.
// Input: smoke-still-1-lava-lamp.png (selected variant — center-radiating plume)
// Output: public/orb-smoke-v1.mp4 (seamless ~8s loop, crossfaded via ffmpeg)
//
// Run: node scripts/generate-orb-video.js
//
// Cost: ~$1.40 for a 5s Kling 2.5 standard image-to-video clip.

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { fal } = require("@fal-ai/client");

// Load FAL_KEY from .env.local
const envLocalPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envLocalPath)) {
  const envLines = fs.readFileSync(envLocalPath, "utf8").split("\n");
  for (const line of envLines) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r\n]+)"?/);
    if (m) process.env[m[1]] = process.env[m[1]] || m[2];
  }
}

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error("ERROR: FAL_KEY not set. Add it to .env.local.");
  process.exit(1);
}

const STILL_PATH = "C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\products\\jarvis-cole\\design\\smoke-stills-v1\\smoke-still-1-lava-lamp.png";
// MeetDossie serves static assets from the repo root (vercel.json:
// outputDirectory="."), so the final loop lives at repo root.
// The raw intermediate stays in a temp dir under public/ so it can be
// gitignored and not shipped.
const REPO_ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(REPO_ROOT, "public");
const RAW_OUT = path.join(TMP_DIR, "orb-smoke-raw.mp4");
const LOOP_OUT = path.join(REPO_ROOT, "orb-smoke-v1.mp4");

const PROMPT = [
  "Slow hypnotic motion of luminous smoke originating from a glowing core at the center of a glass sphere, radiating outward in all directions.",
  "Swirling continuously, soft and dreamy.",
  "The smoke tendrils flow gently outward and curl back, never settling at the bottom, never reaching the glass shell.",
  "Glass sphere stays perfectly still, smoke moves slowly within.",
  "Cinematic slow-motion lava-lamp feel.",
].join(" ");

async function uploadStill() {
  if (!fs.existsSync(STILL_PATH)) {
    throw new Error(`Still not found: ${STILL_PATH}`);
  }
  console.log(`[orb-video] uploading still: ${STILL_PATH}`);
  const buf = fs.readFileSync(STILL_PATH);
  const file = new File([buf], "smoke-still-1-lava-lamp.png", { type: "image/png" });
  const url = await fal.storage.upload(file);
  console.log(`[orb-video] uploaded: ${url}`);
  return url;
}

async function generateClip(imageUrl) {
  console.log(`[orb-video] calling Kling 2.5 image-to-video (5s, 1:1)`);
  console.log(`[orb-video] prompt: ${PROMPT.slice(0, 90)}...`);

  // Kling 2.5 Turbo Pro image-to-video endpoint on fal.ai.
  // (There is no v2.5 "standard" — only turbo-pro for image-to-video.)
  const result = await fal.subscribe(
    "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    {
      input: {
        prompt: PROMPT,
        image_url: imageUrl,
        duration: "5",
        // negative prompt: avoid the bottom-pool failure mode
        negative_prompt: "smoke at the bottom of the sphere, liquid pool, fluid settling at the bottom, smoke escaping the sphere, sphere moving, distortion of the glass shell, broken sphere, blurry, low quality",
      },
      pollInterval: 5000,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && update.logs) {
          update.logs.forEach((l) => console.log(`  fal: ${l.message}`));
        }
      },
    }
  );

  const videoUrl = result?.data?.video?.url;
  if (!videoUrl) {
    console.error("[orb-video] unexpected fal response:", JSON.stringify(result).slice(0, 500));
    throw new Error("fal.ai returned no video URL");
  }
  console.log(`[orb-video] clip ready: ${videoUrl}`);
  return videoUrl;
}

async function downloadVideo(url, outPath) {
  console.log(`[orb-video] downloading clip to ${outPath}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`[orb-video] saved ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
}

function loopify(rawPath, loopPath) {
  // Crossfade the last 1s with the first 1s so the loop wraps seamlessly.
  // Source is 5s; output is 4s (first 4s of source) with a 1s crossfade from
  // the tail of the source back into its head. Visually it plays:
  //   [0s..3s of source] then crossfade(source[3s..4s], source[0s..1s]) → seamless.
  // Using xfade with offset=3 duration=1 yields a 4s clip whose start frame ≈ end frame.
  console.log(`[orb-video] building seamless loop via ffmpeg xfade`);

  const cmd = [
    "ffmpeg",
    "-y",
    `-i "${rawPath}"`,
    `-i "${rawPath}"`,
    // First input: full 5s. Second input: same 5s, trimmed/shifted so its 0s lines up with first input's 4s mark.
    // We want output[t]: 0..3 = inputA[t]; 3..4 = crossfade(inputA[3..4], inputA[0..1]); discard rest.
    `-filter_complex "[0:v]trim=0:4,setpts=PTS-STARTPTS[a];[1:v]trim=0:1,setpts=PTS-STARTPTS+3/TB[b];[a][b]xfade=transition=fade:duration=1:offset=3,format=yuv420p[v]"`,
    `-map "[v]"`,
    "-an",
    "-c:v libx264",
    "-preset slow",
    "-crf 20",
    "-pix_fmt yuv420p",
    "-movflags +faststart",
    `"${loopPath}"`,
  ].join(" ");

  execSync(cmd, { stdio: "inherit" });
  const stat = fs.statSync(loopPath);
  console.log(`[orb-video] loop output: ${loopPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  fal.config({ credentials: FAL_KEY });

  const imageUrl = await uploadStill();
  const clipUrl = await generateClip(imageUrl);
  await downloadVideo(clipUrl, RAW_OUT);
  loopify(RAW_OUT, LOOP_OUT);

  console.log(`\n[orb-video] DONE.`);
  console.log(`  raw:  ${RAW_OUT}`);
  console.log(`  loop: ${LOOP_OUT}`);
}

main().catch((err) => {
  console.error("[orb-video] FATAL:", err);
  process.exit(1);
});
