// Test endpoint: Generate card + publish to Facebook
// GET /api/test-facebook-post?secret=CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
  return { ok: res.ok, status: res.status, data, text };
}

export default async function handler(req, res) {
  const secret = req.query.secret;
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // 1. Generate card
    const cardResponse = await fetch('https://meetdossie.com/api/generate-card', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({
        platform: 'facebook',
        hook: 'LIVE TEST: Dossie social posting is working',
        content: 'This is a live test of the complete pipeline: HCTI card generation → Supabase Storage → Zernio → Facebook. If you see this post with an image, the system is fully operational.',
        persona: 'brenda',
        post_id: `test-${Date.now()}`,
        stat: '✅ LIVE',
        stat_label: 'End-to-end test',
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

    // 2. Look up Facebook Zernio account ID
    const { data: accounts } = await supabaseFetch(
      `/rest/v1/zernio_accounts?platform=eq.facebook&is_active=eq.true&select=zernio_account_id&limit=1`
    );
    const zernioAccountId = Array.isArray(accounts) && accounts.length > 0
      ? accounts[0].zernio_account_id
      : null;

    if (!zernioAccountId) {
      return res.status(500).json({
        ok: false,
        error: 'No active Facebook Zernio account found',
      });
    }

    // 3. Create post row
    const postId = `live-test-${Date.now()}`;
    const now = new Date().toISOString();
    const postRow = {
      post_id: postId,
      platform: 'facebook',
      content: 'LIVE TEST: Dossie social posting is working.\n\nThis is a live test of the complete pipeline: HCTI card generation → Supabase Storage → Zernio → Facebook.\n\nIf you see this post with an image, the system is fully operational. ✅\n\n#DossieLiveTest #TexasRealEstate',
      content_hash: require('crypto').createHash('md5').update('live-test-' + Date.now()).digest('hex'),
      hook: 'LIVE TEST: System operational',
      status: 'approved',
      approved_at: now,
      zernio_account_id: zernioAccountId,
      persona: 'brenda',
      topic: 'test',
      media_url: cardData.publicUrl,
      created_at: now,
      generated_at: now,
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

    // 4. Trigger publish cron
    const publishResponse = await fetch('https://meetdossie.com/api/cron-publish-approved', {
      headers: { 'Authorization': `Bearer ${CRON_SECRET}` },
    });

    const publishData = await publishResponse.json();

    return res.status(200).json({
      ok: true,
      card_url: cardData.publicUrl,
      post_id: postId,
      publish_result: publishData,
      message: 'Check Facebook page @MeetDossie for the live post with image',
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      stack: error.stack,
    });
  }
}
