// Vercel Serverless Function: /api/cron-pierce-activation
// Pierce's daily activation check — surfaces inactive founding members to Heath via Telegram.
// Does NOT email customers. Telegram alert only. Email follow-up is a separate build.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1 header
//
// REGISTERED 2026-09-18 via api/cron-dispatch-daily-1300.js, which vercel.json
// carries at "0 13 * * *" — the file's own documented schedule, unchanged. It
// had never been registered anywhere at all: the comment here claimed an
// external cron-job.org trigger that does not exist, so for months nothing
// invoked it. There was no alarm while five of eight paying customers sat
// unable to log in. See docs/ACTIVATION-FORENSICS-2026-09-18.md.
//
// Logic:
//   1. Pull all non-demo profiles + active subscriptions
//   2. Pull last_sign_in_at from the auth admin API (ALL pages — see below)
//   3. Split into NEVER LOGGED IN (an access defect) vs LAPSED (disengagement)
//   4. Telegram Heath, but only when the picture has actually changed
//   5. Log event to ventures_activity_events
//
// ---------------------------------------------------------------------------
// WHY THIS JOB NEEDED FIXING BEFORE IT COULD BE WIRED UP
//
// An alarm that fires wrongly is worse than no alarm, and this one had three
// ways to fire wrongly. All three are fixed here.
//
//   1. IT TREATED ITS OWN OUTAGE AS A FINDING. The auth admin fetch was
//      wrapped in a try/catch that logged a warning and continued with an
//      EMPTY user list. Since "absent from the map" is how the job decides
//      somebody never logged in, one failed request produced a confident
//      message telling Heath that every paying customer had never signed in.
//      It now aborts with an explicit error instead of inventing a crisis.
//
//   2. IT READ ONE PAGE AND ASSUMED IT WAS EVERYTHING. `per_page=200` returns
//      a single page; every user past it looked like "never logged in". Now
//      paged to exhaustion via api/_lib/auth-users.js.
//
//   3. IT WOULD HAVE SAID THE SAME THING EVERY DAY FOREVER. The five affected
//      customers have been inactive for four months. A daily identical list is
//      how an alarm gets muted, and a muted alarm is the state we are trying
//      to get out of. It now speaks when the SET changes, plus a weekly
//      Monday heartbeat so silence still means something.
//
// This job has never sent a customer anything and still doesn't. Telegram to
// Heath only.
// ---------------------------------------------------------------------------

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
require('./_lib/telegram-gate').install('cron-pierce-activation');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { listAllAuthUsers, indexAuthUsers } = require('./_lib/auth-users.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

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
    console.error('[cron-pierce-activation] Telegram failed:', res.status, body.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true };
}

// The set of inactive members, as a stable string. Used to decide whether
// anything has actually changed since the last run — see shouldNotify.
function fingerprint(members) {
  return members.map((m) => `${m.userId}:${m.neverLoggedIn ? 'never' : m.daysSince}`).sort().join('|');
}

// The previous run's fingerprint, from the activity log. Returns null when we
// cannot tell (table missing, first run, insert previously failed) — and the
// caller must then NOTIFY, because "I don't know if this changed" has to
// resolve toward speaking up, not toward silence.
async function lastFingerprint() {
  try {
    const { ok, data } = await supaJson(
      'ventures_activity_events?agent_name=eq.pierce&event_type=eq.activation_check' +
      '&select=metadata&order=created_at.desc&limit=1'
    );
    if (!ok || !Array.isArray(data) || data.length === 0) return null;
    const fp = data[0] && data[0].metadata && data[0].metadata.fingerprint;
    return typeof fp === 'string' ? fp : null;
  } catch (err) {
    console.warn('[cron-pierce-activation] lastFingerprint failed:', err.message);
    return null;
  }
}

async function logActivityEvent(summary, inactiveCount, extraMetadata) {
  try {
    const { ok, status, data } = await supaJson('ventures_activity_events', {
      method: 'POST',
      body: JSON.stringify({
        agent_name: 'pierce',
        event_type: 'activation_check',
        summary,
        metadata: { inactive_count: inactiveCount, ...(extraMetadata || {}) },
      }),
    });
    if (!ok) {
      console.warn('[cron-pierce-activation] ventures_activity_events insert failed:', status, JSON.stringify(data));
    }
  } catch (err) {
    // Non-fatal — table may not exist yet. Log and continue.
    console.warn('[cron-pierce-activation] activity event log threw:', err.message);
  }
}

module.exports = withTelemetry('cron-pierce-activation', async function handler(req, res) {
  // Auth: Vercel built-in cron header OR manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers.authorization || req.headers.Authorization || '');
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Get all non-demo profiles
    const { ok: pOk, data: profiles } = await supaJson(
      'profiles?select=id,email,full_name,is_demo,created_at&is_demo=eq.false&limit=200'
    );
    if (!pOk || !Array.isArray(profiles)) {
      console.error('[cron-pierce-activation] profiles fetch failed');
      return res.status(500).json({ ok: false, error: 'Failed to fetch profiles' });
    }

    // 2. Get active subscriptions to isolate paying customers
    const { ok: sOk, data: subs } = await supaJson(
      'subscriptions?select=user_id,plan,status&status=eq.active&limit=200'
    );
    const activeSubUserIds = new Set(
      (sOk && Array.isArray(subs) ? subs : []).map(s => s.user_id)
    );

    // 3. Get last_sign_in_at from the auth admin API — ALL pages.
    //
    // A failure here is fatal to the run ON PURPOSE. The old code carried on
    // with an empty list, and an empty list means "nobody has ever logged in",
    // which this job would then report to Heath as a five-alarm fire caused by
    // nothing but a flaky fetch. Bail out loudly; say nothing rather than
    // something false.
    let authById;
    try {
      authById = indexAuthUsers(await listAllAuthUsers());
    } catch (err) {
      console.error('[cron-pierce-activation] auth user list failed — aborting rather than reporting a false all-clear or a false alarm:', err.message);
      return res.status(503).json({
        ok: false,
        error: 'auth_user_list_failed',
        message: err.message,
        note: 'No Telegram sent. An unknown sign-in picture is not a finding.',
      });
    }

    // 4. Build inactive list — paying members only
    const payingProfiles = profiles.filter(p => activeSubUserIds.has(p.id));
    const inactiveMembers = [];

    for (const p of payingProfiles) {
      const au = authById.get(p.id) || null;
      const lastSignIn = au ? au.lastSignInAt : null;
      const neverLoggedIn = !lastSignIn;
      const inactiveTooLong = lastSignIn && new Date(lastSignIn) < new Date(sevenDaysAgo);

      if (neverLoggedIn || inactiveTooLong) {
        const daysSince = lastSignIn
          ? Math.floor((Date.now() - new Date(lastSignIn).getTime()) / (1000 * 60 * 60 * 24))
          : null;
        inactiveMembers.push({
          userId: p.id,
          name: p.full_name || p.email || 'Unknown',
          email: p.email || '',
          lastSignIn,
          daysSince,
          neverLoggedIn,
          // The distinction that matters. "Never logged in" is an ACCESS
          // failure we caused; "lapsed" is a product/engagement question. They
          // call for completely different responses and lumping them together
          // is how the original problem stayed invisible for four months.
          neverSetPassword: au ? au.neverSetPassword : null,
        });
      }
    }

    const neverIn = inactiveMembers.filter((m) => m.neverLoggedIn);
    const lapsed = inactiveMembers.filter((m) => !m.neverLoggedIn);
    const inactiveCount = inactiveMembers.length;
    const totalPaying = payingProfiles.length;

    // 5. Build Telegram message
    let message;
    if (inactiveCount === 0) {
      message = `Pierce - activation check\nAll ${totalPaying} paying members signed in within the last 7 days. No action needed.`;
    } else {
      const lines = [`Pierce - activation check\n${inactiveCount} of ${totalPaying} paying members inactive:\n`];
      if (neverIn.length > 0) {
        lines.push(`NEVER SIGNED IN (${neverIn.length}) - these are locked out, not disengaged:`);
        for (const m of neverIn) {
          const pw = m.neverSetPassword ? ', never set a password' : '';
          lines.push(`- ${m.name} (${m.email})${pw}`);
        }
        lines.push('Fix: POST /api/invite-resend {"email":"..."} with deliver=none to get a link you can send personally.');
        lines.push('');
      }
      if (lapsed.length > 0) {
        lines.push(`LAPSED >7d (${lapsed.length}):`);
        for (const m of lapsed) {
          lines.push(`- ${m.name} (${m.email}) - last login ${m.daysSince}d ago`);
        }
      }
      message = lines.join('\n');
    }

    console.log('[cron-pierce-activation] inactive:', inactiveCount, '/', totalPaying,
      '| never signed in:', neverIn.length, '| lapsed:', lapsed.length);

    // 6. Decide whether to speak.
    //
    // The same five names every morning for four months would train Heath to
    // ignore this message, which is the failure mode we are here to fix. Speak
    // when the picture CHANGES, on a Monday heartbeat, and whenever anyone is
    // locked out (that one is never routine). Otherwise stay quiet and leave
    // the detail in the JSON response and the activity log.
    const fp = fingerprint(inactiveMembers);
    const prevFp = await lastFingerprint();
    const isMonday = new Date().getUTCDay() === 1;
    const changed = prevFp === null || prevFp !== fp;
    const shouldNotify = changed || isMonday || neverIn.length > 0;

    let tgResult = { ok: false };
    if (shouldNotify) {
      const suffix = (!changed && !isMonday) ? '' : (changed ? '' : '\n(weekly heartbeat - unchanged since last report)');
      tgResult = await sendTelegram(message + suffix);
    } else {
      console.log('[cron-pierce-activation] unchanged since last run and not Monday — no Telegram sent.');
    }

    // 7. Log activity event to ventures_activity_events
    const summary = `${inactiveCount} of ${totalPaying} paying members inactive (${neverIn.length} never signed in, ${lapsed.length} lapsed >7d)`;
    await logActivityEvent(summary, inactiveCount, {
      fingerprint: fp,
      never_signed_in: neverIn.length,
      lapsed: lapsed.length,
      notified: shouldNotify,
    });

    return res.status(200).json({
      ok: true,
      ran_at: new Date().toISOString(),
      total_paying: totalPaying,
      inactive_count: inactiveCount,
      never_signed_in_count: neverIn.length,
      lapsed_count: lapsed.length,
      inactive_members: inactiveMembers,
      notified: shouldNotify,
      telegram_sent: tgResult.ok,
    });
  } catch (err) {
    console.error('[cron-pierce-activation] unhandled error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error', message: err.message });
  }
});
