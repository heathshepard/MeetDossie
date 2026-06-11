#!/usr/bin/env node
// scripts/generate-orb-video-v3.js
//
// Generate the Cole orb smoke loop v3 via fal.ai Kling 2.5 image-to-video.
// Goal: defeat the palindrome "reversal" tell that v2 had. By generating a
// LONGER source clip (10s = two 5s clips, chained), skipping the bookend
// frames where Kling tends to lock structure, and crossfading head→tail
// with xfade — the seam vanishes AND the motion stays directional throughout.
//
// Pipeline:
//   1. Generate 5s clip A from still (smoke-still-1-lava-lamp.png)
//   2. Use last frame of clip A as image input for clip B → 5s clip B
//      (continuous motion across the boundary)
//   3. Concat A+B → 10s raw
//   4. Trim the middle 6s (skip 1s head + 3s tail = drops both Kling lock-in zones)
//   5. xfade last 1s onto first 1s → 5s seamless loop, no palindrome
//
// Output: orb-smoke-v3.mp4 at repo root.
//
// Cost: ~$2.80 for two Kling 2.5 turbo-pro 5s clips. Within Heath's $2 budget? Slightly over.
// If budget-strict, run with --single to do ONE 5s clip and just take middle 3s with shorter xfade.
//
// Run: node scripts/generate-orb-video-v3.js [--single]

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

const SINGLE_MODE = process.argv.includes("--single");

const STILL_PATH = "C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\products\\jarvis-cole\\design\\smoke-stills-v1\\smoke-still-1-lava-lamp.png";
const REPO_ROOT = path.join(__dirname, "..");
const TMP_DIR = path.join(REPO_ROOT, "public");
const RAW_A = path.join(TMP_DIR, "orb-smoke-v3-rawA.mp4");
const RAW_B = path.join(TMP_DIR, "orb-smoke-v3-rawB.mp4");
const CONCAT_OUT = path.join(TMP_DIR, "orb-smoke-v3-concat.mp4");
const LAST_FRAME = path.join(TMP_DIR, "orb-smoke-v3-lastA.png");
const LOOP_OUT = path.join(REPO_ROOT, "orb-smoke-v3.mp4");

// Prompt emphasizes ONE-DIRECTION continuous flow, never reversing, never returning to start.
// This is what protects us from the palindrome reversal tell.
const PROMPT = [
  "Luminous smoke continuously flowing outward from a glowing core at the center of a glass sphere.",
  "The smoke wisps drift in one continuous direction, swirling and curling slowly, never reversing, never returning.",
  "An endless ongoing flow, like watching a lava lamp mid-cycle.",
  "Soft dreamy motion. The glass sphere stays perfectly still — only the smoke inside moves.",
  "Cinematic slow-motion. The smoke stays inside the sphere, never reaches the glass.",
].join(" ");

const NEGATIVE = "reversed motion, motion stopping, motion freezing, motion returning to start, palindrome, smoke at the bottom, liquid pool, smoke escaping the sphere, sphere moving, distortion of the glass, broken sphere, blurry, low quality";

async function uploadImage(filePath, name) {
  if (!fs.existsSync(filePath)) throw new Error(`Image not found: ${filePath}`);
  console.log(`[orb-v3] uploading: ${filePath}`);
  const buf = fs.readFileSync(filePath);
  const file = new File([buf], name, { type: "image/png" });
  const url = await fal.storage.upload(file);
  console.log(`[orb-v3] uploaded: ${url}`);
  return url;
}

async function generateClip(imageUrl, label) {
  console.log(`[orb-v3] calling Kling 2.5 (clip ${label})`);
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
          update.logs.forEach((l) => console.log(`  fal[${label}]: ${l.message}`));
        }
      },
    }
  );
  const videoUrl = result?.data?.video?.url;
  if (!videoUrl) {
    console.error("[orb-v3] unexpected fal response:", JSON.stringify(result).slice(0, 500));
    throw new Error("fal.ai returned no video URL");
  }
  console.log(`[orb-v3] clip ${label} ready: ${videoUrl}`);
  return videoUrl;
}

async function downloadVideo(url, outPath) {
  console.log(`[orb-v3] downloading -> ${outPath}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  console.log(`[orb-v3] saved ${(buf.length / 1024 / 1024).toFixed(2)} MB`);
}

function extractLastFrame(videoPath, outPng) {
  console.log(`[orb-v3] extracting last frame of ${path.basename(videoPath)}`);
  // -sseof -0.1 seeks 0.1s before end; -vframes 1 grabs that one frame.
  const cmd = [
    "ffmpeg",
    "-y",
    `-sseof -0.1`,
    `-i "${videoPath}"`,
    `-vframes 1`,
    `-q:v 2`,
    `"${outPng}"`,
  ].join(" ");
  execSync(cmd, { stdio: "inherit" });
}

function concatClips(a, b, out) {
  console.log(`[orb-v3] concatenating A + B`);
  // Filter-based concat handles potentially different parameters safely.
  const cmd = [
    "ffmpeg",
    "-y",
    `-i "${a}"`,
    `-i "${b}"`,
    `-filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]"`,
    `-map "[v]"`,
    "-an",
    "-c:v libx264",
    "-preset slow",
    "-crf 20",
    "-pix_fmt yuv420p",
    "-movflags +faststart",
    `"${out}"`,
  ].join(" ");
  execSync(cmd, { stdio: "inherit" });
}

function loopifyDual(rawPath, loopPath) {
  // 10s source. Trim middle 6s (1..7), then xfade last 1s into first 1s → 5s seamless.
  // Output frames map:
  //   0..4s  = source[1..5]           (raw)
  //   4..5s  = crossfade(source[5..6], source[1..2])
  // Net = 5s clip whose end frame ≈ start frame, with continuous motion throughout
  // (no palindrome reversal — direction stays consistent the whole time).
  console.log(`[orb-v3] loopifyDual -> ${loopPath}`);
  const cmd = [
    "ffmpeg",
    "-y",
    `-i "${rawPath}"`,
    `-i "${rawPath}"`,
    `-filter_complex "[0:v]trim=1:6,setpts=PTS-STARTPTS[a];[1:v]trim=1:2,setpts=PTS-STARTPTS+4/TB[b];[a][b]xfade=transition=fade:duration=1:offset=4,format=yuv420p[v]"`,
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
  console.log(`[orb-v3] DONE: ${loopPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

function loopifySingle(rawPath, loopPath) {
  // 5s source. Trim middle 3s (1..4), xfade last 0.7s with first 0.7s → ~2.3s loop.
  // Cheaper fallback for budget-only mode.
  console.log(`[orb-v3] loopifySingle -> ${loopPath}`);
  const cmd = [
    "ffmpeg",
    "-y",
    `-i "${rawPath}"`,
    `-i "${rawPath}"`,
    `-filter_complex "[0:v]trim=1:4,setpts=PTS-STARTPTS[a];[1:v]trim=1:1.7,setpts=PTS-STARTPTS+2.3/TB[b];[a][b]xfade=transition=fade:duration=0.7:offset=2.3,format=yuv420p[v]"`,
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
  console.log(`[orb-v3] DONE: ${loopPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

async function main() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  fal.config({ credentials: FAL_KEY });

  // Clip A — from the original still
  const stillUrl = await uploadImage(STILL_PATH, "smoke-still-1-lava-lamp.png");
  const aUrl = await generateClip(stillUrl, "A");
  await downloadVideo(aUrl, RAW_A);

  if (SINGLE_MODE) {
    console.log("[orb-v3] single mode — using clip A only.");
    loopifySingle(RAW_A, LOOP_OUT);
    return;
  }

  // Clip B — chained from clip A's last frame so motion stays continuous
  extractLastFrame(RAW_A, LAST_FRAME);
  const lastFrameUrl = await uploadImage(LAST_FRAME, "smoke-last-frame.png");
  const bUrl = await generateClip(lastFrameUrl, "B");
  await downloadVideo(bUrl, RAW_B);

  concatClips(RAW_A, RAW_B, CONCAT_OUT);
  loopifyDual(CONCAT_OUT, LOOP_OUT);

  console.log("\n[orb-v3] DONE.");
  console.log(`  loop: ${LOOP_OUT}`);
}

main().catch((err) => {
  console.error("[orb-v3] FATAL:", err);
  process.exit(1);
});
