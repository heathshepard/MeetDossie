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
//
// SCHEDULE — the header comment here used to say "NOT in vercel.json". That was
// wrong and it sent a 2026-08-26 audit down the wrong path. This job IS live:
// vercel.json registers /api/cron-dispatch-daily-1500 at "0 15 * * *", and
// api/cron-dispatch-daily-1500.js fans out to this handler. IT SENDS REAL MAIL
// EVERY DAY. Read the SAFETY section below before changing any gate in here.
//
// From: heath@meetdossie.com (Resend)
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, RESEND_API_KEY
//
// ---------------------------------------------------------------------------
// SAFETY — READ BEFORE EDITING (2026-09-18)
// ---------------------------------------------------------------------------
// docs/ACTIVATION-FORENSICS-2026-09-18.md found that ten profiles had their
// activation_email_*_sent_at columns BACKFILLED by a single
// `UPDATE ... = now()` on 2026-06-05. Four of those customers never received
// any activation email at all; the stamps just made it look as though they had,
// and because this cron gates on those columns the sequence can never fire for
// them again.
//
// The obvious repair — "ignore the poisoned stamps" — would, on the very next
// 15:00 UTC run, mail five people who have been silent for four months an
// automated "have you added your first deal yet?" That is not an engineering
// decision. It is Heath's, and a personal note from him may well be the better
// move.
//
// So the repair ships INERT:
//
//   ACTIVATION_DRIP_BACKFILL_MODE unset or 'report'  (DEFAULT, and what is
//     deployed) — backfilled stamps are detected, counted and reported in the
//     response and the logs. They are still treated as "already sent", exactly
//     as today. NOBODY is emailed who would not have been emailed yesterday.
//
//   ACTIVATION_DRIP_BACKFILL_MODE = 'resume' — backfilled stamps are treated as
//     never-sent and those customers re-enter the sequence at the step they
//     actually reached. THIS IS THE SWITCH THAT MAILS REAL PEOPLE. Setting that
//     one environment variable in Vercel is the entire trigger; nothing else is
//     required and nothing else will do it.
//
// Second new gate, and it only ever REDUCES sending: a customer whose auth user
// has never held a session is skipped. Four of the five inactive customers could
// not log in at all, and mailing "the fastest way to get value from Dossie" to
// somebody with no working credential is the exact failure this file is meant to
// stop repeating. They are reported for an invite resend (api/invite-resend.js)
// instead.
// ---------------------------------------------------------------------------

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { isSuppressed } = require('./_lib/check-suppression.js');
const flagAudit = require('./_lib/activation-flag-audit.js');
const accountInvites = require('./_lib/account-invites.js');
const { listAllAuthUsers, indexAuthUsers } = require('./_lib/auth-users.js');

// 'report' (default, inert) | 'resume' (re-enters backfilled profiles — SENDS).
const BACKFILL_MODE = String(process.env.ACTIVATION_DRIP_BACKFILL_MODE || 'report').toLowerCase();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FROM_EMAIL = 'heath@meetdossie.com';
const APP_URL = 'https://meetdossie.com/app';
// Founding closed permanently 2026-08-04 (CLAUDE.md Section 5) — referrals now
// go to the live signup page at current Solo/Team pricing, never to /founding.
const SIGNUP_URL = 'https://meetdossie.com/signup';

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
//
// `new Date().toISOString()` is millisecond-precision, so every value this
// writes ends in three zero microseconds. That is not incidental — it is what
// lets api/_lib/activation-flag-audit.js tell a send from a raw-SQL backfill
// forever after. Do not switch this to a Postgres `now()` default or a
// server-side trigger without reading that file first; doing so would destroy
// the only signal that distinguishes the two.
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

// Record the send in BOTH places: the legacy profile column (so nothing that
// already reads it breaks) and the append-only ledger (the honest record, which
// carries the Resend message id as proof). From here on, a profile column with
// no matching ledger row is by construction a backfill.
async function recordSend({ profile, column, sequence, step, resendMessageId }) {
  await markEmailSent(profile.id, column);
  await accountInvites.logLifecycleEmail({
    userId: profile.id,
    email: profile.email,
    sequence,
    step,
    resendMessageId,
    source: 'cron-activation-drip',
  });
}

// ---------------------------------------------------------------------------
// Resend helper
// ---------------------------------------------------------------------------

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.error('[cron-activation-drip] RESEND_API_KEY not set — skipping email to', to);
    return { ok: false, error: 'RESEND_API_KEY not set' };
  }

  // Check CAN-SPAM suppression list before sending
  const suppressed = await isSuppressed(to, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (suppressed) {
    console.log('[cron-activation-drip] Skipping suppressed recipient:', to);
    return { ok: false, error: 'recipient_suppressed' };
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
      bcc: ['heath@meetdossie.com'],
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

// Founding pricing CLOSED PERMANENTLY 2026-08-04 (CLAUDE.md Section 5) — no new
// signups, ever. getFoundingRemainingCount() and the "spots left" pitch were
// removed 2026-08-16; the referral email now points friends at Solo pricing
// ($149/mo) via /signup instead of a dead founding offer.

function buildReferralEmail(profile) {
  const name = firstName(profile.full_name);
  return {
    subject: 'Know another agent who needs this?',
    html: `
<p>Hey ${name} --</p>

<p>You've been running deals through Dossie for a couple weeks now. If you know another agent who's still paying $400 a file or dealing with TC headaches, send them here: <a href="${SIGNUP_URL}">${SIGNUP_URL}</a></p>

<p>No referral program or commissions -- just thought you'd want to share if it's been helpful.</p>

<p>Thanks for being one of the first.</p>

<p>-- Heath</p>
    `.trim(),
  };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

module.exports = withTelemetry('cron-activation-drip', async function handler(req, res) {
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
    // Everything the backfill audit found, reported and never acted on unless
    // BACKFILL_MODE === 'resume'. This block is how Heath sees the size of the
    // problem without anything being mailed.
    backfill_audit: {
      mode: BACKFILL_MODE,
      profiles_with_backfilled_stamps: 0,
      fully_backfilled: 0,
      partially_backfilled: 0,
      suppressed_by_backfill: [],   // would have been emailed if mode were 'resume'
      resumed: 0,                   // only ever non-zero in 'resume' mode
    },
    // Customers who cannot log in at all. An activation nudge is the wrong tool
    // for these people; a working invite is. Reported, never emailed by this job.
    unreachable: { count: 0, users: [] },
    errors: [],
  };

  // -------------------------------------------------------------------------
  // System 1: Activation Drip
  // Members with no document uploaded, signed up 3+ days ago, active subscription
  // -------------------------------------------------------------------------

  // Fetch active founding subscriptions first — profiles.plan is not updated on
  // cancellation and cannot be trusted to filter paying customers.
  const { ok: subOk, data: activeSubs } = await supaJson(
    'subscriptions?select=user_id&status=eq.active&plan=eq.founding'
  );
  const activeUserIds = (subOk && Array.isArray(activeSubs))
    ? activeSubs.map((s) => s.user_id).filter(Boolean)
    : [];

  let inactiveProfiles = [];
  let aOk = false;

  if (activeUserIds.length > 0) {
    const idFilter = activeUserIds.map((id) => `"${id}"`).join(',');
    const res = await supaJson(
      'profiles' +
      '?select=id,email,full_name,created_at,activation_email_1_sent_at,activation_email_2_sent_at,activation_email_3_sent_at' +
      '&is_demo=eq.false' +
      '&id=in.(' + idFilter + ')' +
      '&created_at=lt.' + new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() +
      '&limit=200'
    );
    aOk = res.ok;
    inactiveProfiles = res.data || [];
  } else {
    aOk = true;
  }

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

    // The honest record of what was really sent, where one exists. A ledger row
    // beats a profile column; see api/_lib/activation-flag-audit.js.
    const ledger = await accountInvites.fetchLedgerSteps(userIds);

    // Who can actually log in. An error here must NOT be read as "nobody has
    // ever signed in" — that would make every customer look unreachable and
    // silence the whole sequence on an infrastructure blip. On failure we keep
    // an empty map and explicitly mark it untrusted, which means the
    // unreachable gate below is skipped rather than applied blindly.
    let authById = new Map();
    let authTrusted = false;
    try {
      authById = indexAuthUsers(await listAllAuthUsers());
      authTrusted = true;
    } catch (err) {
      console.error('[cron-activation-drip] auth user list failed — unreachable-customer gate disabled for this run:', err && err.message);
      results.errors.push(`auth_user_list_failed: ${err && err.message}`);
    }

    // Process each profile
    for (const p of inactiveProfiles) {
      results.activation.checked++;

      // Skip if they have uploaded a document — they're activated
      if (docUploaderIds.has(p.id)) {
        results.activation.skipped++;
        continue;
      }

      // ---------------------------------------------------------------------
      // Gate A — can this person even get in?
      //
      // Four of the five inactive founding members had never held a session.
      // Sending them "one thing takes 5 minutes: add one live deal" is worse
      // than sending nothing: it asks somebody locked out of the building to
      // rearrange the furniture. They need an invite, which is a different
      // job (api/invite-resend.js) and a decision for Heath.
      //
      // This gate only ever SUPPRESSES mail. It can never cause a send.
      // ---------------------------------------------------------------------
      if (authTrusted) {
        const au = authById.get(p.id);
        if (!au || au.neverSignedIn) {
          results.unreachable.count++;
          results.unreachable.users.push({
            user_id: p.id,
            never_signed_in: true,
            never_set_password: au ? au.neverSetPassword : null,
            recovery_sent_at: au ? au.recoverySentAt : null,
          });
          results.activation.skipped++;
          console.log('[cron-activation-drip] skipping unreachable account (no session ever):', p.id);
          continue;
        }
      }

      // ---------------------------------------------------------------------
      // Gate B — is this profile's send history trustworthy?
      //
      // `stepSent(column, key)` replaces the old bare `p.column` truthiness
      // check. It answers "do we have REAL evidence this step went out?" using
      // the ledger first and the millisecond test on the column second.
      //
      // In the default 'report' mode a backfilled stamp still counts as sent,
      // so the gating below is byte-for-byte the behavior that is live today.
      // Only 'resume' changes who gets mail.
      // ---------------------------------------------------------------------
      const audit = flagAudit.classifyProfile(p);
      if (audit.anyBackfilled) {
        results.backfill_audit.profiles_with_backfilled_stamps++;
        if (audit.verdict === 'fully_backfilled') results.backfill_audit.fully_backfilled++;
        else results.backfill_audit.partially_backfilled++;
      }

      const ledgerSteps = ledger.get(p.id);
      const stepSent = (column, ledgerKey) => {
        if (BACKFILL_MODE !== 'resume') {
          // Inert mode: any non-null stamp suppresses, exactly as today.
          return !!p[column];
        }
        return flagAudit.wasGenuinelySent(p, column, ledgerSteps, ledgerKey);
      };

      // For reporting only: under 'resume', would this profile become eligible
      // for a send it is currently being denied? Computed in BOTH modes so the
      // inert run tells Heath exactly what flipping the switch would do.
      if (audit.anyBackfilled && BACKFILL_MODE !== 'resume') {
        const wouldSend =
          !flagAudit.wasGenuinelySent(p, 'activation_email_1_sent_at', ledgerSteps, 'activation:email_1') ||
          !flagAudit.wasGenuinelySent(p, 'activation_email_2_sent_at', ledgerSteps, 'activation:email_2') ||
          !flagAudit.wasGenuinelySent(p, 'activation_email_3_sent_at', ledgerSteps, 'activation:email_3');
        if (wouldSend) {
          // user_id only — no name, no email address in the report payload.
          results.backfill_audit.suppressed_by_backfill.push({
            user_id: p.id,
            verdict: audit.verdict,
            duplicate_timestamps: audit.duplicateTimestamps,
          });
        }
      }
      if (audit.anyBackfilled && BACKFILL_MODE === 'resume') {
        results.backfill_audit.resumed++;
      }

      const signupAge = Date.now() - new Date(p.created_at).getTime();
      const daysSinceSignup = signupAge / (1000 * 60 * 60 * 24);

      // Email 3: day 14+, email 1 and 2 already sent, email 3 not yet
      if (
        daysSinceSignup >= 14 &&
        stepSent('activation_email_1_sent_at', 'activation:email_1') &&
        stepSent('activation_email_2_sent_at', 'activation:email_2') &&
        !stepSent('activation_email_3_sent_at', 'activation:email_3')
      ) {
        const email = buildEmail3(p);
        const sent = await sendEmail({ to: p.email, ...email });
        if (sent.ok) {
          await recordSend({ profile: p, column: 'activation_email_3_sent_at', sequence: 'activation', step: 'email_3', resendMessageId: sent.id });
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
        stepSent('activation_email_1_sent_at', 'activation:email_1') &&
        !stepSent('activation_email_2_sent_at', 'activation:email_2')
      ) {
        const email = buildEmail2(p);
        const sent = await sendEmail({ to: p.email, ...email });
        if (sent.ok) {
          await recordSend({ profile: p, column: 'activation_email_2_sent_at', sequence: 'activation', step: 'email_2', resendMessageId: sent.id });
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
        !stepSent('activation_email_1_sent_at', 'activation:email_1')
      ) {
        const email = buildEmail1(p);
        const sent = await sendEmail({ to: p.email, ...email });
        if (sent.ok) {
          await recordSend({ profile: p, column: 'activation_email_1_sent_at', sequence: 'activation', step: 'email_1', resendMessageId: sent.id });
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

  // Use the same activeUserIds fetched above for the referral candidates query.
  let referralCandidates = [];
  let rOk = false;

  if (activeUserIds.length > 0) {
    const idFilter = activeUserIds.map((id) => `"${id}"`).join(',');
    const res = await supaJson(
      'profiles' +
      '?select=id,email,full_name,created_at,referral_ask_sent_at' +
      '&is_demo=eq.false' +
      '&id=in.(' + idFilter + ')' +
      '&referral_ask_sent_at=is.null' +
      '&created_at=gte.' + windowStart +
      '&created_at=lte.' + windowEnd +
      '&limit=200'
    );
    rOk = res.ok;
    referralCandidates = res.data || [];
  } else {
    rOk = true;
  }

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
        await recordSend({ profile: p, column: 'referral_ask_sent_at', sequence: 'referral', step: 'referral_ask', resendMessageId: sent.id });
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

  // The audit's whole purpose is to be visible without being acted on. Say it
  // out loud every run so the number cannot quietly rot again.
  if (results.backfill_audit.profiles_with_backfilled_stamps > 0) {
    console.log(
      '[cron-activation-drip] BACKFILL AUDIT | mode=' + BACKFILL_MODE +
      ' | profiles with backfilled stamps: ' + results.backfill_audit.profiles_with_backfilled_stamps +
      ' | currently suppressed by them: ' + results.backfill_audit.suppressed_by_backfill.length +
      (BACKFILL_MODE === 'resume'
        ? ' | MODE=resume — these ARE being re-entered into the sequence.'
        : ' | mode=report — nothing sent to them. Set ACTIVATION_DRIP_BACKFILL_MODE=resume to change that.')
    );
  }
  if (results.unreachable.count > 0) {
    console.log(
      '[cron-activation-drip] ' + results.unreachable.count +
      ' paying customer(s) have never held a session — skipped. They need an invite (api/invite-resend.js), not a nudge.'
    );
  }

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    backfill_mode: BACKFILL_MODE,
    total_sent: totalSent,
    results,
  });
});
