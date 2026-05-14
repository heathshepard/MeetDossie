// Check detailed status of today's posts

async function checkPosts() {
  const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
  const CRON_SECRET = '240fd4ebb0a46a61262a20e2000402bb4402dd9a7d426f00631e99c056b4bc8c';

  // Query via the API endpoint that has auth
  const posts = [
    '2026-05-14-victor-facebook-4',
    '2026-05-14-brenda-twitter-1',
    '2026-05-14-brenda-facebook-0',
    '2026-05-14-patricia-facebook-2',
    '2026-05-14-patricia-instagram-3',
    '2026-05-14-victor-linkedin-5',
  ];

  console.log('=== Today\'s Posts Detailed Status ===\n');

  for (const postId of posts) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?post_id=eq.${postId}&select=post_id,platform,status,approved_at,posted_at,error_message,publishing_started_at`, {
      headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzgyNzExMzYsImV4cCI6MjA1Mzg0NzEzNn0.G_irtZHfPOL_KW7vVcN6gXQq0ogKknpQzrR8kA3tziM',
      }
    });

    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        const post = data[0];
        console.log(`${post.post_id} (${post.platform})`);
        console.log(`  status: ${post.status}`);
        console.log(`  publishing_started_at: ${post.publishing_started_at}`);
        console.log(`  approved_at: ${post.approved_at}`);
        console.log(`  posted_at: ${post.posted_at}`);
        console.log(`  error_message: ${post.error_message}`);
        console.log('');
      }
    } else {
      console.log(`Failed to fetch ${postId}: ${res.status}`);
    }
  }
}

checkPosts();
