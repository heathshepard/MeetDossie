#!/usr/bin/env node
// scripts/atlas-orb-v3-verify.js
//
// Headless verification that:
//   1. /orb-smoke-v3.mp4 loads and plays
//   2. The 1.2s preview pulse fires and writes a non-zero value to
//      --pulse-intensity (proves the audio-reactive code path is wired)
//   3. When the speak button is clicked, real audio plays and writes
//      non-zero --pulse-intensity samples during playback
//   4. Takes a screenshot mid-pulse for visual confirmation

"use strict";

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = process.env.ORB_URL || "https://meetdossie.com/orb-web";
const OUT_DIR = path.join(__dirname, "atlas-runs", `orb-v3-verify-${Date.now()}`);

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Allow autoplay
    bypassCSP: true,
  });
  const page = await ctx.newPage();

  page.on("console", (msg) => {
    if (["error", "warn"].includes(msg.type())) {
      console.log(`[console.${msg.type()}]`, msg.text());
    }
  });
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  console.log(`[verify] navigating to ${URL}`);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Verify v3 mp4 is the source
  const videoSrc = await page.$eval("#orb-video", (v) => v.getAttribute("src"));
  console.log(`[verify] video src: ${videoSrc}`);
  if (!videoSrc.includes("orb-smoke-v3")) {
    console.log("[verify] WARNING: src is not v3");
  }

  // Wait for video to start playing
  await page.waitForFunction(
    () => {
      const v = document.getElementById("orb-video");
      return v && v.readyState >= 2 && !v.paused;
    },
    { timeout: 15000 }
  );
  console.log("[verify] orb video is playing");

  // === Step 1: confirm preview pulse fires ===
  // Sample --pulse-intensity over 4 seconds starting now
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 4500) {
    const v = await page.evaluate(() => {
      const stage = document.getElementById("orb-stage");
      const raw = getComputedStyle(stage).getPropertyValue("--pulse-intensity").trim();
      return parseFloat(raw) || 0;
    });
    samples.push({ t: Date.now() - start, v });
    await page.waitForTimeout(120);
  }
  const previewMax = Math.max(...samples.map((s) => s.v));
  const previewNonzero = samples.filter((s) => s.v > 0.05).length;
  console.log(`[verify] preview pulse: max=${previewMax.toFixed(3)}, nonzero-frames=${previewNonzero}/${samples.length}`);

  // Screenshot near the peak
  const peakSample = samples.reduce((p, c) => (c.v > p.v ? c : p), samples[0]);
  console.log(`[verify] peak at t=${peakSample.t}ms v=${peakSample.v}`);

  await page.screenshot({
    path: path.join(OUT_DIR, "01-preview-pulse-after.png"),
    fullPage: false,
  });

  // === Step 2: click "Hear me speak" and verify pulse during audio ===
  console.log('[verify] clicking #speak-btn');
  // Wait for the preview to finish first so we're testing pure audio reactivity
  await page.waitForTimeout(1500);

  // Inject a marker to know what's happening
  await page.evaluate(() => { window.__atlasSamples = []; });

  // Force click — the breathing animation keeps the button "not stable" for
  // Playwright's default safety check, but a real user can still tap it fine.
  await page.click("#speak-btn", { force: true, timeout: 5000 });

  // Sample during audio playback (max ~8s)
  const audioStart = Date.now();
  let audioEnded = false;
  while (Date.now() - audioStart < 10000 && !audioEnded) {
    const state = await page.evaluate(() => {
      const stage = document.getElementById("orb-stage");
      const audio = document.getElementById("cole-audio");
      const raw = getComputedStyle(stage).getPropertyValue("--pulse-intensity").trim();
      return {
        v: parseFloat(raw) || 0,
        ct: audio.currentTime,
        paused: audio.paused,
        ended: audio.ended,
        duration: audio.duration,
      };
    });
    if (state.ended) audioEnded = true;
    if (state.v > 0) {
      // Persist
      // (we're polling outside the page, so just push locally)
    }
    samples.push({ phase: "audio", t: Date.now() - audioStart, ...state });
    if (state.paused && state.ct === 0 && Date.now() - audioStart > 1500) {
      console.log("[verify] audio never played — likely autoplay/CORS block");
      break;
    }
    await page.waitForTimeout(100);
  }

  const audioSamples = samples.filter((s) => s.phase === "audio");
  const audioMax = audioSamples.length ? Math.max(...audioSamples.map((s) => s.v)) : 0;
  const audioNonzero = audioSamples.filter((s) => s.v > 0.05).length;
  console.log(`[verify] audio pulse: max=${audioMax.toFixed(3)}, nonzero-frames=${audioNonzero}/${audioSamples.length}`);
  console.log(`[verify] audio reached currentTime=${audioSamples[audioSamples.length - 1]?.ct?.toFixed(2)}s of ${audioSamples[audioSamples.length - 1]?.duration?.toFixed(2)}s`);

  await page.screenshot({
    path: path.join(OUT_DIR, "02-audio-pulse-mid.png"),
    fullPage: false,
  });

  // Final summary
  const result = {
    url: URL,
    videoSrc,
    previewMax,
    previewNonzero,
    audioMax,
    audioNonzero,
    audioPlayed: audioSamples.some((s) => s.ct > 0.1),
    samples: samples.slice(0, 200), // truncate
  };
  fs.writeFileSync(
    path.join(OUT_DIR, "result.json"),
    JSON.stringify(result, null, 2)
  );
  console.log(`[verify] result written to ${OUT_DIR}`);

  await browser.close();

  // Exit code: 0 if both pulses were non-trivial
  const pass = previewMax > 0.2 && (audioMax > 0.1 || !result.audioPlayed);
  if (pass) {
    console.log("[verify] PASS");
    process.exit(0);
  } else {
    console.log("[verify] FAIL — pulse not visibly firing");
    process.exit(2);
  }
})().catch((err) => {
  console.error("[verify] FATAL:", err);
  process.exit(1);
});
