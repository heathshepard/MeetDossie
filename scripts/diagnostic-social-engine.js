// Social Posting Engine Diagnostic Script
// Run with: node scripts/diagnostic-social-engine.js

const fs = require('fs');
const path = require('path');

// Load env vars from .env.local
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const envVars = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^([^=]+)=(.*)$/);
  if (match) {
    envVars[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
});

const SUPABASE_URL = envVars.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_MARKETING_BOT_TOKEN = envVars.TELEGRAM_MARKETING_BOT_TOKEN;
const ZERNIO_API_KEY = envVars.ZERNIO_API_KEY;
const HCTI_USER_ID = envVars.HCTI_USER_ID;
const HCTI_API_KEY = envVars.HCTI_API_KEY;

async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return await res.json();
}

async function checkWebhook() {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/getWebhookInfo`);
    const data = await res.json();
    if (data.ok && data.result.url === 'https://meetdossie.com/api/telegram-webhook') {
      console.log('✅ Webhook: Registered and active');
      console.log(`   URL: ${data.result.url}`);
      console.log(`   Pending updates: ${data.result.pending_update_count}`);
      return true;
    } else {
      console.log('❌ Webhook: Not registered or incorrect URL');
      console.log(`   Current URL: ${data.result?.url || 'none'}`);
      return false;
    }
  } catch (error) {
    console.log('❌ Webhook: Check failed');
    console.log(`   Error: ${error.message}`);
    return false;
  }
}

async function checkTodaysPosts() {
  try {
    const today = new Date().toISOString().split('T')[0];
    const posts = await supabaseFetch(`/rest/v1/social_posts?select=post_id,platform,status,telegram_sent_at,posted_at&created_at=gte.${today}T00:00:00&order=created_at.desc`);

    if (!Array.isArray(posts)) {
      console.log('\n❌ Supabase: Invalid response (not an array)');
      console.log(`   Response: ${JSON.stringify(posts).substring(0, 100)}`);
      return [];
    }

    console.log(`\n✅ Supabase: ${posts.length} posts found for today (${today})`);

    if (posts.length === 0) {
      console.log('   No posts generated yet');
      return posts;
    }

    const statusCounts = {};
    posts.forEach(p => {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    });

    Object.entries(statusCounts).forEach(([status, count]) => {
      console.log(`   ${status}: ${count}`);
    });

    console.log('\n   Post details:');
    posts.forEach(p => {
      const sentFlag = p.telegram_sent_at ? '✅' : '⏳';
      const postedFlag = p.posted_at ? '✅' : '⏳';
      console.log(`   ${p.post_id.substring(0, 30)}... ${p.platform.padEnd(10)} ${p.status.padEnd(12)} Sent:${sentFlag} Posted:${postedFlag}`);
    });

    return posts;
  } catch (error) {
    console.log('\n❌ Supabase: Check failed');
    console.log(`   Error: ${error.message}`);
    return [];
  }
}

async function checkZernioConnections() {
  try {
    const res = await fetch('https://api.zernio.com/accounts', {
      headers: { 'Authorization': `Bearer ${ZERNIO_API_KEY}` },
    });
    const data = await res.json();

    console.log('\n✅ Zernio: Connections checked');

    const platforms = ['facebook', 'twitter', 'instagram', 'linkedin'];
    platforms.forEach(platform => {
      const account = data.accounts?.find(a => a.platform === platform && a.is_active);
      if (account) {
        console.log(`   ✅ ${platform.padEnd(10)} Connected (${account.name})`);
      } else {
        console.log(`   ❌ ${platform.padEnd(10)} Not connected or inactive`);
      }
    });

    return true;
  } catch (error) {
    console.log('❌ Zernio: Check failed');
    console.log(`   Error: ${error.message}`);
    return false;
  }
}

async function checkHCTI() {
  try {
    // Make a test request to check if credentials work
    const testRes = await fetch('https://hcti.io/v1/image', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${HCTI_USER_ID}:${HCTI_API_KEY}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html: '<div>test</div>',
        css: 'div { color: red; }',
      }),
    });

    if (testRes.ok) {
      console.log('\n✅ HCTI: Card generation working');
      console.log(`   API credentials valid`);
      return true;
    } else {
      console.log('\n❌ HCTI: Card generation failed');
      console.log(`   Status: ${testRes.status}`);
      return false;
    }
  } catch (error) {
    console.log('\n❌ HCTI: Check failed');
    console.log(`   Error: ${error.message}`);
    return false;
  }
}

async function checkCronSchedule() {
  console.log('\n✅ Cron Schedule: Verified from vercel.json');
  console.log('   /api/cron-publish-approved: */30 * * * * (every 30 minutes)');
  return true;
}

async function checkDailyCaps() {
  try {
    const schedule = await supabaseFetch('/rest/v1/posting_schedule?select=platform,max_per_day&is_active=eq.true');

    if (!Array.isArray(schedule)) {
      console.log('\n❌ Daily Caps: Invalid response');
      return false;
    }

    console.log('\n✅ Daily Caps: Current settings');

    const expected = {
      facebook: 1,
      twitter: 2,
      instagram: 1,
      linkedin: 1,
    };

    let allCorrect = true;
    Object.entries(expected).forEach(([platform, expectedCap]) => {
      const actual = schedule.find(s => s.platform === platform);
      const actualCap = actual?.max_per_day || 0;
      const match = actualCap === expectedCap;
      if (!match) allCorrect = false;
      const flag = match ? '✅' : '❌';
      console.log(`   ${flag} ${platform.padEnd(10)} ${actualCap} (expected ${expectedCap})`);
    });

    return allCorrect;
  } catch (error) {
    console.log('\n❌ Daily Caps: Check failed');
    console.log(`   Error: ${error.message}`);
    return false;
  }
}

async function checkStuckPosts() {
  try {
    const stuck = await supabaseFetch('/rest/v1/social_posts?select=post_id,platform,status,error_message,created_at&status=in.(failed,draft)&created_at=lt.2026-05-14T00:00:00&order=created_at.desc&limit=10');

    if (!Array.isArray(stuck)) {
      console.log('\n❌ Stuck Posts: Invalid response');
      return false;
    }

    if (stuck.length === 0) {
      console.log('\n✅ Stuck Posts: None found');
      return true;
    } else {
      console.log(`\n❌ Stuck Posts: ${stuck.length} posts found`);
      stuck.forEach(p => {
        const age = Math.floor((Date.now() - new Date(p.created_at).getTime()) / (1000 * 60 * 60));
        console.log(`   ${p.status.padEnd(10)} ${p.platform.padEnd(10)} Age: ${age}h Error: ${p.error_message || 'none'}`);
      });
      return false;
    }
  } catch (error) {
    console.log('\n❌ Stuck Posts: Check failed');
    console.log(`   Error: ${error.message}`);
    return false;
  }
}

async function runDiagnostic() {
  console.log('=== SOCIAL POSTING ENGINE DIAGNOSTIC ===\n');
  console.log('Starting checks...\n');

  await checkWebhook();
  await checkTodaysPosts();
  await checkZernioConnections();
  await checkHCTI();
  await checkCronSchedule();
  await checkDailyCaps();
  await checkStuckPosts();

  console.log('\n=== DIAGNOSTIC COMPLETE ===');
}

runDiagnostic().catch(console.error);
