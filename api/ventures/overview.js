/**
 * GET /api/ventures/overview
 * Portfolio rollup for the Shepard Ventures dashboard.
 * Returns MRR, customer count, per-company summary, and agent status.
 *
 * Auth: Bearer token via Supabase session — heath.shepard@kw.com only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZED_EMAIL = 'heath.shepard@kw.com';

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

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // --- Auth ---
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - no token' });
  }
  const token = authHeader.slice(7);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Unauthorized - invalid token' });
  }
  if (user.email !== AUTHORIZED_EMAIL) {
    return res.status(403).json({ error: 'Forbidden - admin only' });
  }

  try {
    // --- Revenue rollup from subscriptions ---
    const { data: subs, error: subsErr } = await supabase
      .from('subscriptions')
      .select('plan, status')
      .eq('status', 'active');

    if (subsErr) throw subsErr;

    const founding = subs?.filter(s => s.plan === 'founding').length ?? 0;
    const foundingFriend = subs?.filter(s => s.plan === 'founding_friend').length ?? 0;
    const solo = subs?.filter(s => s.plan === 'solo').length ?? 0;
    const team = subs?.filter(s => s.plan === 'team').length ?? 0;
    const totalCustomers = subs?.length ?? 0;

    // MRR: founding @ $29, founding_friend @ $1, solo @ $79, team @ $199
    const dossieMrr =
      (founding * 29) +
      (foundingFriend * 1) +
      (solo * 79) +
      (team * 199);
    const totalMrr = dossieMrr; // only one live company right now

    // --- Agent status from ventures_agents ---
    let agents = [];
    const { data: agentRows, error: agentErr } = await supabase
      .from('ventures_agents')
      .select('name, status, last_active_at')
      .order('name');

    if (!agentErr && agentRows) {
      agents = agentRows.map(a => ({
        name: a.name,
        status: a.status || 'idle',
        lastActiveAt: a.last_active_at || null,
      }));
    } else {
      // Fallback if ventures_agents isn't queryable yet
      agents = [
        { name: 'cole', status: 'idle', lastActiveAt: null },
        { name: 'hadley', status: 'idle', lastActiveAt: null },
        { name: 'pierce', status: 'idle', lastActiveAt: null },
        { name: 'atlas', status: 'idle', lastActiveAt: null },
      ];
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      totalMrrUsd: totalMrr,
      totalCustomers,
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
