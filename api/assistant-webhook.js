// Webhook endpoint for DossieAssistant_bot (separate from DossieMarketingBot)
// Receives messages and responds with status info

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // DossieAssistant_bot token
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const command = text.toLowerCase();

  // /status - today's social posts
  if (command === '/status' || command === 'status') {
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
    } catch (err) {
      await sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // /members - founding member count
  if (command === '/members' || command === 'members') {
    try {
      const { data: subs } = await supabaseFetch(
        `/rest/v1/subscriptions?status=eq.active&plan=eq.founding&select=id`
      );

      const count = subs ? subs.length : 0;
      const remaining = Math.max(0, 50 - count);

      const response = `👥 Founding Members

Active: ${count} / 50
Remaining: ${remaining} spots
Price: $29/mo (locked forever)`;

      await sendMessage(chatId, response);
    } catch (err) {
      await sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // /health - system health
  if (command === '/health' || command === 'health') {
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
    } catch (err) {
      await sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // Echo/help for any other message
  const helpText = `DossieAssistant_bot 🤖

Commands:
/status — today's post counts
/members — founding member stats
/health — cron health check

Received: "${text}"`;

  await sendMessage(chatId, helpText);
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

  try {
    if (update?.message?.text) {
      await handleMessage(update.message);
    }
  } catch (err) {
    console.error('[assistant-webhook] Handler error:', err.message);
  }

  return res.status(200).json({ ok: true });
};
