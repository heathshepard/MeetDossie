// Vercel Serverless Function: /api/cron-pierce-activation
// Pierce's daily activation check — surfaces inactive founding members to Heath via Telegram.
// Does NOT email customers. Telegram alert only. Email follow-up is a separate build.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1 header
// Triggered by: cron-job.org external cron (NOT in vercel.json crons — Vercel is at limit)
// Schedule: 0 13 * * * (1PM UTC = 8AM CST daily)
//
// Logic:
//   1. Pull all non-demo profiles + active subscriptions
//   2. Pull last_sign_in_at from auth admin endpoint
//   3. Identify members inactive >7 days OR never logged in
//   4. Send a Telegram summary to Heath
//   5. Log event to ventures_activity_events

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function supaJson(path, opts = {}) {
  const res = await supa(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
  const body = await res.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = null; }
  if (!res.ok || data?.ok !== true) {
    console.error('[cron-pierce-activation] Telegram failed:', res.status, body.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true };
}

async function logActivityEvent(summary, inactiveCount) {
  try {
    const { ok, status, data } = await supaJson('ventures_activity_events', {
      method: 'POST',
      body: JSON.stringify({
        agent_name: 'pierce',
        event_type: 'activation_check',
        summary,
        metadata: { inactive_count: inactiveCount },
      }),
    });
    if (!ok) {
      console.warn('[cron-pierce-activation] ventures_activity_events insert failed:', status, JSON.stringify(data));
    }
  } catch (err) {
    // Non-fatal — table may not exist yet. Log and continue.
    console.warn('[cron-pierce-activation] activity event log threw:', err.message);
  }
}

module.exports = async function handler(req, res) {
  // Auth: Vercel built-in cron header OR manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers.authorization || req.headers.Authorization || '');
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Get all non-demo profiles
    const { ok: pOk, data: profiles } = await supaJson(
      'profiles?select=id,email,full_name,is_demo,created_at&is_demo=eq.false&limit=200'
    );
    if (!pOk || !Array.isArray(profiles)) {
      console.error('[cron-pierce-activation] profiles fetch failed');
      return res.status(500).json({ ok: false, error: 'Failed to fetch profiles' });
    }

    // 2. Get active subscriptions to isolate paying customers
    const { ok: sOk, data: subs } = await supaJson(
      'subscriptions?select=user_id,plan,status&status=eq.active&limit=200'
    );
    const activeSubUserIds = new Set(
      (sOk && Array.isArray(subs) ? subs : []).map(s => s.user_id)
    );

    // 3. Get last_sign_in_at from auth admin endpoint
    let authUsers = [];
    try {
      const adminRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (adminRes.ok) {
        const adminData = await adminRes.json();
        authUsers = adminData.users || [];
      } else {
        console.warn('[cron-pierce-activation] auth admin endpoint non-ok:', adminRes.status);
      }
    } catch (err) {
      console.warn('[cron-pierce-activation] auth admin fetch threw:', err.message);
    }

    const lastSignInMap = {};
    for (const au of authUsers) {
      lastSignInMap[au.id] = au.last_sign_in_at || null;
    }

    // 4. Build inactive list — paying members only
    const payingProfiles = profiles.filter(p => activeSubUserIds.has(p.id));
    const inactiveMembers = [];

    for (const p of payingProfiles) {
      const lastSignIn = lastSignInMap[p.id] || null;
      const neverLoggedIn = !lastSignIn;
      const inactiveTooLong = lastSignIn && new Date(lastSignIn) < new Date(sevenDaysAgo);

      if (neverLoggedIn || inactiveTooLong) {
        const daysSince = lastSignIn
          ? Math.floor((Date.now() - new Date(lastSignIn).getTime()) / (1000 * 60 * 60 * 24))
          : null;
        inactiveMembers.push({
          name: p.full_name || p.email || 'Unknown',
          email: p.email || '',
          lastSignIn,
          daysSince,
          neverLoggedIn,
        });
      }
    }

    const inactiveCount = inactiveMembers.length;
    const totalPaying = payingProfiles.length;

    // 5. Build Telegram message
    let message;
    if (inactiveCount === 0) {
      message = `Pierce - activation check\nAll ${totalPaying} founding members logged in within the last 7 days. No action needed.`;
    } else {
      const lines = [`Pierce - activation check\n${inactiveCount} of ${totalPaying} founding members inactive (>7 days or never logged in):\n`];
      for (const m of inactiveMembers) {
        const status = m.neverLoggedIn
          ? 'NEVER logged in'
          : `last login ${m.daysSince}d ago`;
        lines.push(`- ${m.name} (${m.email}) - ${status}`);
      }
      lines.push('\nConsider a personal check-in or activation nudge.');
      message = lines.join('\n');
    }

    console.log('[cron-pierce-activation] inactive:', inactiveCount, '/', totalPaying, 'paying members');

    // 6. Send Telegram alert (non-fatal if it fails)
    const tgResult = await sendTelegram(message);

    // 7. Log activity event to ventures_activity_events
    const summary = `${inactiveCount} of ${totalPaying} founding members inactive >7 days`;
    await logActivityEvent(summary, inactiveCount);

    return res.status(200).json({
      ok: true,
      ran_at: new Date().toISOString(),
      total_paying: totalPaying,
      inactive_count: inactiveCount,
      inactive_members: inactiveMembers,
      telegram_sent: tgResult.ok,
    });
  } catch (err) {
    console.error('[cron-pierce-activation] unhandled error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error', message: err.message });
  }
};
