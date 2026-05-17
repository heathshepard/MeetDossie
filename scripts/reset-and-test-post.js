// Temporary script: Reset one failed post to approved and test the cron
// Run with: node scripts/reset-and-test-post.js

const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY not set');
  console.error('Get it from Vercel dashboard and run:');
  console.error('SUPABASE_SERVICE_ROLE_KEY="your-key" node scripts/reset-and-test-post.js');
  process.exit(1);
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function main() {
  console.log('\n=== STEP 1: Find and reset one failed post to approved ===\n');

  // Query for one failed post from today
  const today = new Date().toISOString().split('T')[0];
  const { data: failed, ok: queryOk } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.failed&created_at=gte.${today}T00:00:00&select=id,post_id,platform,status,error_message,publishing_started_at&order=created_at.desc&limit=1`
  );

  if (!queryOk || !Array.isArray(failed) || failed.length === 0) {
    console.error('ERROR: No failed posts found today');
    console.error('Response:', failed);
    process.exit(1);
  }

  const post = failed[0];
  console.log('Found failed post:');
  console.log(`  ID: ${post.id}`);
  console.log(`  Post ID: ${post.post_id}`);
  console.log(`  Platform: ${post.platform}`);
  console.log(`  Status: ${post.status}`);
  console.log(`  Error: ${post.error_message || '(null)'}`);

  // Reset to approved
  const { ok: patchOk, data: patched } = await supabaseFetch(
    `/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        status: 'approved',
        error_message: null,
        publishing_started_at: null,
        approved_at: new Date().toISOString(),
      }),
    }
  );

  if (!patchOk) {
    console.error('ERROR: Failed to update post');
    console.error('Response:', patched);
    process.exit(1);
  }

  const updated = Array.isArray(patched) && patched.length > 0 ? patched[0] : null;

  console.log('\n✅ Post reset to approved:');
  console.log(`  Post ID: ${updated.post_id}`);
  console.log(`  Status: ${updated.status}`);
  console.log(`  Error: ${updated.error_message || '(null)'}`);
  console.log(`  Publishing started: ${updated.publishing_started_at || '(null)'}`);

  console.log('\n=== STEP 2: Trigger cron-publish-approved ===\n');

  const cronRes = await fetch('https://meetdossie.com/api/cron-publish-approved', {
    method: 'POST',
    headers: { 'x-vercel-cron': '1' },
  });

  const cronText = await cronRes.text();
  let cronData = null;
  try { cronData = JSON.parse(cronText); } catch {}

  console.log('Cron response:');
  console.log(JSON.stringify(cronData || cronText, null, 2));

  console.log('\n=== STEP 3: Check post status again ===\n');

  const { data: final } = await supabaseFetch(
    `/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}&select=id,post_id,platform,status,error_message,publishing_started_at,posted_at&limit=1`
  );

  const finalPost = Array.isArray(final) && final.length > 0 ? final[0] : null;

  if (finalPost) {
    console.log('Final post status:');
    console.log(`  Post ID: ${finalPost.post_id}`);
    console.log(`  Status: ${finalPost.status}`);
    console.log(`  Error: ${finalPost.error_message || '(null)'}`);
    console.log(`  Publishing started: ${finalPost.publishing_started_at || '(null)'}`);
    console.log(`  Posted at: ${finalPost.posted_at || '(null)'}`);

    if (finalPost.status === 'posted') {
      console.log('\n✅ SUCCESS: Post was published!');
    } else if (finalPost.status === 'failed') {
      console.log('\n❌ FAILED: Post is marked as failed');
      console.log(`Error: ${finalPost.error_message}`);
    } else {
      console.log(`\n⏳ Status is still: ${finalPost.status}`);
    }
  }
}

main().catch(console.error);
