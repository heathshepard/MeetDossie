// Reset only today's posts to approved

async function resetTodaysPosts() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  console.log(`Resetting posts from ${today}...`);

  const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
  const CRON_SECRET = '240fd4ebb0a46a61262a20e2000402bb4402dd9a7d426f00631e99c056b4bc8c';

  // Call the API endpoint but we need to modify it to filter by date
  // For now, let's just manually update today's posts
  const todaysPosts = [
    '2026-05-14-victor-facebook-4',
    '2026-05-14-brenda-twitter-1',
    '2026-05-14-brenda-facebook-0',
    '2026-05-14-patricia-facebook-2',
    '2026-05-14-patricia-instagram-3',
    '2026-05-14-victor-linkedin-5',
  ];

  console.log(`Posts to reset: ${todaysPosts.length}`);

  for (const postId of todaysPosts) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?post_id=eq.${postId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBnd29pdGJkaXl1Ymp1Z3d1ZmhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzgyNzExMzYsImV4cCI6MjA1Mzg0NzEzNn0.G_irtZHfPOL_KW7vVcN6gXQq0ogKknpQzrR8kA3tziM',
      },
      body: JSON.stringify({
        status: 'approved',
        error_message: null,
        publishing_started_at: null,
      }),
    });

    if (res.ok) {
      console.log(`✅ Reset ${postId}`);
    } else {
      console.log(`❌ Failed to reset ${postId}: ${res.status}`);
    }
  }

  console.log('\n✅ Done resetting today\'s posts');
}

resetTodaysPosts();
