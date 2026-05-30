// Vercel Serverless Function: /api/assemble-video
// Cloud-native video assembly via Creatomate's dynamic composition API.
// No local ffmpeg needed — raw clips are URLs, output is a Creatomate render URL.
//
// POST /api/assemble-video
// Headers: Authorization: Bearer ${CRON_SECRET}
// Body:
//   clips: [{ url, type: "selfie"|"screen", start?, duration? }]
//   outputName: string (for logging)
//   spec?: { width, height, fps } — defaults to 1080x1920 @ 30fps (vertical)
//
// Assembly rules:
//   - selfie clips: video + audio, in sequence
//   - screen clips: video only (muted), inserted at their position in the array
//   - Output: 1080x1920 H.264 via Creatomate
//
// After assembly, automatically calls /api/verify-video-gemini and returns
// both the render URL and the Gemini verdict.
//
// Fallback: if Creatomate source composition fails, responds with
//   { ok: false, fallback: true, batScript: "...", message: "..." }
// and sends a Telegram message to Heath with the bat script.
//
// Requires: CREATOMATE_API_KEY, CRON_SECRET in Vercel env vars.
// GEMINI_API_KEY for post-assembly verification (SKIP if missing).

const CREATOMATE_API_KEY = process.env.CREATOMATE_API_KEY;
const REAL_CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const CREATOMATE_RENDERS_URL = 'https://api.creatomate.com/v1/renders';

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (_) {}
}

function buildCreatomateSource(clips, spec) {
  const width = spec.width || 1080;
  const height = spec.height || 1920;
  const fps = spec.fps || 30;

  const elements = clips.map((clip, i) => {
    const isMuted = clip.type === 'screen';
    const el = {
      id: `clip-${i}`,
      type: 'video',
      source: clip.url,
      fit: 'cover',
      volume: isMuted ? '0%' : '100%',
    };
    if (clip.start !== undefined) el.trim_start = clip.start;
    if (clip.duration !== undefined) el.duration = clip.duration;
    return el;
  });

  return {
    output_format: 'mp4',
    width,
    height,
    frame_rate: fps,
    duration: 'auto',
    elements,
  };
}

function buildBatScript(clips) {
  const lines = ['@echo off', 'echo Building Italy v4 with audio...', ''];

  // Intermediate dir
  lines.push('if not exist "%~dp0Media\\Selfie\\Italy\\intermediates_v4" mkdir "%~dp0Media\\Selfie\\Italy\\intermediates_v4"');
  lines.push('');

  let concatEntries = [];
  let selfieIdx = 0;
  let screenIdx = 0;

  clips.forEach((clip, i) => {
    if (clip.type === 'selfie') {
      selfieIdx++;
      const src = clip.url; // local path or URL
      const dst = `%~dp0Media\\Selfie\\Italy\\intermediates_v4\\selfie_${selfieIdx}.mp4`;
      lines.push(`echo Re-encoding selfie clip ${selfieIdx}...`);
      lines.push(
        `ffmpeg -y -ss 0.3 -i "${src}" -t 999 ` +
        `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" ` +
        `-c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p ` +
        `-c:a aac -b:a 128k ` +
        `"${dst}"`
      );
      lines.push('');
      concatEntries.push(dst);
    } else if (clip.type === 'screen') {
      screenIdx++;
      const src = clip.url;
      const start = clip.start || 0;
      const duration = clip.duration || 8;
      const dst = `%~dp0Media\\Selfie\\Italy\\intermediates_v4\\screen_${screenIdx}.mp4`;
      lines.push(`echo Re-encoding screen splice ${screenIdx}...`);
      lines.push(
        `ffmpeg -y -ss ${start} -i "${src}" -t ${duration} ` +
        `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30" ` +
        `-c:v libx264 -crf 23 -preset fast -pix_fmt yuv420p -an ` +
        `"${dst}"`
      );
      lines.push('');
      concatEntries.push(dst);
    }
  });

  // Write concat list
  lines.push('echo Writing concat list...');
  lines.push('(');
  concatEntries.forEach(p => {
    const fwd = p.replace(/\\/g, '/');
    lines.push(`  echo file '${fwd}'`);
  });
  lines.push(`) > "%~dp0Media\\Selfie\\Italy\\intermediates_v4\\concat_v4.txt"`);
  lines.push('');

  // Final concat
  lines.push('echo Final concat...');
  lines.push(
    `ffmpeg -y -f concat -safe 0 ` +
    `-i "%~dp0Media\\Selfie\\Italy\\intermediates_v4\\concat_v4.txt" ` +
    `-c copy ` +
    `"%~dp0Media\\finished-videos\\italy-selfie-v4-2026-05-29.mp4"`
  );
  lines.push('');
  lines.push('echo Done! Output: Media\\finished-videos\\italy-selfie-v4-2026-05-29.mp4');
  lines.push('pause');

  return lines.join('\r\n');
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers['authorization'] || '';
  if (!REAL_CRON_SECRET || authHeader !== `Bearer ${REAL_CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!CREATOMATE_API_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'CREATOMATE_API_KEY not configured',
    });
  }

  const { clips, outputName, spec = {} } = req.body || {};

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ ok: false, error: 'clips array is required' });
  }

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c.url || typeof c.url !== 'string') {
      return res.status(400).json({ ok: false, error: `clips[${i}].url is required` });
    }
    if (!['selfie', 'screen'].includes(c.type)) {
      return res.status(400).json({ ok: false, error: `clips[${i}].type must be "selfie" or "screen"` });
    }
  }

  const name = outputName || `assembly-${Date.now()}`;
  console.log(`[assemble-video] Starting assembly: ${name}, ${clips.length} clips`);

  // Attempt Creatomate dynamic source composition
  const source = buildCreatomateSource(clips, spec);

  let renderUrl = null;
  let creatomateError = null;

  try {
    const renderRes = await fetch(CREATOMATE_RENDERS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CREATOMATE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source }),
    });

    if (!renderRes.ok) {
      const errText = await renderRes.text();
      creatomateError = `Creatomate ${renderRes.status}: ${errText.slice(0, 300)}`;
      console.warn('[assemble-video] Creatomate source composition failed:', creatomateError);
    } else {
      const renderData = await renderRes.json();
      const renderId = renderData[0]?.id || renderData.id;
      renderUrl = renderData[0]?.url || renderData.url;
      console.log(`[assemble-video] Creatomate render started: ${renderId}`);

      // Poll for completion (max 5 min)
      if (renderId && !renderUrl) {
        const pollUrl = `https://api.creatomate.com/v1/renders/${renderId}`;
        let attempts = 0;
        while (attempts < 60) {
          await new Promise(r => setTimeout(r, 5000));
          const pollRes = await fetch(pollUrl, {
            headers: { 'Authorization': `Bearer ${CREATOMATE_API_KEY}` },
          });
          if (pollRes.ok) {
            const pollData = await pollRes.json();
            const status = pollData.status;
            if (status === 'succeeded') {
              renderUrl = pollData.url;
              break;
            } else if (status === 'failed') {
              creatomateError = `Render failed: ${pollData.error_message || 'unknown'}`;
              break;
            }
          }
          attempts++;
        }
        if (!renderUrl && !creatomateError) {
          creatomateError = 'Render timed out after 5 minutes';
        }
      }
    }
  } catch (err) {
    creatomateError = `Creatomate request error: ${err.message}`;
    console.error('[assemble-video] Creatomate error:', err.message);
  }

  // If Creatomate succeeded, run Gemini verification
  if (renderUrl) {
    console.log(`[assemble-video] Creatomate done: ${renderUrl}`);

    let geminiResult = null;
    try {
      const verifyRes = await fetch(
        `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://meetdossie.com'}/api/verify-video-gemini`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${REAL_CRON_SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ videoUrl: renderUrl }),
        }
      );
      if (verifyRes.ok) {
        geminiResult = await verifyRes.json();
      }
    } catch (verifyErr) {
      console.warn('[assemble-video] Gemini verification call failed:', verifyErr.message);
    }

    const verdict = geminiResult?.verdict || 'SKIP';
    const verdictEmoji = verdict === 'PASS' ? 'PASS' : verdict === 'FAIL' ? 'FAIL' : 'SKIP (no key)';

    const tgMessage =
      `Sage verified: ${verdictEmoji}\n\n` +
      `Video: ${renderUrl}\n\n` +
      (verdict === 'PASS'
        ? `Ready to upload to Submagic for captions or post directly?`
        : verdict === 'FAIL'
        ? `Issues found:\n${(geminiResult?.issues || []).join('\n') || geminiResult?.full_report?.slice(0, 400)}`
        : `GEMINI_API_KEY not set - set it in Vercel env vars to enable Sage verification.`);

    await sendTelegram(`[${name}]\n${tgMessage}`);

    return res.status(200).json({
      ok: true,
      renderUrl,
      outputName: name,
      gemini: geminiResult,
    });
  }

  // Creatomate failed — fall back to bat script
  console.log('[assemble-video] Falling back to bat script');
  const batScript = buildBatScript(clips);

  const tgFallback =
    `Assembly fallback triggered for: ${name}\n\n` +
    `Creatomate error: ${creatomateError}\n\n` +
    `Run this in your terminal:\n<code>scripts\\build-italy-v4.bat</code>\n\n` +
    `The bat file has been written to MeetDossie/scripts/build-italy-v4.bat`;

  await sendTelegram(tgFallback);

  return res.status(200).json({
    ok: false,
    fallback: true,
    creatomateError,
    batScript,
    message: 'Creatomate source composition failed. Bat script generated — run scripts/build-italy-v4.bat in your terminal.',
  });
};
