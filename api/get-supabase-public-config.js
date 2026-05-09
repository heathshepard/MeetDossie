// Vercel Serverless Function: /api/get-supabase-public-config
// Return Supabase URL and publishable (anon) key for client-side use
//
// GET /api/get-supabase-public-config
// Returns: { url: "...", publishableKey: "..." }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Return the public configuration
  // Note: These are MEANT to be public (client-side safe)
  return res.status(200).json({
    url: SUPABASE_URL || null,
    publishableKey: SUPABASE_PUBLISHABLE_KEY || null,
    urlConfigured: !!SUPABASE_URL,
    keyConfigured: !!SUPABASE_PUBLISHABLE_KEY
  });
};
