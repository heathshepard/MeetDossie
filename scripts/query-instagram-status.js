// Query Instagram post status
import { readFileSync } from 'fs';

const envFile = readFileSync('.env.local', 'utf-8');
const SUPABASE_URL = envFile.match(/SUPABASE_URL="?(.+?)"?$/m)?.[1]?.replace(/\\r\\n/g, '').replace(/\r\n/g, '').trim();
const SUPABASE_SERVICE_ROLE_KEY = envFile.match(/SUPABASE_SERVICE_ROLE_KEY="?(.+?)"?$/m)?.[1]?.replace(/\\r\\n/g, '').replace(/\r\n/g, '').trim();

async function queryInstagram() {
  const filter = "created_at=gte.2026-05-14T00:00:00&created_at=lt.2026-05-15T00:00:00&platform=eq.instagram&select=post_id,platform,status,posted_at,error_message,media_url";

  const res = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?${filter}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const posts = await res.json();
  console.log(JSON.stringify(posts, null, 2));
}

queryInstagram();
