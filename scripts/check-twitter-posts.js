// Check Twitter posts from today
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pgwoitbdiyubjugwufhk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY not set');
    process.exit(1);
  }

  const today = '2026-05-19';
  const startTime = `${today}T00:00:00`;
  const endTime = `${today}T23:59:59`;

  // Query for all Twitter posts from today
  const url = `${SUPABASE_URL}/rest/v1/social_posts?platform=eq.twitter&created_at=gte.${startTime}&created_at=lte.${endTime}&select=id,post_id,platform,persona,hook,status,error_message,created_at&order=created_at.desc`;

  const response = await fetch(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  if (!response.ok) {
    console.error('Failed to fetch:', response.status, response.statusText);
    const text = await response.text();
    console.error(text);
    process.exit(1);
  }

  const posts = await response.json();
  console.log(`\nFound ${posts.length} Twitter posts from ${today}:\n`);

  posts.forEach((post, i) => {
    console.log(`${i + 1}. ${post.post_id || 'no-id'}`);
    console.log(`   Persona: ${post.persona}`);
    console.log(`   Status: ${post.status}`);
    console.log(`   Hook: ${(post.hook || '').substring(0, 60)}...`);
    if (post.error_message) {
      console.log(`   Error: ${post.error_message}`);
    }
    console.log(`   Created: ${post.created_at}`);
    console.log(`   ID: ${post.id}\n`);
  });

  // Find brenda posts specifically
  const brendaPosts = posts.filter(p => p.persona === 'brenda');
  if (brendaPosts.length > 0) {
    console.log(`\nBrenda posts: ${brendaPosts.length}`);
    brendaPosts.forEach(p => {
      console.log(`  - Status: ${p.status}, Hook: ${(p.hook || '').substring(0, 40)}`);
    });
  }
}

main().catch(console.error);
