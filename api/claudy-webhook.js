// Vercel Serverless Function: /api/claudy-webhook
// Webhook receiver for the Claudy personal bot (TELEGRAM_BOT_TOKEN).
//
// Handles:
//   - Video messages -> transcribe via Whisper + reply with transcript
//   - Voice messages (audio) -> same Whisper pipeline
//   - Text messages -> basic echo / DONE passthrough (DONE is handled by
//     Claude Code's polling loop; this webhook is for server-side features only)
//
// Register this webhook once:
//   curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
//     -d "url=https://meetdossie.com/api/claudy-webhook" \
//     -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
//
// IMPORTANT: After registering, do NOT run /api/delete-claudy-webhook or
// Claude Code's polling (getUpdates) will fight with this webhook and you'll
// miss messages. Pick one: webhook (this file) OR polling (DONE handler).
// Webhook is preferred for reliability.
//
// Auth: optional X-Telegram-Bot-Api-Secret-Token header check.
//       All state changes additionally validated via TELEGRAM_CHAT_ID match.
//
// Env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, CRON_SECRET,
//           TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET (optional)

const { transcribeVideo } = require('./transcribe-video');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function tgSend(method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || data?.ok === false) {
    console.error('[claudy-webhook] tg', method, 'failed:', res.status, text.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true, data };
}

function sendMessage(chatId, text, replyToMessageId) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  return tgSend('sendMessage', body);
}

// ─── Body reader ──────────────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      resolve(req.body);
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8'); });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── Video / audio handler ────────────────────────────────────────────────────

async function handleMediaMessage(msg) {
  const chatId = String(msg.chat?.id || '');
  const messageId = msg.message_id;

  // Security: only process from the configured chat
  if (TELEGRAM_CHAT_ID && chatId !== String(TELEGRAM_CHAT_ID)) {
    console.warn('[claudy-webhook] media from unauthorized chat:', chatId);
    return;
  }

  // Determine file_id from video or audio/voice
  let file_id = null;
  let mediaType = 'video';

  if (msg.video) {
    file_id = msg.video.file_id;
    mediaType = 'video';
  } else if (msg.voice) {
    file_id = msg.voice.file_id;
    mediaType = 'voice';
  } else if (msg.audio) {
    file_id = msg.audio.file_id;
    mediaType = 'audio';
  } else if (msg.video_note) {
    // Telegram round video messages
    file_id = msg.video_note.file_id;
    mediaType = 'video_note';
  }

  if (!file_id) {
    console.warn('[claudy-webhook] handleMediaMessage called but no file_id found');
    return;
  }

  console.log('[claudy-webhook] received', mediaType, 'from chat', chatId, 'file_id:', file_id);

  // Step 1: Send immediate acknowledgment (Telegram requires 200 within 5s;
  // we return 200 from the main handler BEFORE awaiting this, so this ack
  // is best-effort from within the async background path).
  await sendMessage(
    chatId,
    'Transcribing... give me 30 seconds.',
    messageId,
  );

  // Step 2: Run transcription (imported from transcribe-video.js)
  try {
    await transcribeVideo({ file_id, chat_id: chatId, message_id: messageId });
  } catch (err) {
    console.error('[claudy-webhook] transcribeVideo threw:', err && err.message);
    await sendMessage(
      chatId,
      `Transcription error: ${err && err.message ? err.message : 'unknown error'}`,
      messageId,
    ).catch(() => null);
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  // Optional: validate Telegram secret token header
  if (TELEGRAM_WEBHOOK_SECRET) {
    const got =
      req.headers['x-telegram-bot-api-secret-token'] ||
      req.headers['X-Telegram-Bot-Api-Secret-Token'];
    if (got !== TELEGRAM_WEBHOOK_SECRET) {
      console.warn('[claudy-webhook] secret token mismatch');
      // Non-blocking: log but continue (same policy as telegram-webhook.js)
    }
  }

  let update;
  try {
    update = await readRawBody(req);
  } catch (err) {
    console.error('[claudy-webhook] body parse failed:', err && err.message);
    return res.status(200).json({ ok: true, ignored: 'parse error' });
  }

  console.log('[claudy-webhook] update keys:', Object.keys(update || {}).join(', '));

  const msg = update?.message;

  if (!msg) {
    // Callback queries, edited messages, etc. — ignore for now
    return res.status(200).json({ ok: true });
  }

  const chatId = String(msg.chat?.id || '');
  const hasVideo = !!(msg.video || msg.voice || msg.audio || msg.video_note);

  // Always return 200 immediately to Telegram (5s window).
  // Fire the media processing as a detached promise — Vercel keeps the
  // function alive until the event loop drains, so the async work completes.
  if (hasVideo) {
    console.log('[claudy-webhook] media message detected — processing async');
    // Return 200 first, then process
    res.status(200).json({ ok: true });
    // handleMediaMessage sends the ack + runs transcription
    handleMediaMessage(msg).catch((err) => {
      console.error('[claudy-webhook] handleMediaMessage unhandled:', err && err.message);
    });
    return;
  }

  // Text messages: log and acknowledge (DONE is handled by Claude Code polling;
  // other commands can be added here as needed)
  if (msg.text) {
    const text = String(msg.text || '').trim();
    console.log('[claudy-webhook] text message from chat', chatId, ':', text.slice(0, 80));

    // Forward DONE command ack — the actual pipeline trigger is the Claude Code
    // session polling getUpdates. This webhook does NOT interfere with that.
    // We just log it so there's a server-side record.
    if (text.toUpperCase() === 'DONE') {
      console.log('[claudy-webhook] DONE received — Claude Code polling loop handles this');
      // No reply here — avoid double-response with the polling handler
    }
  }

  return res.status(200).json({ ok: true });
};
