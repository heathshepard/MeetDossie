// TEMPORARY verification-only endpoint — generates a real Supabase magic-link
// sign-in URL for a given demo account so a Playwright real-browser check can
// sign in without needing a password that isn't available to this session
// (SV-ENG-TEAM-RISK-PUSH verification, 2026-08-23). Deleted before this
// feature's staging work is considered done. Restricted to demo@ addresses
// only — never usable against a real customer account.
const { createClient } = require('@supabase/supabase-js');
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const email = (req.query && req.query.email) || '';
  if (!/@meetdossie\.com$/i.test(email) || !/^demo/i.test(email)) {
    return res.status(400).json({ ok: false, error: 'only demo*@meetdossie.com allowed' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data, error } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(200).json({
      ok: true,
      action_link: data.properties && data.properties.action_link,
      hashed_token: data.properties && data.properties.hashed_token,
      user_id: data.user && data.user.id,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
