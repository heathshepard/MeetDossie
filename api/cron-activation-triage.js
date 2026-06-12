// Vercel Serverless Function: /api/cron-activation-triage
// Runs daily 10:00 UTC (5 AM CDT) to audit customer activation and queue re-engagement emails.
//
// Uses CRON_SECRET for authorization.
// Sends Telegram pings to Heath at chat_id 7874782923.

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { withTelemetry } = require('./_lib/cron-telemetry.js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEATH_CHAT_ID = '7874782923';

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: HEATH_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
      }),
    });
  } catch (e) {
    console.error('Telegram send error:', e);
  }
}

async function sendResendeEmail(to, subject, body) {
  if (!process.env.RESEND_API_KEY) return false;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'heath@meetdossie.com',
        to,
        subject,
        html: body,
      }),
    });
    return response.ok;
  } catch (e) {
    console.error('Resend email error:', e);
    return false;
  }
}

async function getActivationStatus(userId) {
  const { data: events } = await supabase
    .from('activation_events')
    .select('event_type, created_at')
    .eq('user_id', userId);

  const eventMap = {};
  (events || []).forEach((evt) => {
    eventMap[evt.event_type] = evt.created_at;
  });

  return eventMap;
}

async function logTriageAction(userId, action, daysSinceSignup, metadata = {}) {
  await supabase.from('activation_triage_log').insert({
    user_id: userId,
    action,
    days_since_signup: daysSinceSignup,
    metadata,
  });
}

module.exports = withTelemetry('cron-activation-triage', async function handler(req, res) {
  // Authorization via CRON_SECRET
  const authHeader = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || authHeader !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // Fetch all active paying subscribers
    const { data: subscriptions, error: subsError } = await supabase
      .from('subscriptions')
      .select('user_id')
      .eq('status', 'active');

    if (subsError) {
      console.error('Subscriptions query error:', subsError);
      return res.status(500).json({ ok: false, error: 'Failed to fetch subscriptions' });
    }

    const results = {
      checked: 0,
      day3_misses: [],
      day7_inactive: [],
      day14_no_docs: [],
      day30_testimonial: [],
    };

    const now = Date.now();

    for (const { user_id } of subscriptions || []) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('id, email, full_name, created_at')
        .eq('id', user_id)
        .single();

      if (!profile) continue;

      results.checked++;

      const signupTime = new Date(profile.created_at).getTime();
      const daysSinceSignup = Math.floor((now - signupTime) / (1000 * 60 * 60 * 24));

      const events = await getActivationStatus(user_id);
      const { data: logins } = await supabase
        .from('auth.users')
        .select('last_sign_in_at')
        .eq('id', user_id)
        .single();

      const lastLoginTime = logins?.last_sign_in_at
        ? new Date(logins.last_sign_in_at).getTime()
        : null;
      const hoursSinceLogin = lastLoginTime ? Math.floor((now - lastLoginTime) / (1000 * 60 * 60)) : null;

      // Day 3: First dossier missing
      if (
        daysSinceSignup >= 3 &&
        !events['first_dossier_created'] &&
        !results.day3_misses.find((u) => u.user_id === user_id)
      ) {
        results.day3_misses.push({
          user_id,
          email: profile.email,
          name: profile.full_name,
        });
        await logTriageAction(user_id, 'day3_no_dossier', daysSinceSignup);
      }

      // Day 7: No recent login
      if (
        daysSinceSignup >= 7 &&
        hoursSinceLogin !== null &&
        hoursSinceLogin > 96 &&
        !results.day7_inactive.find((u) => u.user_id === user_id)
      ) {
        results.day7_inactive.push({
          user_id,
          email: profile.email,
          name: profile.full_name,
          hoursSinceLogin,
        });
        await logTriageAction(user_id, 'day7_inactive', daysSinceSignup, { hoursSinceLogin });
      }

      // Day 14: No documents uploaded
      if (
        daysSinceSignup >= 14 &&
        !events['first_document_uploaded'] &&
        !results.day14_no_docs.find((u) => u.user_id === user_id)
      ) {
        results.day14_no_docs.push({
          user_id,
          email: profile.email,
          name: profile.full_name,
        });
        await logTriageAction(user_id, 'day14_no_docs', daysSinceSignup);
      }

      // Day 30: Has activity — ask for testimonial
      if (
        daysSinceSignup >= 30 &&
        (events['first_dossier_created'] ||
          events['first_email_queued'] ||
          events['first_action_item_completed']) &&
        !results.day30_testimonial.find((u) => u.user_id === user_id)
      ) {
        results.day30_testimonial.push({
          user_id,
          email: profile.email,
          name: profile.full_name,
        });
        await logTriageAction(user_id, 'day30_testimonial_ask', daysSinceSignup);
      }
    }

    // Send Telegram summary to Heath
    const hasMisses = results.day3_misses.length > 0;
    const hasInactive = results.day7_inactive.length > 0;
    const hasNoDocs = results.day14_no_docs.length > 0;
    const hasTestimony = results.day30_testimonial.length > 0;

    if (hasMisses || hasInactive || hasNoDocs || hasTestimony) {
      let message = '<b>📊 Activation Triage Report</b>\n\n';

      if (hasMisses) {
        message += `<b>Day 3 — No dossier yet (${results.day3_misses.length}):</b>\n`;
        results.day3_misses.forEach((u) => {
          message += `  • ${u.name} (${u.email})\n`;
        });
        message += '\n';
      }

      if (hasInactive) {
        message += `<b>Day 7 — Inactive (${results.day7_inactive.length}):</b>\n`;
        results.day7_inactive.forEach((u) => {
          message += `  • ${u.name} (${u.email}, last login ${u.hoursSinceLogin}h ago)\n`;
        });
        message += '\n';
      }

      if (hasNoDocs) {
        message += `<b>Day 14 — No docs (${results.day14_no_docs.length}):</b>\n`;
        results.day14_no_docs.forEach((u) => {
          message += `  • ${u.name} (${u.email})\n`;
        });
        message += '\n';
      }

      if (hasTestimony) {
        message += `<b>Day 30 — Testimonial ask (${results.day30_testimonial.length}):</b>\n`;
        results.day30_testimonial.forEach((u) => {
          message += `  • ${u.name} (${u.email})\n`;
        });
      }

      await sendTelegram(message);
    }

    return res.status(200).json({
      ok: true,
      checked: results.checked,
      day3_misses: results.day3_misses.length,
      day7_inactive: results.day7_inactive.length,
      day14_no_docs: results.day14_no_docs.length,
      day30_testimonial: results.day30_testimonial.length,
    });
  } catch (err) {
    console.error('Activation triage error:', err);
    await sendTelegram(`❌ Activation triage cron failed: ${err.message}`);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
