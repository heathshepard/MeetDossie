// Create a test post and send for approval
// GET /api/create-test-post?secret=CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

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

export default async function handler(req, res) {
  const secret = req.query.secret;
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const postId = `pipeline-test-${Date.now()}`;

    // 1. Generate HCTI card
    const cardResponse = await fetch('https://meetdossie.com/api/generate-card', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({
        platform: 'facebook',
        hook: '🔥 LIVE PIPELINE TEST',
        content: 'Full autonomous pipeline test: HCTI card generation → Telegram approval → Zernio → Facebook. Real-time verification that the complete system works end-to-end.',
        persona: 'brenda',
        post_id: postId,
        stat: '✅ LIVE',
        stat_label: 'Pipeline Test',
      }),
    });

    const cardData = await cardResponse.json();
    if (!cardData.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Card generation failed',
        detail: cardData,
      });
    }

    // 2. Look up Facebook Zernio account
    const { data: accounts } = await supabaseFetch(
      `/rest/v1/zernio_accounts?platform=eq.facebook&is_active=eq.true&select=zernio_account_id&limit=1`
    );
    const zernioAccountId = accounts?.[0]?.zernio_account_id;

    // 3. Create post in draft status
    const content = `🔥 LIVE PIPELINE TEST\n\nThis post proves the full autonomous pipeline is working:\n\n✅ HCTI card generated\n✅ Uploaded to Supabase Storage\n✅ Sent to Telegram for approval\n✅ Webhook received approval\n✅ Published via Zernio\n✅ Live on Facebook with image\n\nDossie social posting is fully operational.\n\n#DossieLiveTest #TexasRealEstate #TransactionCoordination`;

    const postRow = {
      post_id: postId,
      platform: 'facebook',
      content,
      content_hash: require('crypto').createHash('md5').update(content + Date.now()).digest('hex'),
      hook: '🔥 LIVE PIPELINE TEST',
      status: 'draft',
      zernio_account_id: zernioAccountId,
      persona: 'brenda',
      topic: 'pipeline-test',
      media_url: cardData.publicUrl,
      card_body: 'Full autonomous pipeline test: HCTI card generation → Telegram approval → Zernio → Facebook.',
      created_at: now.toISOString(),
      generated_at: now.toISOString(),
    };

    const insertRes = await supabaseFetch('/rest/v1/social_posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(postRow),
    });

    if (!insertRes.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Failed to insert post',
        detail: insertRes,
      });
    }

    const post = Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data;

    // 4. Send to Telegram for approval
    // Send card image first
    const cardMessage = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        photo: cardData.publicUrl,
        caption: '🔥 LIVE PIPELINE TEST',
      }),
    });

    // Send approval buttons
    const buttonsMessage = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `Platform: facebook\nPersona: brenda\n\n${content}`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve_${post.id}` },
            { text: '❌ Reject', callback_data: `reject_${post.id}` },
          ]],
        },
      }),
    });

    const buttonsData = await buttonsMessage.json();

    // Update telegram_sent_at
    await supabaseFetch(`/rest/v1/social_posts?id=eq.${post.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        telegram_sent_at: now.toISOString(),
        telegram_message_id: buttonsData.result?.message_id,
      }),
    });

    return res.status(200).json({
      ok: true,
      post_id: postId,
      card_url: cardData.publicUrl,
      message: 'Test post sent to Telegram. Approve it, then it will publish in next cron cycle.',
      db_id: post.id,
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
    });
  }
}
