// Vercel Serverless Function: /api/cron-trial-conversion-watch
// Surfaces two free-trial failure modes to Heath via Telegram — never emails
// a customer. Same shape as cron-pierce-activation.js on purpose (Cole's
// instruction, free-trial rollout 2026-09-26): fingerprint + dedup so a
// static picture goes quiet, Monday heartbeat so silence still means
// something, and it aborts loudly rather than inventing a crisis if a
// dependency fetch fails.
//
// WHY THIS EXISTS
//   api/create-checkout-session.js's TRIAL_DAYS (default 14, card required)
//   means every new Solo/Team signup now spends up to two weeks as
//   subscriptions.status='trialing' before Stripe either converts them to
//   'active' or the trial ends without a working payment method and they
//   land on 'past_due'/'cancelled'. A trial that silently fails to convert is
//   invisible unless something specifically watches for it — this is that
//   watch. (feedback_silent-failure-is-the-enemy: every pipeline needs an
//   alarm built in the same change that ships it.)
//
// LOGIC
//   1. TRIAL ENDED WITHOUT CONVERTING: subscriptions where trial_end is in
//      the past and status is anything other than 'active' — covers the
//      normal "card declined at trial end" case (past_due/cancelled/unpaid)
//      AND the "should have converted days ago but Stripe status never
//      synced" case (still shows 'trialing' after trial_end has passed,
//      which would itself be a webhook bug worth knowing about).
//   2. TRIALING + ZERO SESSIONS AFTER 48H: subscriptions still 'trialing'
//      whose profile has never held an auth session, past
//      TRIAL_STUCK_HOURS (default 48). This is the trial-specific twin of
//      cron-account-invite-autoresend (which now also includes 'trialing' in
//      its own query, see 2026-09-26 comment there) — that job can actually
//      re-send a credential; this one is purely the "does Heath need to look
//      at this" signal, same population, same reason it matters (a locked-out
//      trial burns days of the 14 they paid attention for with nothing to
//      show for it).
//
// This job has never sent a customer anything and never will. Telegram to
// Heath only, same as cron-pierce-activation.

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-trial-conversion-watch');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { listAllAuthUsers, indexAuthUsers } = require('./_lib/auth-users.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';
const TRIAL_STUCK_HOURS = Number(process.env.TRIAL_STUCK_HOURS || 48);

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

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
  const body = await res.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = null; }
  if (!res.ok || data?.ok !== true) {
    console.error('[cron-trial-conversion-watch] Telegram failed:', res.status, body.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true };
}

function fingerprint(failedIds, stuckIds) {
  return `failed:${[...failedIds].sort().join(',')}|stuck:${[...stuckIds].sort().join(',')}`;
}

async function lastFingerprint() {
  try {
    const { ok, data } = await supaJson(
      'ventures_activity_events?agent_name=eq.pierce&event_type=eq.trial_conversion_check' +
      '&select=metadata&order=created_at.desc&limit=1'
    );
    if (!ok || !Array.isArray(data) || data.length === 0) return null;
    const fp = data[0] && data[0].metadata && data[0].metadata.fingerprint;
    return typeof fp === 'string' ? fp : null;
  } catch (err) {
    console.warn('[cron-trial-conversion-watch] lastFingerprint failed:', err.message);
    return null;
  }
}

async function logActivityEvent(summary, extraMetadata) {
  try {
    const { ok, status, data } = await supaJson('ventures_activity_events', {
      method: 'POST',
      body: JSON.stringify({
        agent_name: 'pierce',
        event_type: 'trial_conversion_check',
        summary,
        metadata: extraMetadata || {},
      }),
    });
    if (!ok) {
      console.warn('[cron-trial-conversion-watch] ventures_activity_events insert failed:', status, JSON.stringify(data));
    }
  } catch (err) {
    console.warn('[cron-trial-conversion-watch] activity event log threw:', err.message);
  }
}

module.exports = withTelemetry('cron-trial-conversion-watch', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers.authorization || req.headers.Authorization || '');
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const nowIso = new Date().toISOString();

    // 1. Trials that ended without landing on 'active'.
    const { ok: failedOk, data: failedRows } = await supaJson(
      `subscriptions?select=user_id,plan,status,trial_end&trial_end=lt.${encodeURIComponent(nowIso)}&status=neq.active&limit=200`
    );
    if (!failedOk || !Array.isArray(failedRows)) {
      console.error('[cron-trial-conversion-watch] failed-trials fetch failed');
      return res.status(500).json({ ok: false, error: 'Failed to fetch trial-ended subscriptions' });
    }

    // 2. Still-trialing subscriptions, checked against auth sessions for the
    // zero-login-after-48h case.
    const { ok: trialingOk, data: trialingRows } = await supaJson(
      'subscriptions?select=user_id,plan,status,trial_start&status=eq.trialing&limit=200'
    );
    if (!trialingOk || !Array.isArray(trialingRows)) {
      console.error('[cron-trial-conversion-watch] trialing fetch failed');
      return res.status(500).json({ ok: false, error: 'Failed to fetch trialing subscriptions' });
    }

    const allUserIds = [...new Set([
      ...failedRows.map((r) => r.user_id),
      ...trialingRows.map((r) => r.user_id),
    ].filter(Boolean))];

    let authById;
    try {
      authById = indexAuthUsers(await listAllAuthUsers());
    } catch (err) {
      console.error('[cron-trial-conversion-watch] auth user list failed — aborting rather than reporting a false all-clear or a false alarm:', err.message);
      return res.status(503).json({
        ok: false,
        error: 'auth_user_list_failed',
        message: err.message,
        note: 'No Telegram sent. An unknown sign-in picture is not a finding.',
      });
    }

    let profilesById = new Map();
    if (allUserIds.length > 0) {
      const idFilter = allUserIds.map((id) => `"${id}"`).join(',');
      const { ok: pOk, data: profiles } = await supaJson(`profiles?select=id,email,full_name&id=in.(${idFilter})`);
      if (pOk && Array.isArray(profiles)) {
        profilesById = new Map(profiles.map((p) => [p.id, p]));
      }
    }

    const failedTrials = failedRows.map((r) => {
      const p = profilesById.get(r.user_id) || {};
      return {
        userId: r.user_id,
        name: p.full_name || p.email || 'Unknown',
        email: p.email || '',
        plan: r.plan,
        status: r.status,
        trialEnd: r.trial_end,
      };
    });

    const stuckThresholdMs = TRIAL_STUCK_HOURS * 60 * 60 * 1000;
    const stuckTrials = [];
    for (const r of trialingRows) {
      const au = authById.get(r.user_id) || null;
      const neverSignedIn = !au || !au.lastSignInAt;
      if (!neverSignedIn) continue;
      const trialStartMs = r.trial_start ? new Date(r.trial_start).getTime() : null;
      if (!trialStartMs || (Date.now() - trialStartMs) < stuckThresholdMs) continue;
      const p = profilesById.get(r.user_id) || {};
      stuckTrials.push({
        userId: r.user_id,
        name: p.full_name || p.email || 'Unknown',
        email: p.email || '',
        plan: r.plan,
        hoursSinceTrialStart: Math.floor((Date.now() - trialStartMs) / (60 * 60 * 1000)),
      });
    }

    let message;
    if (failedTrials.length === 0 && stuckTrials.length === 0) {
      message = 'Trial conversion watch\nAll trials on track — no failed conversions, nobody stuck without a login.';
    } else {
      const lines = ['Trial conversion watch\n'];
      if (failedTrials.length > 0) {
        lines.push(`TRIAL ENDED WITHOUT CONVERTING (${failedTrials.length}):`);
        for (const t of failedTrials) {
          lines.push(`- ${t.name} (${t.email}) - ${t.plan}, now ${t.status}, trial ended ${t.trialEnd}`);
        }
        lines.push('');
      }
      if (stuckTrials.length > 0) {
        lines.push(`TRIALING, NEVER SIGNED IN, >${TRIAL_STUCK_HOURS}h (${stuckTrials.length}):`);
        for (const t of stuckTrials) {
          lines.push(`- ${t.name} (${t.email}) - ${t.plan}, ${t.hoursSinceTrialStart}h into trial with zero sessions`);
        }
        lines.push('Fix: POST /api/invite-resend {"email":"..."} with deliver=none to get a link you can send personally.');
      }
      message = lines.join('\n');
    }

    console.log('[cron-trial-conversion-watch] failed:', failedTrials.length, '| stuck:', stuckTrials.length);

    const failedIds = new Set(failedTrials.map((t) => t.userId));
    const stuckIds = new Set(stuckTrials.map((t) => t.userId));
    const fp = fingerprint(failedIds, stuckIds);
    const prevFp = await lastFingerprint();
    const isMonday = new Date().getUTCDay() === 1;
    const changed = prevFp === null || prevFp !== fp;
    const shouldNotify = changed || isMonday || failedTrials.length > 0;

    let tgResult = { ok: false };
    if (shouldNotify) {
      const suffix = (changed || failedTrials.length > 0) ? '' : '\n(weekly heartbeat - unchanged since last report)';
      tgResult = await sendTelegram(message + suffix);
    } else {
      console.log('[cron-trial-conversion-watch] unchanged since last run and not Monday — no Telegram sent.');
    }

    const summary = `${failedTrials.length} trial(s) ended without converting, ${stuckTrials.length} trialing with zero sessions >${TRIAL_STUCK_HOURS}h`;
    await logActivityEvent(summary, {
      fingerprint: fp,
      failed_count: failedTrials.length,
      stuck_count: stuckTrials.length,
      notified: shouldNotify,
    });

    return res.status(200).json({
      ok: true,
      ran_at: new Date().toISOString(),
      failed_trials: failedTrials,
      stuck_trials: stuckTrials,
      notified: shouldNotify,
      telegram_sent: tgResult.ok,
    });
  } catch (err) {
    console.error('[cron-trial-conversion-watch] unhandled error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error', message: err.message });
  }
});
