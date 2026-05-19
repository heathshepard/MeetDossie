// Add Kim Herrera as founding member
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendKey = process.env.RESEND_API_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const kimEmail = 'kimberlyherrera@kw.com';
  const kimUserId = '62aa5ffb-f796-4cb1-9a35-e57b0bde3b0e';

  console.log('\n=== Step 1: Show subscriptions table schema ===');

  // Get one row to see the columns
  const { data: sampleRow } = await supabase
    .from('subscriptions')
    .select('*')
    .limit(1);

  if (sampleRow && sampleRow[0]) {
    console.log('Columns in subscriptions table:');
    Object.keys(sampleRow[0]).forEach(col => {
      console.log(`  - ${col}: ${typeof sampleRow[0][col]} (${sampleRow[0][col] === null ? 'null' : 'has value'})`);
    });
  }

  console.log('\n=== Step 2: Check if Kim already has a subscription ===');

  const { data: existing } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', kimUserId);

  if (existing && existing.length > 0) {
    console.log('⚠️  Kim already has a subscription:');
    console.log(existing[0]);
    console.log('\nSkipping insert.');
  } else {
    console.log('No existing subscription found. Inserting...');

    const { data: newSub, error: insertError } = await supabase
      .from('subscriptions')
      .insert({
        user_id: kimUserId,
        email: kimEmail,
        status: 'active',
        plan: 'founding',
        stripe_customer_id: null,
        stripe_subscription_id: null
      })
      .select();

    if (insertError) {
      console.error('❌ Error inserting subscription:', insertError);
      process.exit(1);
    }

    console.log('✅ Subscription created:');
    console.log(newSub[0]);
  }

  console.log('\n=== Step 3: Count founding members ===');

  const { data: foundingSubs, error: countError } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('status', 'active')
    .eq('plan', 'founding');

  if (countError) {
    console.error('Error counting:', countError);
    process.exit(1);
  }

  console.log(`\n✅ Total active founding members: ${foundingSubs.length}`);
  console.log(`   Remaining spots: ${50 - foundingSubs.length}`);

  console.log('\nFounding members:');
  foundingSubs.forEach((sub, i) => {
    console.log(`  ${i + 1}. ${sub.email}`);
  });

  console.log('\n=== Step 4: Send welcome email ===');

  if (!resendKey) {
    console.log('⚠️  RESEND_API_KEY not found. Skipping email send.');
    console.log('Run this script with Vercel env vars to send email.');
    return;
  }

  const resend = new Resend(resendKey);

  const { data: emailData, error: emailError } = await resend.emails.send({
    from: 'heath@meetdossie.com',
    to: kimEmail,
    subject: 'Welcome to Dossie - Founding Member',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
        <div style="text-align: center; margin-bottom: 40px;">
          <h1 style="color: #E8836B; font-size: 32px; margin: 0;">Welcome to Dossie</h1>
          <p style="color: #666; font-size: 18px; margin: 10px 0 0 0;">You're a founding member</p>
        </div>

        <p style="font-size: 16px; line-height: 1.6; color: #333;">Hi Kim,</p>

        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          Welcome to Dossie! You're one of the first 50 founding members, and I'm thrilled to have you here.
        </p>

        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          Your founding member pricing is locked in forever at <strong>$29/month</strong>. No surprises, no increases — ever.
        </p>

        <div style="background: #F5E6E0; border-radius: 12px; padding: 24px; margin: 30px 0;">
          <h2 style="margin: 0 0 16px 0; font-size: 20px; color: #1A1A2E;">Get started:</h2>
          <p style="margin: 0 0 12px 0; font-size: 16px; color: #333;">
            1. Log in at <a href="https://meetdossie.com/app" style="color: #E8836B;">meetdossie.com/app</a>
          </p>
          <p style="margin: 0 0 12px 0; font-size: 16px; color: #333;">
            2. Open your first dossier
          </p>
          <p style="margin: 0; font-size: 16px; color: #333;">
            3. Upload a contract and watch Dossie fill in the details
          </p>
        </div>

        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          I'm here if you need anything. Just reply to this email.
        </p>

        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          — Heath
        </p>

        <hr style="border: none; border-top: 1px solid #eee; margin: 40px 0;" />

        <p style="font-size: 14px; color: #999; text-align: center;">
          Dossie • Your deals. Her job. • <a href="https://meetdossie.com" style="color: #E8836B;">meetdossie.com</a>
        </p>
      </div>
    `
  });

  if (emailError) {
    console.error('❌ Error sending email:', emailError);
  } else {
    console.log('✅ Welcome email sent to', kimEmail);
    console.log('   Email ID:', emailData.id);
  }
}

main().catch(console.error);
