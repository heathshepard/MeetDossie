'use strict';

// api/cron-account-invite-autoresend.js
//
// WHY THIS EXISTS
//   docs/ACTIVATION-FORENSICS-2026-09-18.md: Kim Herrera, Cecilia Whitley and
//   Lisa Nilsson have ZERO auth sessions, ever — 100+ days after they paid.
//   api/_lib/account-invites.js + api/invite.js fixed the credential for every
//   NEW signup (a durable, 30-day, re-clickable invite instead of a one-shot
//   1-hour recovery link) — but that fix only runs at provisioning time. It
//   never reached back to re-issue anything for an account already stuck
//   before it shipped, and nothing proactively catches a FUTURE account that
//   goes unused either. This job is that missing step.
//
//   Verified against production 2026-09-26: Kim/Cecilia/Lisa still have zero
//   rows in account_invites and zero rows in lifecycle_email_log. The new
//   credential system exists and is correct, but nobody has ever actually
//   been re-issued one.
//
// LOGIC
//   1. Profiles with an active subscription, joined against auth.users.
//   2. Candidate = never held a session (indexAuthUsers().neverSignedIn), AND
//      it has been at least ACCOUNT_INVITE_AUTORESEND_HOURS (default 48) since
//      the last credential was sent to them (recovery_sent_at for anyone
//      provisioned on the old flow, else account created_at for anyone on the
//      new durable-invite flow, which does not touch recovery_sent_at until
//      the link is actually clicked — see api/invite.js).
//   3. Skip anyone already auto-resent — lifecycle_email_log
//      (sequence='invite_autoresend', step='autoresend') is the durable record
//      of that, so a re-run of this job, or a run under a different mode,
//      never sends a second one. Beyond one automatic nudge this is Heath's
//      call: cron-pierce-activation (0 13 * * *, same dispatcher group)
//      already surfaces anyone still stuck for personal outreach.
//   4. Reuses api/_lib/account-invites.js end to end — the exact same
//      createInvite + sendInviteEmail path every new paid signup goes
//      through. No new template, no new credential mechanism.
//
// SAFETY — INERT BY DEFAULT, SAME PATTERN AS cron-activation-drip's
// ACTIVATION_DRIP_BACKFILL_MODE
//   ACCOUNT_INVITE_AUTORESEND_MODE unset or 'report'  (DEFAULT, what deploys)
//     — candidates are counted and logged. NOBODY is emailed. This lets the
//     job ship and be observed for real before it can put a single message in
//     front of a customer who has been silent for months.
//   ACCOUNT_INVITE_AUTORESEND_MODE = 'send' — actually re-issues a durable
//     invite and emails it. Flipping this one Vercel env var is the entire
//     trigger, mirroring exactly how BACKFILL_MODE works.
//
// This job has never sent a customer anything as shipped. Nothing here
// touches a password, profile, or subscription row.
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron.
// Schedule: joins /api/cron-dispatch-daily-1300 ("0 13 * * *") — same cadence
// as cron-pierce-activation, which watches the same population.
//
// Owner: Carter, 2026-09-26.

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-account-invite-autoresend');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { logWall } = require('./_lib/wall-log.js');
const { listAllAuthUsers, indexAuthUsers } = require('./_lib/auth-users.js');
const accountInvites = require('./_lib/account-invites.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MODE = String(process.env.ACCOUNT_INVITE_AUTORESEND_MODE || 'report').toLowerCase();
const THRESHOLD_HOURS = Number(process.env.ACCOUNT_INVITE_AUTORESEND_HOURS || 48);
const LEDGER_SEQUENCE = 'invite_autoresend';
const LEDGER_STEP = 'autoresend';
const SELF_NAME = 'cron-account-invite-autoresend';

async function supaJson(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4090) }),
    });
  } catch (err) {
    console.error('[account-invite-autoresend] tg error:', err && err.message);
  }
}

module.exports = withTelemetry(SELF_NAME, async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const result = {
    mode: MODE,
    threshold_hours: THRESHOLD_HOURS,
    checked: 0,
    candidates: 0,
    sent: 0,
    already_resent: 0,
    skipped: 0,
    errors: [],
  };

  try {
    const { ok: subOk, data: subs } = await supaJson('subscriptions?select=user_id&status=eq.active');
    if (!subOk || !Array.isArray(subs)) throw new Error('subscriptions_fetch_failed');
    const payingIds = [...new Set(subs.map((s) => s.user_id).filter(Boolean))];
    if (payingIds.length === 0) {
      return res.status(200).json({ ok: true, ...result });
    }

    const idFilter = payingIds.map((id) => `"${id}"`).join(',');
    const { ok: pOk, data: profiles } = await supaJson(
      `profiles?select=id,email,full_name,created_at&is_demo=eq.false&id=in.(${idFilter})`
    );
    if (!pOk || !Array.isArray(profiles)) throw new Error('profiles_fetch_failed');

    // A failure here must NEVER be read as "everyone is locked out" — that is
    // the exact bug that used to make cron-pierce-activation lie. Abort loudly
    // instead of guessing.
    let authById;
    try {
      authById = indexAuthUsers(await listAllAuthUsers());
    } catch (err) {
      console.error('[account-invite-autoresend] auth user list failed — aborting rather than guessing:', err.message);
      return res.status(503).json({ ok: false, error: 'auth_user_list_failed', message: err.message });
    }

    // Who has already had ONE automatic re-issue, ever.
    const ledger = await accountInvites.fetchLedgerSteps(profiles.map((p) => p.id));
    const notified = [];

    for (const p of profiles) {
      result.checked++;

      const au = authById.get(p.id);
      if (!au || !au.neverSignedIn) { result.skipped++; continue; }

      const anchor = au.recoverySentAt || au.createdAt || p.created_at;
      const hoursSince = anchor ? (Date.now() - new Date(anchor).getTime()) / 3600000 : Infinity;
      if (!(hoursSince >= THRESHOLD_HOURS)) { result.skipped++; continue; }

      const steps = ledger.get(p.id);
      if (steps && steps.has(`${LEDGER_SEQUENCE}:${LEDGER_STEP}`)) {
        result.already_resent++;
        continue;
      }

      result.candidates++;
      if (MODE !== 'send') continue;

      try {
        const invite = await accountInvites.createInvite({ userId: p.id, email: p.email, source: 'auto-resend' });
        if (!invite) { result.errors.push(`${p.id}: invite_unavailable`); continue; }

        const sent = await accountInvites.sendInviteEmail({
          to: p.email,
          fullName: p.full_name,
          actionUrl: invite.url,
          expiresAt: invite.expiresAt,
          subject: "Still there? Here's your Dossie sign-in link",
        });
        if (!sent.ok) { result.errors.push(`${p.id}: ${sent.error || 'send_failed'}`); continue; }

        await accountInvites.markInviteEmailed(invite.inviteId, sent.id);
        await accountInvites.logLifecycleEmail({
          userId: p.id,
          email: p.email,
          sequence: LEDGER_SEQUENCE,
          step: LEDGER_STEP,
          resendMessageId: sent.id,
          source: SELF_NAME,
          metadata: { hours_since_anchor: Math.round(hoursSince) },
        });
        result.sent++;
        notified.push(p.email);
      } catch (err) {
        result.errors.push(`${p.id}: ${err.message}`);
      }
    }

    if (result.sent > 0) {
      await tg(
        `🔑 <b>ACCOUNT INVITE AUTO-RESEND</b>\n` +
        `Re-issued a 30-day sign-in link to ${result.sent} paying customer(s) who ` +
        `had never held a session and were past the ${THRESHOLD_HOURS}h window:\n` +
        notified.join('\n')
      );
      await logWall({
        wall_id: `WALL-ACCOUNT-AUTORESEND-${new Date().toISOString().slice(0, 10)}`,
        title: 'Account invite auto-resend fired',
        what_broke: 'N/A — proactive recovery, not an outage',
        detected_by: SELF_NAME,
        root_cause: 'Paying customer never held a session past the resend threshold',
        route_around: 'N/A',
        permanent_fix: 'Durable 30-day invite auto re-issued once per account via api/_lib/account-invites.js',
        resolved_by: SELF_NAME,
        reoccurrence_guard: 'lifecycle_email_log dedupe — one auto-resend per account, ever; cron-pierce-activation keeps watching after that',
        metadata: { sent: result.sent, candidates: result.candidates, mode: MODE },
      });
    } else if (result.candidates > 0) {
      console.log(`[account-invite-autoresend] ${MODE} mode: ${result.candidates} candidate(s)${MODE === 'send' ? '' : ' would be re-sent if MODE were "send"'}.`);
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[account-invite-autoresend] unhandled error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
