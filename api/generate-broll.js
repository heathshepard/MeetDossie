// Vercel Serverless Function: /api/generate-broll
// Generates AI b-roll video clips via fal.ai Kling 2.5 from a text prompt.
//
// POST /api/generate-broll
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body: { prompt, duration_seconds, aspect_ratio }
// Returns: { url, duration, model }
//
// Cost: ~$0.168/sec via fal.ai pay-as-you-go (FAL_KEY env var).
// Duration options: 5 or 10 seconds.
// Aspect ratio options: "9:16" (vertical/Reels), "16:9" (landscape), "1:1" (square).

const { fal } = require("@fal-ai/client");

const CRON_SECRET = process.env.CRON_SECRET;
const FAL_KEY = process.env.FAL_KEY;

const VALID_DURATIONS = [5, 10];
const VALID_ASPECT_RATIOS = ["9:16", "16:9", "1:1"];
const DEFAULT_ASPECT_RATIO = "9:16";
const DEFAULT_DURATION = 5;

module.exports = async function handler(req, res) {
  // Auth check — same pattern as all other cron/internal endpoints
  const authHeader = req.headers["authorization"] || "";
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!FAL_KEY) {
    return res.status(500).json({
      ok: false,
      error: "FAL_KEY not configured. Add it to Vercel env vars — sign up at fal.ai to get your key.",
    });
  }

  const {
    prompt,
    duration_seconds = DEFAULT_DURATION,
    aspect_ratio = DEFAULT_ASPECT_RATIO,
  } = req.body || {};

  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return res.status(400).json({ ok: false, error: "prompt is required" });
  }

  const duration = Number(duration_seconds);
  if (!VALID_DURATIONS.includes(duration)) {
    return res.status(400).json({
      ok: false,
      error: `duration_seconds must be one of: ${VALID_DURATIONS.join(", ")}`,
    });
  }

  if (!VALID_ASPECT_RATIOS.includes(aspect_ratio)) {
    return res.status(400).json({
      ok: false,
      error: `aspect_ratio must be one of: ${VALID_ASPECT_RATIOS.join(", ")}`,
    });
  }

  // Configure fal client with the API key from env
  fal.config({ credentials: FAL_KEY });

  console.log(`[generate-broll] prompt="${prompt.slice(0, 80)}..." duration=${duration}s aspect_ratio=${aspect_ratio}`);

  const result = await fal.subscribe(
    "fal-ai/kling-video/v2.5/standard/text-to-video",
    {
      input: {
        prompt: prompt.trim(),
        duration: duration.toString(),
        aspect_ratio: aspect_ratio,
      },
      pollInterval: 5000,
      logs: true,
    }
  );

  const videoUrl = result?.data?.video?.url;
  if (!videoUrl) {
    console.error("[generate-broll] unexpected fal.ai response shape:", JSON.stringify(result).slice(0, 500));
    return res.status(500).json({
      ok: false,
      error: "fal.ai returned no video URL — check logs for response shape",
      raw: result?.data || null,
    });
  }

  console.log(`[generate-broll] done. url=${videoUrl}`);

  return res.status(200).json({
    ok: true,
    url: videoUrl,
    duration: duration,
    model: "kling-2.5",
    aspect_ratio: aspect_ratio,
  });
};
