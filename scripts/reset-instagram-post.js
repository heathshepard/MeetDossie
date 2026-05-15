// Reset Instagram post to approved
import { readFileSync } from 'fs';

const envFile = readFileSync('.env.local', 'utf-8');
const SUPABASE_URL = envFile.match(/SUPABASE_URL="?(.+?)"?$/m)?.[1]?.replace(/\\r\\n/g, '').replace(/\r\n/g, '').trim();
const SUPABASE_SERVICE_ROLE_KEY = envFile.match(/SUPABASE_SERVICE_ROLE_KEY="?(.+?)"?$/m)?.[1]?.replace(/\\r\\n/g, '').replace(/\r\n/g, '').trim();

async function resetInstagramPost() {
  const now = new Date().toISOString();
  const patchBody = {
    status: 'approved',
    approved_at: now,
    publishing_started_at: null,
    error_message: null,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.2026-05-14T00:00:00&created_at=lt.2026-05-15T00:00:00&platform=eq.instagram`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(patchBody),
  });

  const result = await res.json();
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nUpdated ${Array.isArray(result) ? result.length : 0} Instagram post(s)`);
}

resetInstagramPost();
