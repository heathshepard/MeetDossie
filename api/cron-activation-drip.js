// Vercel Serverless Function: /api/cron-activation-drip
//
// System 1 — Activation Drip: 3-email sequence for founding members who have
//   never uploaded a document (LEFT JOIN documents IS NULL) and are 3+ days old.
//   Email 1: day 4   (activation_email_1_sent_at IS NULL)
//   Email 2: day 7   (email 1 sent, email 2 not yet)
//   Email 3: day 14  (email 2 sent, email 3 not yet)
//
// System 2 — Referral Ask: single email at day 14-21 for founding members who
//   HAVE uploaded at least 1 document and haven't received a referral ask yet.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1 header
// Triggered by: cron-job.org external cron (NOT in vercel.json — Vercel is at 20/20 cap)
// Register at cron-job.org: 0 15 * * * (3 PM UTC = 10 AM CST daily)
//
// From: heath@meetdossie.com (Resend)
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, RESEND_API_KEY

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FROM_EMAIL = 'heath@meetdossie.com';
const APP_URL = 'https://meetdossie.com/app';
const FOUNDING_URL = 'https://meetdossie.com/founding';

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

async function supaJson(path, opts = {}) {
  const res = await supa(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Patch a single profile column (mark email as sent)
async function markEmailSent(userId, column) {
  const now = new Date().toISOString();
  const { ok, status, data } = await supaJson(
    `profiles?id=eq.${userId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ [column]: now }),
    }
  );
  if (!ok) {
    console.error(`[cron-activation-drip] PATCH profiles.${column} failed for ${userId}:`, status, JSON.stringify(data));
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Resend helper
// ---------------------------------------------------------------------------

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.error('[cron-activation-drip] RESEND_API_KEY not set — skipping email to', to);
    return { ok: false, error: 'RESEND_API_KEY not set' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
    }),
  });

  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (!res.ok) {
    console.error('[cron-activation-drip] Resend error for', to, res.status, text.slice(0, 300));
    return { ok: false, status: res.status, error: body };
  }

  console.log('[cron-activation-drip] Email sent to', to, '| id:', body?.id);
  return { ok: true, id: body?.id };
}

// ---------------------------------------------------------------------------
// Email builders
// ---------------------------------------------------------------------------

function firstName(fullName) {
  if (!fullName) return 'there';
  return fullName.split(' ')[0] || fullName;
}

function buildEmail1(profile) {
  const name = firstName(profile.full_name);
  return {
    subject: 'Quick question about your first deal',
    html: `
<p>Hey ${name} --</p>

<p>Wanted to check in. Have you had a chance to add your first transaction to Dossie yet?</p>

<p>If anything is confusing or not working, just reply here and I'll fix it personally. I built this thing and I want to make sure it actually works for you.</p>

<p><a href="${APP_URL}">Open Dossie</a></p>

<p>-- Heath</p>
    `.trim(),
  };
}

function buildEmail2(profile) {
  const name = firstName(profile.full_name);
  return {
    subject: 'The fastest way to get value from Dossie',
    html: `
<p>Hey ${name} --</p>

<p>One thing takes 5 minutes and changes everything: add one live deal.</p>

<p>Just the address and the close date. Dossie will tell you every TREC deadline you need to hit. That's it.</p>

<p><a href="${APP_URL}">Try it now</a></p>

<p>-- Heath</p>
    `.trim(),
  };
}

function buildEmail3(profile) {
  const name = firstName(profile.full_name);
  return {
    subject: 'Your founding spot -- want me to help you get started?',
    html: `
<p>Hey ${name} --</p>

<p>I noticed you haven't had a chance to add a deal yet.</p>

<p>Happy to jump on a quick call and walk you through it. Just reply with a time that works.</p>

<p>Also -- if Dossie isn't the right fit right now, no hard feelings. Just let me know.</p>

<p>-- Heath</p>
    `.trim(),
  };
}

function buildReferralEmail(profile) {
  const name = firstName(profile.full_name);
  return {
    subject: 'Know another agent who needs this?',
    html: `
<p>Hey ${name} --</p>

<p>You've been running deals through Dossie for a couple weeks now. If you know another agent who's still paying $400 a file or dealing with TC headaches, send them here: <a href="${FOUNDING_URL}">${FOUNDING_URL}</a></p>

<p>There are 38 founding spots left at $29/month -- that number is real and it's going down.</p>

<p>No referral program or commissions -- just thought you'd want to share if it's been helpful.</p>

<p>Thanks for being one of the first.</p>

<p>-- Heath</p>
    `.trim(),
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  // Auth
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const results = {
    activation: { checked: 0, email1_sent: 0, email2_sent: 0, email3_sent: 0, skipped: 0 },
    referral: { checked: 0, sent: 0, skipped: 0 },
    errors: [],
  };

  // -------------------------------------------------------------------------
  // System 1: Activation Drip
  // Members with no document uploaded, signed up 3+ days ago, plan=founding
  // -------------------------------------------------------------------------

  const { ok: aOk, data: inactiveProfiles } = await supaJson(
    'profiles' +
    '?select=id,email,full_name,created_at,activation_email_1_sent_at,activation_email_2_sent_at,activation_email_3_sent_at' +
    '&is_demo=eq.false' +
    '&plan=eq.founding' +
    '&created_at=lt.' + new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() +
    '&limit=200'
  );

  if (!aOk || !Array.isArray(inactiveProfiles)) {
    console.error('[cron-activation-drip] Failed to fetch activation profiles');
    results.errors.push('Failed to fetch activation profiles');
  } else {
    // Get all user IDs that have uploaded at least one document
    const userIds = inactiveProfiles.map(p => p.id);
    let docUploaderIds = new Set();

    if (userIds.length > 0) {
      // Query documents for these users — use in filter
      const { ok: dOk, data: docs } = await supaJson(
        `documents?select=user_id&user_id=in.(${userIds.join(',')})&limit=500`
      );
      if (dOk && Array.isArray(docs)) {
        for (const d of docs) {
          docUploaderIds.add(d.user_id);
        }
      }
    }

    // Process each profile
    for (const p of inactiveProfiles) {
      results.activation.checked++;

      // Skip if they have uploaded a document — they're activated
      if (docUploaderIds.has(p.id)) {
        results.activation.skipped++;
        continue;
      }

      const signupAge = Date.now() - new Date(p.created_at).getTime();
      const daysSinceSignup = signupAge / (1000 * 60 * 60 * 24);

      // Email 3: day 14+, email 1 and 2 already sent, email 3 not yet
      if (
        daysSinceSignup >= 14 &&
        p.activation_email_1_sent_at &&
        p.activation_email_2_sent_at &&
        !p.activation_email_3_sent_at
      ) {
        const email = buildEmail3(p);
        const sent = await sendEmail({ to: p.email, ...email });
        if (sent.ok) {
          await markEmailSent(p.id, 'activation_email_3_sent_at');
          results.activation.email3_sent++;
          console.log('[cron-activation-drip] Email 3 sent to', p.email);
        } else {
          results.errors.push(`Email 3 failed for ${p.email}`);
        }
        continue;
      }

      // Email 2: day 7+, email 1 already sent, email 2 not yet
      if (
        daysSinceSignup >= 7 &&
        p.activation_email_1_sent_at &&
        !p.activation_email_2_sent_at
      ) {
        const email = buildEmail2(p);
        const sent = await sendEmail({ to: p.email, ...email });
        if (sent.ok) {
          await markEmailSent(p.id, 'activation_email_2_sent_at');
          results.activation.email2_sent++;
          console.log('[cron-activation-drip] Email 2 sent to', p.email);
        } else {
          results.errors.push(`Email 2 failed for ${p.email}`);
        }
        continue;
      }

      // Email 1: day 4+, not yet sent
      if (
        daysSinceSignup >= 4 &&
        !p.activation_email_1_sent_at
      ) {
        const email = buildEmail1(p);
        const sent = await sendEmail({ to: p.email, ...email });
        if (sent.ok) {
          await markEmailSent(p.id, 'activation_email_1_sent_at');
          results.activation.email1_sent++;
          console.log('[cron-activation-drip] Email 1 sent to', p.email);
        } else {
          results.errors.push(`Email 1 failed for ${p.email}`);
        }
        continue;
      }

      // Not yet in a send window
      results.activation.skipped++;
    }
  }

  // -------------------------------------------------------------------------
  // System 2: Referral Ask
  // Members who HAVE uploaded a doc, signed up 14-21 days ago, no referral ask yet
  // -------------------------------------------------------------------------

  const windowStart = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const { ok: rOk, data: referralCandidates } = await supaJson(
    'profiles' +
    '?select=id,email,full_name,created_at,referral_ask_sent_at' +
    '&is_demo=eq.false' +
    '&plan=eq.founding' +
    '&referral_ask_sent_at=is.null' +
    '&created_at=gte.' + windowStart +
    '&created_at=lte.' + windowEnd +
    '&limit=200'
  );

  if (!rOk || !Array.isArray(referralCandidates)) {
    console.error('[cron-activation-drip] Failed to fetch referral candidates');
    results.errors.push('Failed to fetch referral candidates');
  } else {
    // Get those who have uploaded at least 1 document
    const candidateIds = referralCandidates.map(p => p.id);
    let activatedIds = new Set();

    if (candidateIds.length > 0) {
      const { ok: dOk, data: docs } = await supaJson(
        `documents?select=user_id&user_id=in.(${candidateIds.join(',')})&limit=500`
      );
      if (dOk && Array.isArray(docs)) {
        for (const d of docs) {
          activatedIds.add(d.user_id);
        }
      }
    }

    for (const p of referralCandidates) {
      results.referral.checked++;

      // Only send to activated members (at least 1 doc uploaded)
      if (!activatedIds.has(p.id)) {
        results.referral.skipped++;
        continue;
      }

      const email = buildReferralEmail(p);
      const sent = await sendEmail({ to: p.email, ...email });
      if (sent.ok) {
        await markEmailSent(p.id, 'referral_ask_sent_at');
        results.referral.sent++;
        console.log('[cron-activation-drip] Referral ask sent to', p.email);
      } else {
        results.errors.push(`Referral ask failed for ${p.email}`);
      }
    }
  }

  const totalSent =
    results.activation.email1_sent +
    results.activation.email2_sent +
    results.activation.email3_sent +
    results.referral.sent;

  console.log('[cron-activation-drip] Done. Total sent:', totalSent, '| Errors:', results.errors.length);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    total_sent: totalSent,
    results,
  });
};
