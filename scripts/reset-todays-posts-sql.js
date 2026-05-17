// Reset today's posts via SQL-like REST API query

const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';

async function resetAndVerify() {
  const today = '2026-05-14';

  console.log('=== Resetting today\'s posts ===');

  // Update all today's posts except the old TikTok one
  const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.${today}T00:00:00&created_at=lt.2026-05-15T00:00:00&post_id=neq.2026-05-05-victor-tiktok-5`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({
      status: 'approved',
      approved_at: new Date().toISOString(),
      publishing_started_at: null,
      error_message: null,
      posted_at: null,
    }),
  });

  if (!updateRes.ok) {
    console.error('❌ Update failed:', updateRes.status, updateRes.statusText);
    const error = await updateRes.text();
    console.error('Error:', error);
    process.exit(1);
  }

  const updated = await updateRes.json();
  console.log(`✅ Updated ${updated.length} posts`);

  // Verify
  console.log('\n=== Verifying posts ===');

  const verifyRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?created_at=gte.${today}T00:00:00&created_at=lt.2026-05-15T00:00:00&post_id=neq.2026-05-05-victor-tiktok-5&select=post_id,platform,status,approved_at`, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    }
  });

  const posts = await verifyRes.json();

  console.log(`\nFound ${posts.length} posts:`);
  posts.forEach(p => {
    const approvedAt = new Date(p.approved_at);
    const ageSeconds = Math.floor((Date.now() - approvedAt.getTime()) / 1000);
    console.log(`  ${p.post_id} (${p.platform})`);
    console.log(`    status: ${p.status}`);
    console.log(`    approved_at: ${p.approved_at} (${ageSeconds}s ago)`);
  });

  const allApproved = posts.every(p => p.status === 'approved');
  const allRecent = posts.every(p => {
    const ageSeconds = Math.floor((Date.now() - new Date(p.approved_at).getTime()) / 1000);
    return ageSeconds < 60;
  });

  console.log(`\n✅ All 6 approved: ${allApproved}`);
  console.log(`✅ All within 60s: ${allRecent}`);
}

resetAndVerify();
