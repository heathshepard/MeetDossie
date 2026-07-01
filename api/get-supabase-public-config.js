// Vercel Serverless Function: /api/get-supabase-public-config
// Return Supabase URL and publishable (anon) key for client-side use
//
// GET /api/get-supabase-public-config
// Returns: { url: "...", publishableKey: "..." }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

// Sanitize env-var value: strip BOM, CR/LF/tab, and other control chars.
// The SUPABASE_PUBLISHABLE_KEY env var in Vercel currently carries a leading
// U+FEFF BOM + trailing \r\n which makes fetch() reject it as a header value
// ("String contains non ISO-8859-1 code point"). Sanitize here so every
// dashboard consuming this endpoint gets a usable key.
function sanitizeKey(v) {
  if (!v) return null;
  return String(v)
    .replace(/^﻿/, '')          // strip BOM
    .replace(/[\r\n\t]/g, '')        // strip CR/LF/tab
    .replace(/[\x00-\x1F\x7F]/g, '') // strip other control chars
    .trim() || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Return the public configuration
  // Note: These are MEANT to be public (client-side safe)
  return res.status(200).json({
    url: SUPABASE_URL?.trim() || null,
    publishableKey: sanitizeKey(SUPABASE_PUBLISHABLE_KEY),
    urlConfigured: !!SUPABASE_URL,
    keyConfigured: !!SUPABASE_PUBLISHABLE_KEY,
    // Debug: show which env vars are set
    envVarsFound: {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_PUBLISHABLE_KEY: !!process.env.SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      SUPABASE_KEY: !!process.env.SUPABASE_KEY,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY
    }
  });
};
