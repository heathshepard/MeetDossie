'use strict';

// Shared voice helpers for Telegram bots.
// STT via OpenAI Whisper, voice message send via Telegram API.
// TTS lives in api/_utils/tts.js (provider-abstracted).

async function transcribeVoice(fileId, botToken) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    console.warn('[voice] OPENAI_API_KEY not set — STT unavailable');
    return null;
  }

  console.log('[voice] getFile for', fileId);
  const fileRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
  );
  const fileData = await fileRes.json();
  if (!fileData.ok || !fileData.result?.file_path) {
    console.warn('[voice] getFile failed:', JSON.stringify(fileData).slice(0, 200));
    return null;
  }
  console.log('[voice] file_path:', fileData.result.file_path);

  const dlRes = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`,
  );
  if (!dlRes.ok) {
    console.warn('[voice] download failed:', dlRes.status);
    return null;
  }
  const audioBuffer = Buffer.from(await dlRes.arrayBuffer());
  console.log('[voice] downloaded', audioBuffer.length, 'bytes');

  const boundary = '----VoiceSTT' + Date.now();
  const ext = (fileData.result.file_path || '').split('.').pop() || 'ogg';
  const mime = ext === 'ogg' ? 'audio/ogg' : `audio/${ext}`;

  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`,
    audioBuffer,
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}--\r\n`,
  ];
  const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));

  console.log('[voice] calling Whisper...');
  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  if (!whisperRes.ok) {
    const errText = await whisperRes.text().catch(() => '');
    console.warn('[voice] Whisper failed:', whisperRes.status, errText.slice(0, 200));
    return null;
  }
  const whisperData = await whisperRes.json();
  console.log('[voice] transcribed:', (whisperData.text || '').slice(0, 80));
  return whisperData.text || null;
}

async function sendVoiceReply(chatId, audioBuffer, botToken) {
  const boundary = '----VoiceTTS' + Date.now();
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="reply.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    audioBuffer,
    `\r\n--${boundary}--\r\n`,
  ];
  const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendVoice`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    console.warn('[voice] sendVoice failed:', res.status);
  }
  return res.ok;
}

module.exports = { transcribeVoice, sendVoiceReply };
