// Webhook endpoint for DossieAssistant_bot (Cole — separate from DossieMarketingBot)
// Receives messages (text + voice) and responds with status info

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // DossieAssistant_bot token
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const { transcribeVoice, sendVoiceReply } = require('./_lib/voice');
const { generateSpeech } = require('./_utils/tts');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Founding-member cap. Authoritative value lives in CLAUDE.md section 5.
// This read 50 and reported roughly double the spots actually remaining.
const FOUNDING_SPOT_CAP = 25;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  console.log('[assistant-webhook] sendMessage result:', data.ok);
  return { ok: data.ok, data };
}

async function handleMessage(msg) {
  const chatId = msg?.chat?.id;
  const text = String(msg?.text || '').trim();

  console.log('[assistant-webhook] Message received:', { chatId, text });

  // Only respond to authorized chat
  if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    console.log('[assistant-webhook] Unauthorized chat:', chatId);
    return;
  }

  const lowerText = text.toLowerCase();

  // Greeting handler
  if (lowerText.includes('hello') || lowerText.includes('hey') || lowerText.includes('hi')) {
    const r = "👋 I'm here and listening. Try /status for today's post counts.";
    await sendMessage(chatId, r);
    return r;
  }

  // Fuzzy command matching
  const isStatusQuery = lowerText === '/status' || lowerText === 'status' || lowerText.includes('status');
  const isMembersQuery = lowerText === '/members' || lowerText === 'members' || lowerText.includes('members');
  const isHealthQuery = lowerText === '/health' || lowerText === 'health' || lowerText.includes('health');

  // /status - today's social posts
  if (isStatusQuery) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const startTime = `${today}T00:00:00`;
      const endTime = `${today}T23:59:59`;

      const { data: posts } = await supabaseFetch(
        `/rest/v1/social_posts?created_at=gte.${startTime}&created_at=lte.${endTime}&select=status`
      );

      const counts = (posts || []).reduce((acc, p) => {
        acc[p.status] = (acc[p.status] || 0) + 1;
        return acc;
      }, {});

      const response = `📊 Social Posts (${today})

✅ Posted: ${counts.posted || 0}
⏳ Approved: ${counts.approved || 0}
❌ Failed: ${counts.failed || 0}
📝 Draft: ${counts.draft || 0}
🚫 Rejected: ${counts.rejected || 0}

Total: ${posts?.length || 0}`;

      await sendMessage(chatId, response);
      return response;
    } catch (err) {
      const e = `❌ Error: ${err.message}`;
      await sendMessage(chatId, e);
      return e;
    }
  }

  // /members - founding member count
  if (isMembersQuery) {
    try {
      const { data: subs } = await supabaseFetch(
        `/rest/v1/subscriptions?status=eq.active&plan=eq.founding&select=id`
      );

      const count = subs ? subs.length : 0;
      const remaining = Math.max(0, FOUNDING_SPOT_CAP - count);

      const response = `👥 Founding Members

Active: ${count} / ${FOUNDING_SPOT_CAP}
Remaining: ${remaining} spots
Price: $29/mo (locked forever)`;

      await sendMessage(chatId, response);
      return response;
    } catch (err) {
      const e = `❌ Error: ${err.message}`;
      await sendMessage(chatId, e);
      return e;
    }
  }

  // /health - system health
  if (isHealthQuery) {
    try {
      const { data: recent } = await supabaseFetch(
        `/rest/v1/social_posts?order=created_at.desc&limit=1&select=created_at`
      );

      const { data: recentPosted } = await supabaseFetch(
        `/rest/v1/social_posts?status=eq.posted&order=posted_at.desc&limit=1&select=posted_at`
      );

      const lastCreated = recent?.[0]?.created_at;
      const lastPosted = recentPosted?.[0]?.posted_at;

      const now = new Date();
      const createdAgo = lastCreated ? Math.round((now - new Date(lastCreated)) / 60000) : null;
      const postedAgo = lastPosted ? Math.round((now - new Date(lastPosted)) / 60000) : null;

      const genHealth = createdAgo !== null && createdAgo < 1440 ? '✅' : '⚠️';
      const pubHealth = postedAgo !== null && postedAgo < 60 ? '✅' : '⚠️';

      const response = `🏥 System Health

${genHealth} Generate: ${createdAgo !== null ? `${createdAgo}m ago` : 'Never'}
${pubHealth} Publish: ${postedAgo !== null ? `${postedAgo}m ago` : 'Never'}

Cron schedule:
• Generate: daily 11AM UTC
• Approve: daily 11:30 UTC
• Publish: every 30 min`;

      await sendMessage(chatId, response);
      return response;
    } catch (err) {
      const e = `❌ Error: ${err.message}`;
      await sendMessage(chatId, e);
      return e;
    }
  }

  // Catch-all for any other message
  const fallback = "👋 I'm here. Try /status, /members, or /health for quick info.";
  await sendMessage(chatId, fallback);
  return fallback;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  console.log('[assistant-webhook] Webhook called');

  let update;
  try {
    update = typeof req.body === 'object' ? req.body : JSON.parse(req.body);
    console.log('[assistant-webhook] Update received:', {
      hasMessage: !!update?.message,
      text: update?.message?.text
    });
  } catch (err) {
    console.error('[assistant-webhook] Parse error:', err.message);
    return res.status(200).json({ ok: true, ignored: 'parse error' });
  }

  const message = update?.message;
  const isVoice = message && (message.voice || message.audio);
  const hasText = message && message.text;

  if (!message || (!hasText && !isVoice)) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat?.id;
  if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    console.log('[assistant-webhook] Unauthorized chat:', chatId);
    return res.status(200).json({ ok: true });
  }

  try {
    let msgToHandle = message;
    let isVoiceInput = false;

    if (isVoice && !hasText) {
      try {
        const fileId = (message.voice || message.audio).file_id;
        console.log('[assistant-webhook] voice message received, file_id:', fileId);
        const transcribed = await transcribeVoice(fileId, TELEGRAM_BOT_TOKEN);
        if (!transcribed) {
          await sendMessage(chatId, "Couldn't transcribe that — try again or type it out.");
          return res.status(200).json({ ok: true });
        }
        isVoiceInput = true;
        await sendMessage(chatId, `[transcribed] ${transcribed}`);
        msgToHandle = { ...message, text: transcribed };
      } catch (err) {
        console.error('[assistant-webhook] voice processing error:', err.message);
        await sendMessage(chatId, 'Voice processing failed — try typing instead.');
        return res.status(200).json({ ok: true });
      }
    }

    const responseText = await handleMessage(msgToHandle);

    if (isVoiceInput && responseText) {
      try {
        const audio = await generateSpeech(responseText, { persona: 'cole' });
        if (audio) await sendVoiceReply(chatId, audio.buffer, TELEGRAM_BOT_TOKEN);
      } catch (e) {
        console.warn('[assistant-webhook] TTS failed:', e.message);
      }
    }
  } catch (err) {
    console.error('[assistant-webhook] Handler error:', err.message);
  }

  return res.status(200).json({ ok: true });
};
