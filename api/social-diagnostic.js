// GET /api/social-diagnostic
// Full health check of social posting engine with live env vars
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)
// Previously public — leaked Telegram webhook URL containing bot token.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const HCTI_USER_ID = process.env.HCTI_USER_ID;
const HCTI_API_KEY = process.env.HCTI_API_KEY;
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

async function checkWebhook() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/getWebhookInfo`);
    const data = await res.json();
    return {
      ok: data.ok && data.result.url === 'https://meetdossie.com/api/telegram-webhook',
      url: data.result?.url || null,
      pending_updates: data.result?.pending_update_count || 0,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkZernio() {
  try {
    const res = await fetch('https://zernio.com/api/v1/accounts', {
      headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` },
    });
    const data = await res.json();

    const platforms = ['facebook', 'twitter', 'instagram', 'linkedin', 'tiktok'];
    const connections = {};
    platforms.forEach(platform => {
      const account = data.accounts?.find(a => a.platform === platform && (a.isActive || a.is_active));
      connections[platform] = {
        connected: !!account,
        account_name: account?.displayName || account?.name || null,
        account_id: account?._id || account?.id || null,
      };
    });

    return { ok: true, connections };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkHCTI() {
  try {
    const testRes = await fetch('https://hcti.io/v1/image', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${HCTI_USER_ID}:${HCTI_API_KEY}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: '<div style="width:300px;height:200px;background:#F5EDE4;display:flex;align-items:center;justify-content:center;font-family:sans-serif;color:#1A1A2E;">Diagnostic Test</div>',
        css: '',
      }),
    });

    if (testRes.ok) {
      const testData = await testRes.json();
      return { ok: true, url: testData.url };
    } else {
      return { ok: false, status: testRes.status };
    }
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkTodaysPosts() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: posts } = await supabaseFetch(`/rest/v1/social_posts?select=post_id,platform,status&created_at=gte.${today}T00:00:00`);

    if (!Array.isArray(posts)) {
      return { ok: false, error: 'Invalid response from Supabase' };
    }

    const statusCounts = {
      draft: 0,
      approved: 0,
      posted: 0,
      failed: 0,
      pending_video: 0,
    };

    posts.forEach(p => {
      if (statusCounts.hasOwnProperty(p.status)) {
        statusCounts[p.status]++;
      }
    });

    return { ok: true, total: posts.length, by_status: statusCounts };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkDailyCaps() {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Get schedule settings
    const { data: schedule } = await supabaseFetch('/rest/v1/posting_schedule?select=platform,max_per_day&is_active=eq.true');

    // Get today's posted counts per platform
    const { data: posted } = await supabaseFetch(`/rest/v1/social_posts?select=platform&status=eq.posted&posted_at=gte.${today}T00:00:00`);

    if (!Array.isArray(schedule) || !Array.isArray(posted)) {
      return { ok: false, error: 'Invalid response from Supabase' };
    }

    const caps = {};
    const platforms = ['facebook', 'twitter', 'instagram', 'linkedin', 'tiktok'];

    platforms.forEach(platform => {
      const limit = schedule.find(s => s.platform === platform)?.max_per_day || 0;
      const count = posted.filter(p => p.platform === platform).length;
      caps[platform] = { limit, count, remaining: Math.max(0, limit - count) };
    });

    return { ok: true, caps };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkLastPosts() {
  try {
    const { data: posts } = await supabaseFetch('/rest/v1/social_posts?select=platform,posted_at&status=eq.posted&order=posted_at.desc&limit=50');

    if (!Array.isArray(posts)) {
      return { ok: false, error: 'Invalid response from Supabase' };
    }

    const lastPosts = {};
    const platforms = ['facebook', 'twitter', 'instagram', 'linkedin', 'tiktok'];

    platforms.forEach(platform => {
      const last = posts.find(p => p.platform === platform);
      lastPosts[platform] = last ? {
        timestamp: last.posted_at,
        ago_hours: Math.floor((Date.now() - new Date(last.posted_at).getTime()) / (1000 * 60 * 60)),
      } : null;
    });

    return { ok: true, last_posts: lastPosts };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkCronRuns() {
  try {
    // Check content_batches for last generate run
    const { data: batches } = await supabaseFetch('/rest/v1/content_batches?select=created_at&order=created_at.desc&limit=1');

    // Check social_posts for last approval send
    const { data: approvals } = await supabaseFetch('/rest/v1/social_posts?select=telegram_sent_at&telegram_sent_at=not.is.null&order=telegram_sent_at.desc&limit=1');

    // Check for last published post
    const { data: published } = await supabaseFetch('/rest/v1/social_posts?select=posted_at&status=eq.posted&order=posted_at.desc&limit=1');

    const lastGenerate = Array.isArray(batches) && batches[0]?.created_at ? batches[0].created_at : null;
    const lastApprovalSend = Array.isArray(approvals) && approvals[0]?.telegram_sent_at ? approvals[0].telegram_sent_at : null;
    const lastPublish = Array.isArray(published) && published[0]?.posted_at ? published[0].posted_at : null;

    return {
      ok: true,
      last_generate: lastGenerate,
      last_approval_send: lastApprovalSend,
      last_publish: lastPublish,
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkFailedPosts() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: posts } = await supabaseFetch(`/rest/v1/social_posts?select=post_id,platform,status,error_message,created_at&status=eq.failed&created_at=gte.${today}T00:00:00&order=created_at.desc`);

    if (!Array.isArray(posts)) {
      return { ok: false, error: 'Invalid response from Supabase' };
    }

    return { ok: true, count: posts.length, posts };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const [webhook, zernio, hcti, todaysPosts, dailyCaps, lastPosts, cronRuns, failedPosts] = await Promise.all([
      checkWebhook(),
      checkZernio(),
      checkHCTI(),
      checkTodaysPosts(),
      checkDailyCaps(),
      checkLastPosts(),
      checkCronRuns(),
      checkFailedPosts(),
    ]);

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      health: {
        webhook,
        zernio,
        hcti,
        todays_posts: todaysPosts,
        daily_caps: dailyCaps,
        last_posts: lastPosts,
        cron_runs: cronRuns,
        failed_posts: failedPosts,
      },
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Diagnostic failed',
      message: error.message,
    });
  }
}
