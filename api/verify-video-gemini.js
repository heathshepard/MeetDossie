// Vercel Serverless Function: /api/verify-video-gemini
// Sage's eyes on the finished video — uploads to Gemini Files API,
// runs her quality checklist, returns a structured verdict.
//
// POST /api/verify-video-gemini
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body: { videoUrl, checklist? }
//   videoUrl — any publicly accessible URL (Supabase Storage, Creatomate, Kling, etc.)
//   checklist — optional override string; uses Sage's default if omitted
// Returns: { ok, verdict, duration_estimate, audio_present, product_visible,
//             product_timestamp, cta_present, issues, full_report }
//
// Requires: GEMINI_API_KEY in Vercel env vars (get from aistudio.google.com)
// Model: gemini-1.5-flash (fast, cheap, handles video natively)
//
// On Gemini API failure or missing key, returns { ok: false, verdict: "SKIP" }
// so the pipeline never hard-blocks on verification failure.

const CRON_SECRET = process.env.CRON_SECRET;
// GEMINI_API_KEY must be set in Vercel env vars.
// Get it from: https://aistudio.google.com/app/apikey
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_FILES_API = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_GENERATE_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

const DEFAULT_CHECKLIST = `You are Sage, Head of Social Media for Dossie - a Texas real estate AI app. Review this video for quality and correctness. Answer each question with YES, NO, or a specific description.

1. AUDIO: Is audio present and audible throughout the entire video? Any silent gaps longer than 2 seconds?
2. OPENING: What appears in the first 3 seconds? Is there a clear visual hook?
3. PRODUCT: Does the Dossie app appear on screen at any point? If yes, at approximately what second?
4. CTA: Does the video end with a call to action? What does the final 5 seconds show?
5. PACING: Are there any jarring cuts, freeze frames, or black frames?
6. AUDIO QUALITY: Is the speaker's voice clear? Any wind noise, echo, or distortion?
7. DURATION: Approximately how long is the video?
8. VERDICT: PASS or FAIL - would you approve this for posting to TikTok and Instagram Reels?
9. IF FAIL: What specific fix is needed?`;

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!GEMINI_API_KEY) {
    console.warn('[verify-video-gemini] GEMINI_API_KEY not set - returning SKIP');
    return res.status(200).json({
      ok: false,
      error: 'GEMINI_API_KEY not configured. Add it to Vercel env vars from https://aistudio.google.com/app/apikey',
      verdict: 'SKIP',
    });
  }

  const { videoUrl, checklist } = req.body || {};

  if (!videoUrl || typeof videoUrl !== 'string') {
    return res.status(400).json({ ok: false, error: 'videoUrl is required' });
  }

  const prompt = checklist || DEFAULT_CHECKLIST;

  console.log(`[verify-video-gemini] Starting verification for: ${videoUrl.slice(0, 80)}...`);

  try {
    // Step 1: Download the video from the public URL
    let videoBuffer;
    try {
      const dlRes = await fetch(videoUrl);
      if (!dlRes.ok) {
        throw new Error(`Download failed: HTTP ${dlRes.status}`);
      }
      const arrayBuf = await dlRes.arrayBuffer();
      videoBuffer = Buffer.from(arrayBuf);
      console.log(`[verify-video-gemini] Downloaded ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB`);
    } catch (dlErr) {
      console.error('[verify-video-gemini] Download error:', dlErr.message);
      return res.status(200).json({
        ok: false,
        error: `Could not download video: ${dlErr.message}`,
        verdict: 'SKIP',
      });
    }

    // Step 2: Upload to Gemini Files API (resumable upload)
    let fileUri;
    try {
      // Initiate the resumable upload
      const initRes = await fetch(`${GEMINI_FILES_API}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': videoBuffer.length.toString(),
          'X-Goog-Upload-Header-Content-Type': 'video/mp4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file: { display_name: 'dossie-verify-' + Date.now() },
        }),
      });

      if (!initRes.ok) {
        const errText = await initRes.text();
        throw new Error(`Gemini upload init failed: ${initRes.status} ${errText.slice(0, 200)}`);
      }

      const uploadUrl = initRes.headers.get('x-goog-upload-url');
      if (!uploadUrl) {
        throw new Error('Gemini did not return an upload URL');
      }

      // Upload the actual bytes
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Length': videoBuffer.length.toString(),
          'X-Goog-Upload-Offset': '0',
          'X-Goog-Upload-Command': 'upload, finalize',
        },
        body: videoBuffer,
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Gemini upload failed: ${uploadRes.status} ${errText.slice(0, 200)}`);
      }

      const uploadData = await uploadRes.json();
      fileUri = uploadData.file && uploadData.file.uri;
      if (!fileUri) {
        throw new Error('Gemini returned no file URI after upload');
      }
      console.log(`[verify-video-gemini] Uploaded to Gemini. fileUri: ${fileUri}`);
    } catch (uploadErr) {
      console.error('[verify-video-gemini] Upload error:', uploadErr.message);
      return res.status(200).json({
        ok: false,
        error: `Gemini upload failed: ${uploadErr.message}`,
        verdict: 'SKIP',
      });
    }

    // Step 3: Poll for file to be ACTIVE (Gemini processes the video async)
    try {
      const fileId = fileUri.split('/').pop();
      const pollUrl = `https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${GEMINI_API_KEY}`;
      let state = 'PROCESSING';
      let attempts = 0;

      while (state === 'PROCESSING' && attempts < 20) {
        await new Promise(r => setTimeout(r, 3000));
        const pollRes = await fetch(pollUrl);
        if (pollRes.ok) {
          const pollData = await pollRes.json();
          state = pollData.state || 'PROCESSING';
        }
        attempts++;
      }

      if (state !== 'ACTIVE') {
        throw new Error(`File stuck in state: ${state} after ${attempts} polls`);
      }
      console.log('[verify-video-gemini] File ACTIVE after', attempts, 'polls');
    } catch (pollErr) {
      console.error('[verify-video-gemini] Poll error:', pollErr.message);
      return res.status(200).json({
        ok: false,
        error: `Gemini file processing failed: ${pollErr.message}`,
        verdict: 'SKIP',
      });
    }

    // Step 4: Run the checklist via generateContent
    let rawReport;
    try {
      const genRes = await fetch(`${GEMINI_GENERATE_API}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { file_data: { mime_type: 'video/mp4', file_uri: fileUri } },
                { text: prompt },
              ],
            },
          ],
          generation_config: {
            temperature: 0.1,
            max_output_tokens: 1024,
          },
        }),
      });

      if (!genRes.ok) {
        const errText = await genRes.text();
        throw new Error(`Gemini generateContent failed: ${genRes.status} ${errText.slice(0, 200)}`);
      }

      const genData = await genRes.json();
      rawReport = genData.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!rawReport) {
        throw new Error('Gemini returned empty response');
      }
      console.log('[verify-video-gemini] Report received, length:', rawReport.length);
    } catch (genErr) {
      console.error('[verify-video-gemini] generateContent error:', genErr.message);
      return res.status(200).json({
        ok: false,
        error: `Gemini analysis failed: ${genErr.message}`,
        verdict: 'SKIP',
      });
    }

    // Step 5: Parse the report into structured fields
    const upper = rawReport.toUpperCase();
    const verdict = upper.includes('VERDICT: PASS') || upper.includes('8. PASS') || upper.includes('VERDICT: PASS')
      ? 'PASS'
      : upper.includes('VERDICT: FAIL') || upper.includes('8. FAIL')
      ? 'FAIL'
      : upper.includes('PASS')
      ? 'PASS'
      : 'FAIL';

    const audioPresent = upper.includes('1.') && !upper.includes('NO AUDIO') && !upper.includes('AUDIO: NO');
    const productVisible = upper.includes('DOSSIE APP') || upper.includes('PRODUCT: YES');
    const ctaPresent = upper.includes('CTA: YES') || upper.includes('CALL TO ACTION') || upper.includes('MEETDOSSIE');

    // Extract duration estimate
    const durMatch = rawReport.match(/(\d+)\s*(?:seconds?|s\b|sec)/i);
    const durationEstimate = durMatch ? `${durMatch[1]} seconds` : 'unknown';

    // Extract product timestamp
    const tsMatch = rawReport.match(/(?:~?(\d+)\s*s(?:ec(?:ond)?s?)?|at\s+(?:approximately\s+)?(\d+)\s*s)/i);
    const productTimestamp = tsMatch ? `~${tsMatch[1] || tsMatch[2]}s` : null;

    // Extract issues: lines that mention FAIL, NO, or specific problems in answers 1-7
    const issues = [];
    const lines = rawReport.split('\n');
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      if (/^[1-7]\./i.test(l) && /\bno\b|fail|issue|problem|jarring|silent|distort|echo/i.test(l)) {
        issues.push(l);
      }
    }

    // Clean up Gemini file (best-effort, don't fail if this errors)
    try {
      const fileId = fileUri.split('/').pop();
      await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${fileId}?key=${GEMINI_API_KEY}`, {
        method: 'DELETE',
      });
    } catch (_) {}

    console.log(`[verify-video-gemini] Done. verdict=${verdict}`);

    return res.status(200).json({
      ok: true,
      verdict,
      duration_estimate: durationEstimate,
      audio_present: audioPresent,
      product_visible: productVisible,
      product_timestamp: productTimestamp,
      cta_present: ctaPresent,
      issues,
      full_report: rawReport,
    });

  } catch (err) {
    console.error('[verify-video-gemini] Unexpected error:', err.message);
    return res.status(200).json({
      ok: false,
      error: err.message || 'Unexpected error',
      verdict: 'SKIP',
    });
  }
};
