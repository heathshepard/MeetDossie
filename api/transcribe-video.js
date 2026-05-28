// Vercel Serverless Function: /api/transcribe-video
// Downloads a Telegram video by file_id, transcribes via OpenAI Whisper,
// posts the transcript back to Telegram chat.
//
// Auth: Authorization: Bearer ${CRON_SECRET} (for manual/external calls)
//       OR called server-side from claudy-webhook.js without auth check
//
// POST body: { file_id, chat_id, message_id }
//
// Env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, CRON_SECRET
//
// maxDuration: 60s (set in vercel.json)
// Node 18+ required for global FormData + fetch

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_FILE_BYTES = 24 * 1024 * 1024; // 24 MB — Whisper API hard limit

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function tgSendMessage(chatId, text, replyToMessageId) {
  const body = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text2 = await res.text();
  let data = null;
  try { data = text2 ? JSON.parse(text2) : null; } catch { data = null; }
  if (!res.ok || data?.ok === false) {
    console.error('[transcribe-video] tgSendMessage failed:', res.status, text2.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true, data };
}

// ─── Core transcription logic ─────────────────────────────────────────────────

async function transcribeVideo({ file_id, chat_id, message_id }) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[transcribe-video] TELEGRAM_BOT_TOKEN not set');
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' };
  }
  if (!OPENAI_API_KEY) {
    await tgSendMessage(chat_id, 'Transcription is not configured yet — OPENAI_API_KEY missing.', message_id);
    return { ok: false, error: 'OPENAI_API_KEY not configured' };
  }

  // Step 1: Get file path from Telegram
  console.log('[transcribe-video] getFile for file_id:', file_id);
  const getFileRes = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(file_id)}`,
  );
  const getFileData = await getFileRes.json().catch(() => null);

  if (!getFileRes.ok || !getFileData?.ok || !getFileData?.result?.file_path) {
    const errMsg = `Could not retrieve file info from Telegram. ${getFileData?.description || ''}`.trim();
    console.error('[transcribe-video] getFile failed:', errMsg);
    await tgSendMessage(chat_id, `Transcription failed: ${errMsg}`, message_id);
    return { ok: false, error: errMsg };
  }

  const filePath = getFileData.result.file_path;
  const fileSize = getFileData.result.file_size || 0;
  console.log('[transcribe-video] file_path:', filePath, 'size:', fileSize);

  // Step 2: Check file size before downloading
  if (fileSize > MAX_FILE_BYTES) {
    const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    const msg = `Video is too large to transcribe (${sizeMB} MB). Whisper accepts up to 24 MB. Trim the video and try again.`;
    await tgSendMessage(chat_id, msg, message_id);
    return { ok: false, error: 'file_too_large', size: fileSize };
  }

  // Step 3: Download the file as a Buffer
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
  console.log('[transcribe-video] downloading from Telegram...');
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    const errMsg = `Could not download file from Telegram (HTTP ${downloadRes.status}).`;
    console.error('[transcribe-video] download failed:', downloadRes.status);
    await tgSendMessage(chat_id, `Transcription failed: ${errMsg}`, message_id);
    return { ok: false, error: errMsg };
  }

  const arrayBuffer = await downloadRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log('[transcribe-video] downloaded', buffer.length, 'bytes');

  // Secondary size guard (file_size can be 0 if Telegram didn't report it)
  if (buffer.length > MAX_FILE_BYTES) {
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
    const msg = `Video is too large to transcribe (${sizeMB} MB). Whisper accepts up to 24 MB. Trim the video and try again.`;
    await tgSendMessage(chat_id, msg, message_id);
    return { ok: false, error: 'file_too_large', size: buffer.length };
  }

  // Step 4: Send to OpenAI Whisper via multipart/form-data
  // Node 18+ global FormData is available. We use a Blob so FormData sets
  // the correct MIME type and filename in the Content-Disposition header.
  console.log('[transcribe-video] sending to Whisper...');
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');
  // Blob with MIME type so Whisper recognises the format
  const blob = new Blob([buffer], { type: 'video/mp4' });
  form.append('file', blob, 'audio.mp4');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      // Do NOT set Content-Type manually — fetch sets it with the boundary automatically
    },
    body: form,
  });

  if (!whisperRes.ok) {
    const errBody = await whisperRes.text().catch(() => '');
    console.error('[transcribe-video] Whisper API error:', whisperRes.status, errBody.slice(0, 300));
    const errMsg = `Whisper transcription failed (HTTP ${whisperRes.status}): ${errBody.slice(0, 200)}`;
    await tgSendMessage(chat_id, errMsg, message_id);
    return { ok: false, error: errMsg };
  }

  // response_format=text returns a plain text body (not JSON)
  const transcript = (await whisperRes.text()).trim();
  console.log('[transcribe-video] transcript length:', transcript.length);

  if (!transcript) {
    const msg = 'Whisper returned an empty transcript. The video may have no audible speech.';
    await tgSendMessage(chat_id, msg, message_id);
    return { ok: false, error: 'empty_transcript' };
  }

  // Step 5: Post transcript back to Telegram
  // Telegram message limit is 4096 chars. Split if necessary.
  const header = 'Transcript:\n\n';
  const maxBody = 4096 - header.length;

  if (transcript.length <= maxBody) {
    await tgSendMessage(chat_id, `${header}${transcript}`, message_id);
  } else {
    // Send first chunk as a reply, subsequent chunks as follow-ups
    const chunks = [];
    let remaining = transcript;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, 4096));
      remaining = remaining.slice(4096);
    }
    await tgSendMessage(chat_id, `${header}${chunks[0]}`, message_id);
    for (let i = 1; i < chunks.length; i++) {
      await tgSendMessage(chat_id, chunks[i], null);
    }
  }

  console.log('[transcribe-video] done');
  return { ok: true, transcriptLength: transcript.length };
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Auth: Bearer CRON_SECRET for external calls.
  // Internal calls from claudy-webhook.js skip auth by passing x-internal: 1.
  const isInternal = req.headers['x-internal'] === '1';
  if (!isInternal) {
    const auth = req.headers.authorization || '';
    if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  // Parse body
  let body = req.body;
  if (!body || typeof body !== 'object') {
    const raw = await new Promise((resolve, reject) => {
      let s = '';
      req.on('data', (c) => { s += c.toString('utf8'); });
      req.on('end', () => resolve(s));
      req.on('error', reject);
    });
    try { body = JSON.parse(raw); } catch { body = {}; }
  }

  const { file_id, chat_id, message_id } = body;
  if (!file_id || !chat_id) {
    return res.status(400).json({ ok: false, error: 'file_id and chat_id are required' });
  }

  const result = await transcribeVideo({
    file_id: String(file_id),
    chat_id: String(chat_id),
    message_id: message_id || null,
  });

  return res.status(result.ok ? 200 : 500).json(result);
};

// Export core logic for direct use by claudy-webhook.js
module.exports.transcribeVideo = transcribeVideo;
