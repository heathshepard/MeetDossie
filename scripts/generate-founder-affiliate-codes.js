#!/usr/bin/env node

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
const resend = new Resend(resendKey);

async function generateCodeFromName(fullName) {
  let code = fullName
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30);

  if (!code) {
    code = Math.random().toString(36).slice(2, 10);
  } else {
    // Check if code already exists
    const { data: collision } = await supabase
      .from('affiliate_links')
      .select('id')
      .eq('code', code)
      .single();

    if (collision) {
      code = `${code}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  return code;
}

async function main() {
  try {
    console.log('Fetching all founding members...');

    // Get all active founding subscriptions
    const { data: subscriptions, error: fetchError } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('plan', 'founding')
      .eq('status', 'active');

    if (fetchError) {
      console.error('Error fetching subscriptions:', fetchError);
      process.exit(1);
    }

    if (!subscriptions || subscriptions.length === 0) {
      console.log('No founding members found.');
      process.exit(0);
    }

    console.log(`Found ${subscriptions.length} founding members. Generating affiliate codes...`);

    let generatedCount = 0;
    let errorCount = 0;

    for (const sub of subscriptions) {
      const userId = sub.user_id;

      // Get the profile for this user
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .eq('id', userId)
        .single();

      if (profileError || !profile) {
        console.warn(`No profile found for user ${userId}`);
        errorCount++;
        continue;
      }

      // Check if code already exists
      const { data: existing } = await supabase
        .from('affiliate_links')
        .select('code')
        .eq('user_id', userId)
        .single();

      if (existing) {
        console.log(`✓ ${profile.full_name} already has code: ${existing.code}`);
        generatedCount++;
        continue;
      }

      // Generate code
      const code = await generateCodeFromName(profile.full_name);

      // Insert affiliate link
      const { data: newLink, error: insertError } = await supabase
        .from('affiliate_links')
        .insert({ user_id: userId, code })
        .select('code')
        .single();

      if (insertError) {
        console.error(`✗ Failed to create code for ${profile.full_name}:`, insertError.message);
        errorCount++;
        continue;
      }

      console.log(`✓ ${profile.full_name}: ${newLink.code}`);
      generatedCount++;

      // Send email
      if (profile.email && resendKey) {
        const affiliateLink = `https://meetdossie.com/?ref=${newLink.code}`;
        try {
          await resend.emails.send({
            from: 'heath@meetdossie.com',
            to: profile.email,
            subject: '🎯 Your Dossie affiliate link is ready',
            html: `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #FDFCFA; color: #1A1A2E;">
  <h2 style="margin-top: 0;">Hey ${(profile.full_name || '').split(' ')[0]}!</h2>
  <p>Your unique Dossie affiliate link is ready to share.</p>
  <p style="background: #F5E6E0; padding: 16px; border-radius: 8px; font-family: monospace;">
    <strong>${affiliateLink}</strong>
  </p>
  <p><strong>How it works:</strong></p>
  <ol>
    <li>Share your link with agents in your sphere</li>
    <li>When they sign up and pay, you earn $50 per referral</li>
    <li>If they sign up as a founding member, you earn $100</li>
    <li>We pay out monthly via credit to your next Dossie invoice</li>
  </ol>
  <p>You can also share via:</p>
  <ul>
    <li><a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(affiliateLink)}" style="color: #E8927C; text-decoration: none;">Facebook</a></li>
    <li><a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(affiliateLink)}&text=Check%20out%20Dossie%20for%20Texas%20agents" style="color: #E8927C; text-decoration: none;">Twitter</a></li>
    <li><a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(affiliateLink)}" style="color: #E8927C; text-decoration: none;">LinkedIn</a></li>
  </ul>
  <p>Questions? Reply to this email or visit <a href="https://meetdossie.com/app" style="color: #E8927C; text-decoration: none;">meetdossie.com/app</a></p>
  <p>—Cole</p>
</div>
            `,
          });
        } catch (err) {
          console.warn(`  (email failed: ${err.message})`);
        }
      }
    }

    console.log(`\nDone. Generated: ${generatedCount}, Errors: ${errorCount}`);
  } catch (err) {
    console.error('Script error:', err);
    process.exit(1);
  }
}

main();
