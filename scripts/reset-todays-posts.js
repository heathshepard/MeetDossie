// Reset only today's posts to approved

async function resetTodaysPosts() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  console.log(`Resetting posts from ${today}...`);

  const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

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
        'apikey': SUPABASE_ANON_KEY,
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
