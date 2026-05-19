// Reset all failed posts from 2026-05-17 back to approved status
// Usage: node scripts/reset-todays-failed-posts.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}

async function resetPosts() {
  try {
    // First, get all failed posts from 2026-05-17
    const getResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.2026-05-17T00:00:00&created_at=lt.2026-05-18T00:00:00&status=eq.failed&select=*`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!getResponse.ok) {
      console.error(`Failed to fetch posts: ${getResponse.status} ${getResponse.statusText}`);
      process.exit(1);
    }

    const posts = await getResponse.json();
    console.log(`Found ${posts.length} failed posts from 2026-05-17`);

    if (posts.length === 0) {
      console.log('No failed posts to reset');
      return;
    }

    // Show post details
    posts.forEach(post => {
      console.log(`  - Post ${post.id} (${post.platform}): ${post.hook?.substring(0, 50) || 'no hook'}...`);
    });

    // Update all failed posts to approved
    const updateResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.2026-05-17T00:00:00&created_at=lt.2026-05-18T00:00:00&status=eq.failed`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          status: 'approved',
          error_message: null,
          publishing_started_at: null,
        }),
      }
    );

    if (!updateResponse.ok) {
      console.error(`Failed to update posts: ${updateResponse.status} ${updateResponse.statusText}`);
      const errorText = await updateResponse.text();
      console.error('Response:', errorText);
      process.exit(1);
    }

    console.log(`\n✅ Successfully reset ${posts.length} posts to approved status`);
    console.log('   - status: approved');
    console.log('   - error_message: NULL');
    console.log('   - publishing_started_at: NULL');

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

resetPosts();
