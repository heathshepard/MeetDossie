/**
 * Public Config API
 * Returns public configuration values safe for frontend use
 * (Supabase URL and anon key - both designed to be public)
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Cache at the CDN for 5 minutes so landing pages don't call this on
  // every hit. Env changes require a Vercel redeploy anyway.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  // These values are safe to expose publicly - they're designed for frontend use
  // and protected by Supabase Row Level Security (RLS) policies. PostHog
  // project keys are write-only per PostHog's threat model.
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    posthogKey: process.env.NEXT_PUBLIC_POSTHOG_KEY || process.env.POSTHOG_KEY || null,
    posthogHost: process.env.NEXT_PUBLIC_POSTHOG_HOST || process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
  });
}
