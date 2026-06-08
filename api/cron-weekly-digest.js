// Vercel Serverless Function: /api/cron-weekly-digest
// Runs every Monday at 14:00 UTC (8AM CST) via cron-job.org (JOB-007).
// Sends a plain-text weekly digest to Heath via Telegram covering new members,
// social posts by platform, founding applications, stale leads, and MRR.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule (cron-job.org): 0 14 * * 1  (Monday 8AM CST / 14:00 UTC)
//
// Environment:
//   SUPABASE_URL              - Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY - service-role JWT
//   TELEGRAM_BOT_TOKEN        - Claudy bot token for Heath alerts
//   CRON_SECRET               - bearer token for manual trigger

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = '7874782923';
const CRON_SECRET = process.env.CRON_SECRET;

// Stale lead definitions: { name, lastContactDate }
// Flag any lead whose last contact was more than 7 days ago.
const LEADS = [
  { name: 'Amber Higgs',    lastContact: new Date('2026-06-08') },
  { name: 'Danielle Scott', lastContact: new Date('2026-05-27') },
  { name: 'Ginger Unger',   lastContact: new Date('2026-05-21') },
];

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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function fetchDigestData() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // New subscribers this week
  const subsRes = await supabaseFetch(
    `/rest/v1/subscriptions?status=eq.active&created_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id,email,plan`
  );
  const newSubs = (subsRes.ok && Array.isArray(subsRes.data)) ? subsRes.data : [];

  // All active founding subs for MRR
  const allFoundingRes = await supabaseFetch(
    '/rest/v1/subscriptions?status=eq.active&plan=eq.founding&select=id'
  );
  const foundingCount = (allFoundingRes.ok && Array.isArray(allFoundingRes.data))
    ? allFoundingRes.data.length : 0;

  // Friend tier for MRR
  const friendRes = await supabaseFetch(
    '/rest/v1/subscriptions?status=eq.active&plan=neq.founding&select=id'
  );
  const friendCount = (friendRes.ok && Array.isArray(friendRes.data))
    ? friendRes.data.length : 0;

  const mrr = (foundingCount * 29) + (friendCount * 1);

  // Social posts published this week, with platform breakdown
  const socialRes = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=platform`
  );
  const socialPosts = (socialRes.ok && Array.isArray(socialRes.data)) ? socialRes.data : [];

  const byPlatform = {};
  for (const p of socialPosts) {
    const plat = p.platform || 'unknown';
    byPlatform[plat] = (byPlatform[plat] || 0) + 1;
  }

  // Founding applications received this week
  const appsRes = await supabaseFetch(
    `/rest/v1/founding_applications?created_at=gte.${encodeURIComponent(sevenDaysAgo)}&select=id,name`
  );
  const apps = (appsRes.ok && Array.isArray(appsRes.data)) ? appsRes.data : [];

  return { newSubs, foundingCount, mrr, socialPosts, byPlatform, apps };
}

function buildMessage(data) {
  const { newSubs, foundingCount, mrr, socialPosts, byPlatform, apps } = data;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    timeZone: 'America/Chicago',
  });

  const lines = [];

  lines.push(`Weekly digest - ${dateStr}`);
  lines.push('');

  // New members
  const memberNames = newSubs.map(s => s.email || 'unknown').join(', ');
  lines.push(`New members: ${newSubs.length}${newSubs.length > 0 ? ' (' + memberNames + ')' : ''}`);

  // Posts by platform
  const totalPosts = socialPosts.length;
  const platformBreakdown = Object.entries(byPlatform)
    .map(([p, n]) => `${p}: ${n}`)
    .join(', ');
  lines.push(`Posts published: ${totalPosts}${totalPosts > 0 ? ' (' + platformBreakdown + ')' : ''}`);

  // Applications
  lines.push(`Applications: ${apps.length}`);

  // MRR
  lines.push('');
  lines.push(`MRR: $${mrr} (${foundingCount} founding)`);

  // Open loops
  lines.push('');
  lines.push('Open loops:');
  lines.push('- FB session: run scripts/capture-facebook-session.js if group posting stopped');
  lines.push('- Check cron-job.org console for JOB-005 and JOB-006 if not yet registered');

  // Stale leads
  const staleLeads = LEADS.filter(lead => {
    const daysSince = Math.floor((now - lead.lastContact) / (1000 * 60 * 60 * 24));
    return daysSince > 7;
  }).map(lead => {
    const daysSince = Math.floor((now - lead.lastContact) / (1000 * 60 * 60 * 24));
    return `${lead.name} (${daysSince} days)`;
  });

  if (staleLeads.length > 0) {
    lines.push('');
    lines.push(`Stale leads: ${staleLeads.join(', ')}`);
  }

  return lines.join('\n');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[cron-weekly-digest] TELEGRAM_BOT_TOKEN not set');
    return;
  }
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error('[cron-weekly-digest] Telegram failed:', res.status, t.slice(0, 200));
  }
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  console.log('[cron-weekly-digest] starting at', new Date().toISOString());

  let data;
  try {
    data = await fetchDigestData();
  } catch (err) {
    console.error('[cron-weekly-digest] fetchDigestData failed:', err && err.message);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }

  const message = buildMessage(data);
  console.log('[cron-weekly-digest] message:\n', message);

  await sendTelegram(message);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    message,
  });
};
