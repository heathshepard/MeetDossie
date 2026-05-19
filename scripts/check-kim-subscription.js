// Check and fix Kim Herrera's subscription
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const email = 'kimberlyherrera@kw.com';

  console.log(`\n1. Checking auth.users for ${email}...`);
  const { data: user, error: userError } = await supabase.auth.admin.listUsers();

  if (userError) {
    console.error('Error fetching users:', userError);
    process.exit(1);
  }

  const kimUser = user.users.find(u => u.email === email);

  if (!kimUser) {
    console.log('❌ No user found in auth.users');
    return;
  }

  console.log('✓ User found:', kimUser.id);

  console.log(`\n2. Checking subscriptions table...`);
  const { data: subs, error: subsError } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', kimUser.id);

  if (subsError) {
    console.error('Error fetching subscriptions:', subsError);
    process.exit(1);
  }

  if (subs && subs.length > 0) {
    console.log('✓ Subscription exists:', subs[0]);
  } else {
    console.log('❌ No subscription found. Creating founding subscription...');

    const { data: newSub, error: insertError } = await supabase
      .from('subscriptions')
      .insert({
        user_id: kimUser.id,
        email: email,
        status: 'active',
        plan: 'founding',
        stripe_customer_id: null,
        stripe_subscription_id: null,
        created_at: new Date().toISOString()
      })
      .select();

    if (insertError) {
      console.error('Error inserting subscription:', insertError);
      process.exit(1);
    }

    console.log('✓ Subscription created:', newSub[0]);
  }

  console.log(`\n3. Counting total founding subscriptions...`);
  const { data: foundingSubs, error: countError } = await supabase
    .from('subscriptions')
    .select('id', { count: 'exact' })
    .eq('status', 'active')
    .eq('plan', 'founding');

  if (countError) {
    console.error('Error counting subscriptions:', countError);
    process.exit(1);
  }

  const foundingCount = foundingSubs?.length || 0;
  const remaining = 50 - foundingCount;

  console.log(`\n✓ Total active founding subscriptions: ${foundingCount}`);
  console.log(`✓ Remaining founding spots: ${remaining}`);

  if (foundingCount === 4 && remaining === 46) {
    console.log('\n✅ CONFIRMED: 4 founding members, 46 spots remaining');
  } else {
    console.log(`\n⚠️  Expected 4 founding members, but found ${foundingCount}`);
  }
}

main().catch(console.error);
