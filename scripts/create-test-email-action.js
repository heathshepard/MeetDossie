#!/usr/bin/env node
/**
 * Script to create a test send_email action in the heath_actions table.
 * Used for APV (Automated Production Verification) testing.
 * Run: node scripts/create-test-email-action.js
 */

const { createClient } = require('@supabase/supabase-js');
const readline = require('readline');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  try {
    // Get Heath's user ID
    const { data: heath_user, error: userErr } = await supabase
      .from('auth.users')
      .select('id')
      .eq('email', 'heath.shepard@kw.com')
      .single();

    if (userErr || !heath_user) {
      console.error('ERROR: Could not find Heath user (heath.shepard@kw.com)');
      console.error(userErr);
      process.exit(1);
    }

    const heath_id = heath_user.id;
    console.log(`Found Heath user: ${heath_id}`);

    // Create test email action for Tiffany double-billing follow-up
    const testAction = {
      tenant_id: heath_id,
      title: 'Approve email: Tiffany Gill double-billing follow-up',
      body: 'Drafted email response to Tiffany about duplicate transaction charge. Verify content and approve to send.',
      source: 'pierce_2',
      priority: 'urgent',
      status: 'pending',
      action_type: 'send_email',
      payload: {
        to: 'demo@meetdossie.com', // For testing; change to tiffany.gill@email.com in production
        subject: 'Re: Your Recent Dossie Charge – We Got This',
        body_text: `Hi Tiffany,

Thanks so much for reaching out about the duplicate charge. That's not what we want, and I appreciate you catching it.

I've reviewed your account and I can confirm a duplicate transaction processed on June 22. I'm going to manually reverse the erroneous charge right now, and you should see the credit back to your card within 1-2 business days.

Moving forward, your account will be billed once per month on the 22nd, and you're all set.

If you have any other questions or concerns, please don't hesitate to reach out. We really appreciate you being part of the Dossie founding team.

Warmly,
Pierce
Dossie Customer Success`,
        from_email: 'heath@meetdossie.com',
        from_name: 'Pierce - Dossie',
        reply_to: 'heath@meetdossie.com',
      },
    };

    const { data, error } = await supabase
      .from('heath_actions')
      .insert([testAction])
      .select('id, title, created_at');

    if (error) {
      console.error('ERROR: Could not insert action', error);
      process.exit(1);
    }

    if (!data || !data[0]) {
      console.error('ERROR: No action returned from insert');
      process.exit(1);
    }

    console.log(`\n✓ Created test email action:`);
    console.log(`  ID: ${data[0].id}`);
    console.log(`  Title: ${data[0].title}`);
    console.log(`  Created: ${data[0].created_at}`);
    console.log(`\nTest recipient: demo@meetdossie.com`);
    console.log('To use real recipient, update the action payload.to field manually or rerun with TIFFANY_EMAIL env var.');
  } catch (err) {
    console.error('ERROR:', err);
    process.exit(1);
  }
}

main();
