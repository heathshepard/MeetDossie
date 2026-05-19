const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports = async function handler(req, res) {
  try {
    // Auth check
    const authHeader = req.headers.authorization;
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;

    if (authHeader !== expectedAuth) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const resendKey = process.env.RESEND_API_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).json({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const kimEmail = 'kimberlyherrera@kw.com';
    const kimUserId = '62aa5ffb-f796-4cb1-9a35-e57b0bde3b0e';

    const results = {};

    // Step 1: Show subscriptions table schema
    const { data: sampleRow } = await supabase
      .from('subscriptions')
      .select('*')
      .limit(1);

    if (sampleRow && sampleRow[0]) {
      results.schema = Object.keys(sampleRow[0]);
    }

    // Step 2: Check if Kim already has a subscription
    const { data: existing } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', kimUserId);

    if (existing && existing.length > 0) {
      results.existing = existing[0];
      results.action = 'skipped - subscription already exists';
    } else {
      // Insert new subscription
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
        return res.status(500).json({ error: 'Insert failed', details: insertError });
      }

      results.newSubscription = newSub[0];
      results.action = 'created';
    }

    // Step 3: Count founding members
    const { data: foundingSubs, error: countError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('status', 'active')
      .eq('plan', 'founding');

    if (countError) {
      return res.status(500).json({ error: 'Count failed', details: countError });
    }

    results.foundingCount = foundingSubs.length;
    results.remaining = 50 - foundingSubs.length;
    results.foundingMembers = foundingSubs.map(s => s.email);

    // Step 4: Send welcome email
    if (!resendKey) {
      results.email = 'skipped - RESEND_API_KEY not found';
    } else if (results.action === 'skipped - subscription already exists') {
      results.email = 'skipped - subscription already existed';
    } else {
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
        results.email = { status: 'error', details: emailError };
      } else {
        results.email = { status: 'sent', emailId: emailData.id, to: kimEmail };
      }
    }

    return res.status(200).json(results);
  } catch (err) {
    console.error('[add-kim-subscription] error:', err);
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};
