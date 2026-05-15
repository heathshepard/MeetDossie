// Query specific twitter post that failed
import { readFileSync } from 'fs';

const envFile = readFileSync('.env.local', 'utf-8');
const SUPABASE_URL = envFile.match(/SUPABASE_URL="?(.+?)"?$/m)?.[1]?.replace(/\\r\\n/g, '').replace(/\r\n/g, '').trim();
const SUPABASE_SERVICE_ROLE_KEY = envFile.match(/SUPABASE_SERVICE_ROLE_KEY="?(.+?)"?$/m)?.[1]?.replace(/\\r\\n/g, '').replace(/\r\n/g, '').trim();

async function queryTwitterPost() {
  const filter = "post_id=eq.2026-05-14-brenda-twitter-1&select=post_id,platform,content,media_url,zernio_account_id,hashtags,status,error_message";

  const res = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?${filter}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const posts = await res.json();
  console.log(JSON.stringify(posts, null, 2));
}

queryTwitterPost();
