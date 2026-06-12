#!/usr/bin/env node
// scripts/generate-orb-video-v6.js
//
// Cole orb smoke v6 — DENSE swirling smoke (lava-lamp style), not wispy strands.
//
// Heath's feedback on v5: smoke was "stringy" — wispy strands radiating outward.
// He wanted the dense, fully-encompassing swirl from the original lava-lamp still.
// v6 prompt explicitly forbids wispy/stringy/strand motion.
//
// Pipeline (single-clip, $2 budget):
//   1. Generate ONE 5s Kling 2.5 turbo-pro clip from smoke-still-1-lava-lamp.png
//   2. Take middle 4s (skip 0.5s head + 0.5s tail = drops Kling lock-in zones)
//   3. xfade last 1s back into first 1s → ~3s seamless loop, hypnotic, no seam
//
// Output:
//   - orb-smoke-v6.mp4 at MeetDossie repo root
//   - Copy to electron/renderer/ at end
//
// Cost: ~$1.40 for one Kling 2.5 turbo-pro 5s clip. Under $2 budget.
//
// Run: node scripts/generate-orb-video-v6.js

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
  console.error("ERROR: FAL_KEY not set.");
  process.exit(1);
}

const STILL_PATH = "C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\products\\jarvis-cole\\design\\smoke-stills-v1\\smoke-still-1-lava-lamp.png";
const REPO_ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(REPO_ROOT, "public");
const RAW = path.join(TMP_DIR, "orb-smoke-v6-raw.mp4");
const LOOP_OUT = path.join(REPO_ROOT, "orb-smoke-v6.mp4");
const RENDERER_COPY = "C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\products\\jarvis-cole\\electron\\renderer\\orb-smoke-v6.mp4";

// Prompt emphasizes DENSE, INTERIOR, FULLY-FILLED smoke — snow globe / lava lamp / fog inside glass.
// Explicitly forbids strands, wisps, and outward radiation (which is what v5 produced).
const PROMPT = [
  "Dense billowing smoke completely filling the interior of a glass sphere.",
  "Smoke is thick and opaque, fully fills the sphere from edge to edge with no gaps.",
  "Swirls continuously and hypnotically like the inside of a snow globe or lava lamp mid-cycle.",
  "Slow encompassing rotation, never reveals a direction, no individual strands or wisps.",
  "Warm coral, gold, and teal palette glowing from within.",
  "The glass sphere stays perfectly still — only the dense smoke inside churns and folds.",
  "Cinematic slow motion, soft dreamy light.",
].join(" ");

const NEGATIVE = [
  "wispy strands",
  "thin smoke",
  "stringy smoke",
  "smoke radiating outward",
  "smoke escaping the sphere",
  "empty center",
  "transparent smoke",
  "individual smoke trails",
  "directional smoke",
  "reversed motion",
  "motion stopping",
  "motion freezing",
  "palindrome",
  "smoke at the bottom",
  "liquid pool",
  "sphere moving",
  "distortion of the glass",
  "broken sphere",
  "blurry",
  "low quality",
].join(", ");

async function uploadImage(filePath, name) {
  if (!fs.existsSync(filePath)) throw new Error(`Image not found: ${filePath}`);
  console.log(`[orb-v6] uploading: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  const file = new File([buf], name, { type: "image/png" });
  const url = await fal.storage.upload(file);
  console.log(`[orb-v6] uploaded: ${url}`);
  return url;
}

async function generateClip(imageUrl) {
  console.log(`[orb-v6] calling Kling 2.5 turbo-pro image-to-video (5s)`);
  const result = await fal.subscribe(
    "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    {
      input: {
        prompt: PROMPT,
        image_url: imageUrl,
        duration: "5",
        negative_prompt: NEGATIVE,
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
    console.error("[orb-v6] unexpected fal response:", JSON.stringify(result).slice(0, 500));
    throw new Error("fal.ai returned no video URL");
  }
  console.log(`[orb-v6] clip ready: ${videoUrl}`);
  return videoUrl;
}

async function downloadVideo(url, outPath) {
  console.log(`[orb-v6] downloading -> ${outPath}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`[orb-v6] saved ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
}

function loopify(rawPath, loopPath) {
  // 5s raw source. Use middle 4s (0.5..4.5), then xfade last 1s of the trim
  // into the first 1s of a second copy of the trim -> 3s seamless loop.
  //
  // Filter graph:
  //   [0:v] trim 0.5..4.5 -> "a" (4s of dense swirl, middle of the cycle)
  //   [1:v] trim 0.5..1.5 -> "b" (1s starting frame)
  //   xfade a + b with 1s fade at offset=3 -> 4s output where the tail blends
  //   into the start frame, making the loop seam invisible.
  //
  // Densest smoke = least directional motion. The middle of a Kling clip is
  // where the model has settled away from the still-frame lock and before
  // it starts decelerating — best window for a loop point.
  console.log(`[orb-v6] loopify -> ${loopPath}`);
  const cmd = [
    "ffmpeg",
    "-y",
    `-i "${rawPath}"`,
    `-i "${rawPath}"`,
    `-filter_complex "[0:v]trim=0.5:4.5,setpts=PTS-STARTPTS[a];[1:v]trim=0.5:1.5,setpts=PTS-STARTPTS+3/TB[b];[a][b]xfade=transition=fade:duration=1:offset=3,format=yuv420p[v]"`,
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
  console.log(`[orb-v6] loop DONE: ${loopPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

function copyToRenderer(src, dst) {
  fs.copyFileSync(src, dst);
  console.log(`[orb-v6] copied to renderer: ${dst}`);
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  fal.config({ credentials: FAL_KEY });

  const stillUrl = await uploadImage(STILL_PATH, "smoke-still-1-lava-lamp.png");
  const videoUrl = await generateClip(stillUrl);
  await downloadVideo(videoUrl, RAW);

  loopify(RAW, LOOP_OUT);
  copyToRenderer(LOOP_OUT, RENDERER_COPY);

  console.log("\n[orb-v6] DONE.");
  console.log(`  loop:     ${LOOP_OUT}`);
  console.log(`  renderer: ${RENDERER_COPY}`);
}

main().catch((err) => {
  console.error("[orb-v6] FATAL:", err);
  process.exit(1);
});
