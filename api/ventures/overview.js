/**
 * GET /api/ventures/overview
 * Portfolio rollup for the Shepard Ventures dashboard.
 * Returns MRR, customer count, per-company summary, and agent status.
 *
 * Auth: Bearer token via Supabase session — heath.shepard@kw.com only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Pattern: direct REST fetch with service role key — no supabase-js client.
 * See Carter's memory: "NO supabase-js client in API routes — direct REST via fetch"
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZED_EMAILS = new Set(['heath.shepard@kw.com', 'heath@meetdossie.com', 'heath.shepard@gmail.com']);

// CORS — mirrors the pattern used in admin-dashboard.js
const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

// Direct REST helper — Carter's approved pattern for serverless routes
function supa(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  return fetch(url, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // --- Auth: verify Supabase JWT via /auth/v1/user ---
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }
  const token = authHeader.slice(7);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!userRes.ok) {
    return res.status(401).json({ error: 'Unauthorized - invalid token' });
  }
  const userData = await userRes.json();
  if (!AUTHORIZED_EMAILS.has(userData.email)) {
    return res.status(403).json({ error: 'Forbidden - admin only' });
  }

  try {
    // --- Revenue rollup from subscriptions ---
    const subsRes = await supa('subscriptions?select=plan,status,created_at&status=eq.active&order=created_at.asc');
    if (!subsRes.ok) throw new Error(`subscriptions fetch failed: ${subsRes.status}`);
    const subs = await subsRes.json();

    const founding = subs.filter(s => s.plan === 'founding').length;
    const foundingFriend = subs.filter(s => s.plan === 'founding_friend').length;
    const solo = subs.filter(s => s.plan === 'solo').length;
    const team = subs.filter(s => s.plan === 'team').length;
    const totalCustomers = subs.length;

    // MRR: founding @ $29, founding_friend @ $1, solo @ $79, team @ $199
    const PLAN_AMOUNTS = { founding: 29, founding_friend: 1, solo: 79, team: 199 };
    const dossieMrr =
      (founding * 29) +
      (foundingFriend * 1) +
      (solo * 79) +
      (team * 199);
    const totalMrr = dossieMrr; // only one live company right now

    // --- MRR Sparkline: cumulative MRR by month over last 6 months ---
    // Build monthly buckets for the past 6 months
    const now = new Date();
    const sparkMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      sparkMonths.push({
        year: d.getFullYear(),
        month: d.getMonth(), // 0-indexed
        label: d.toLocaleString('en-US', { month: 'short' }),
        mrr: 0,
      });
    }

    // For each active subscription, add its MRR to the month it was created
    // and all subsequent months (cumulative MRR growth)
    for (const sub of subs) {
      const subDate = new Date(sub.created_at);
      const amount = PLAN_AMOUNTS[sub.plan] || 0;
      for (const bucket of sparkMonths) {
        const bucketStart = new Date(bucket.year, bucket.month, 1);
        if (subDate <= bucketStart) {
          bucket.mrr += amount;
        }
      }
    }
    const mrrSparkline = sparkMonths.map(b => ({ label: b.label, mrr: b.mrr }));

    // --- Agent status from ventures_agents (with heartbeat-aware status) ---
    let agents = [];
    const agentRes = await supa('ventures_agents?select=agent_name,display_name,status,last_active_at&order=agent_name.asc');
    if (agentRes.ok) {
      const agentRows = await agentRes.json();
      const nowMs = Date.now();
      agents = agentRows.map(a => {
        const lastActive = a.last_active_at ? new Date(a.last_active_at) : null;
        let heartbeatStatus = 'idle';
        if (lastActive) {
          const ageHours = (nowMs - lastActive.getTime()) / 3600000;
          if (ageHours <= 24) heartbeatStatus = a.status || 'active';
          else if (ageHours <= 72) heartbeatStatus = 'warn';
          else heartbeatStatus = 'stale';
        }
        return {
          name: a.agent_name,
          displayName: a.display_name,
          status: heartbeatStatus,
          lastActiveAt: a.last_active_at || null,
        };
      });
    } else {
      // Fallback if ventures_agents isn't queryable yet
      agents = [
        { name: 'cole',             displayName: 'Cole',             status: 'idle', lastActiveAt: null },
        { name: 'hadley',           displayName: 'Hadley',           status: 'idle', lastActiveAt: null },
        { name: 'pierce',           displayName: 'Pierce',           status: 'idle', lastActiveAt: null },
        { name: 'atlas',            displayName: 'Atlas',            status: 'idle', lastActiveAt: null },
        { name: 'carter',           displayName: 'Carter',           status: 'idle', lastActiveAt: null },
        { name: 'sage',             displayName: 'Sage',             status: 'idle', lastActiveAt: null },
        { name: 'content_verifier', displayName: 'Content Verifier', status: 'idle', lastActiveAt: null },
      ];
    }

    // --- Per-customer revenue breakdown (for Revenue modal) ---
    // Join subscriptions with profiles for names
    const profilesRes = await supa('profiles?select=id,full_name,email&is_demo=eq.false&limit=200');
    let profileMap = {};
    if (profilesRes.ok) {
      const profiles = await profilesRes.json();
      for (const p of profiles) profileMap[p.id] = { name: p.full_name || p.email || 'Unknown', email: p.email };
    }
    // Also fetch user_id from subscriptions for the name join
    const subsWithIdRes = await supa('subscriptions?select=user_id,plan,status&status=eq.active&limit=200');
    let customerRevenue = [];
    if (subsWithIdRes.ok) {
      const subsWithId = await subsWithIdRes.json();
      customerRevenue = subsWithId.map(s => {
        const profile = profileMap[s.user_id] || { name: 'Unknown', email: '' };
        return {
          name: profile.name,
          email: profile.email,
          plan: s.plan,
          monthlyUsd: PLAN_AMOUNTS[s.plan] || 0,
        };
      }).sort((a, b) => b.monthlyUsd - a.monthlyUsd);
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      totalMrrUsd: totalMrr,
      totalCustomers,
      mrrSparkline,
      customerRevenue,
      companies: [
        {
          id: 'dossie',
          name: 'Dossie',
          tagline: 'Your deals. Her job.',
          status: 'live',
          mrr: dossieMrr,
          customers: totalCustomers,
          // delta7d — hardcoded at 1 for Phase 1; Phase 3 will compute from signups in last 7d
          delta7d: 1,
          foundingSpots: { taken: founding, total: 50 },
          url: 'https://meetdossie.com',
        },
        {
          id: 'paralegal',
          name: 'Paralegal SaaS',
          tagline: 'Case-file-driven form drafting.',
          status: 'planning',
          mrr: 0,
          customers: 0,
          delta7d: 0,
        },
      ],
      agents,
      costs: {
        fixed: [
          { name: 'Zernio',       amount: 18.00,  note: '4 social accounts, unlimited posts' },
          { name: 'ElevenLabs',   amount: 18.33,  note: 'Creator plan, 30k credits/mo' },
          { name: 'Submagic',     amount: 12.00,  note: 'Starter — selfie video editing' },
          { name: 'Claude Max',   amount: 100.00, note: 'Anthropic subscription (Heath)' },
          { name: 'Vercel',       amount: 0,      note: 'Hobby (free)' },
          { name: 'Supabase',     amount: 0,      note: 'Free tier' },
          { name: 'Creatomate',   amount: 0,      note: 'Free tier' },
          { name: 'HCTI',         amount: 0,      note: 'Free tier (50 renders/mo; upgrade $14/mo at 1k)' },
          { name: 'Resend',       amount: 0,      note: 'Free tier' },
          { name: 'Pexels',       amount: 0,      note: 'Free API' },
          { name: 'ImprovMX',     amount: 0,      note: 'Free plan — email forwarding' },
          { name: 'GitHub',       amount: 0,      note: 'Public repo (free)' },
          { name: 'Domain',       amount: 1.08,   note: 'meetdossie.com (~$13/yr amortized)' },
        ],
        variable: [
          { name: 'Stripe fees',     note: '2.9% + 30c per transaction' },
          { name: 'Anthropic API',   note: 'Variable per cron run (cron-generate-posts, DONE handler, etc.)' },
          { name: 'HCTI overage',    note: '$14/mo if renders exceed 50/mo' },
        ],
        oneTime: [
          { name: 'Northwest Registered Agent', amount: 349.00, note: 'LLC formation — paid 2026-05-22 (invoice 38BF46H9)' },
        ],
        // totalFixed is the sum of all fixed[].amount entries above
        totalFixed: 149.41,
      },
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error('[ventures/overview] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
