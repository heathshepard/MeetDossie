import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Check if affiliate link already exists (idempotent)
  const { data: existing } = await supabase
    .from('affiliate_links')
    .select('code')
    .eq('user_id', user.id)
    .single();

  if (existing) {
    return res.status(200).json({ code: existing.code });
  }

  // Generate code from profile name, fallback to random 8-char
  let code = null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', user.id)
    .single();

  if (profile?.full_name) {
    code = profile.full_name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .slice(0, 30);
  }

  // Fallback to random if name-based code already taken
  if (!code) {
    code = Math.random().toString(36).slice(2, 10);
  } else {
    const { data: collision } = await supabase
      .from('affiliate_links')
      .select('id')
      .eq('code', code)
      .single();

    if (collision) {
      code = `${code}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  // Insert affiliate link
  const { data: newLink, error: insertError } = await supabase
    .from('affiliate_links')
    .insert({ user_id: user.id, code })
    .select('code')
    .single();

  if (insertError) {
    return res.status(500).json({ error: 'Failed to generate code' });
  }

  return res.status(200).json({ code: newLink.code });
}
