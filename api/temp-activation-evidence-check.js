// TEMPORARY, READ-ONLY diagnostic — 2026-09-21.
//
// Built to answer one question Heath raised directly: did the 5 inactive
// paying customers (Kim Herrera, Cecilia Whitley, Lisa Nilsson, Terry Katz,
// Natalie Megerson) ever actually TRY to get in — a failed attempt, a clicked
// link, an opened email — or did they never come to the door at all? That
// distinguishes "broken door, real customers stuck outside" from "nobody home,
// the door doesn't matter."
//
// Reads only. Writes nothing. Emails nobody. Does not touch a password,
// profile, or subscription row. Auth: Bearer ${CRON_SECRET} only (no
// x-vercel-cron — this must never run on a schedule). Delete after use.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const TARGETS = [
  { name: 'Kim Herrera', email: 'kimberlyherrera@kw.com' },
  { name: 'Cecilia Whitley', email: 'cecilia@sterlingassociatesre.com' },
  { name: 'Lisa Nilsson', email: 'lisanilssontx@gmail.com' },
  { name: 'Terry Katz', email: 'michellesellshouston@gmail.com' },
  { name: 'Natalie Megerson', email: 'natalie@localchoicegroup.com' },
];

function supaHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: supaHeaders() });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function findAuthUserByEmail(email) {
  const res = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    { headers: supaHeaders() }
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
  return users.find((u) => String(u.email || '').toLowerCase() === email.toLowerCase()) || null;
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers.authorization || req.headers.Authorization || '');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const results = [];

  for (const t of TARGETS) {
    const entry = { name: t.name, email: t.email };

    // 1. auth.users admin fields — every timestamp GoTrue tracks that could
    // indicate an attempt: last_sign_in_at (success), recovery_sent_at
    // (a reset/invite link was MINTED — not proof of a click),
    // confirmation_sent_at, email_confirmed_at, updated_at (bumped by
    // updateUser, i.e. actually setting a password), created_at.
    let authUser = null;
    try {
      authUser = await findAuthUserByEmail(t.email);
    } catch (err) {
      entry.auth_error = err && err.message;
    }
    if (authUser) {
      entry.auth = {
        user_id: authUser.id,
        created_at: authUser.created_at,
        last_sign_in_at: authUser.last_sign_in_at || null,
        updated_at: authUser.updated_at,
        recovery_sent_at: authUser.recovery_sent_at || null,
        confirmation_sent_at: authUser.confirmation_sent_at || null,
        confirmed_at: authUser.confirmed_at || null,
        email_confirmed_at: authUser.email_confirmed_at || null,
        // A password WAS set if updated_at moved past recovery_sent_at/created_at.
        password_ever_set: authUser.updated_at
          && authUser.updated_at !== authUser.created_at
          && (!authUser.recovery_sent_at || new Date(authUser.updated_at) > new Date(authUser.recovery_sent_at) + 1000),
      };
    } else {
      entry.auth = null;
    }

    const userId = authUser && authUser.id;

    // 2. account_invites — the NEW durable-invite system (live since
    // 2026-09-18). consumed_at / redeem_count / last_redeemed_at is direct
    // proof of a click, independent of whether a session was ever completed.
    if (userId) {
      const inv = await supaGet(
        `account_invites?user_id=eq.${encodeURIComponent(userId)}&select=created_at,source,expires_at,consumed_at,redeem_count,last_redeemed_at,email_sent_at,completed_at&order=created_at.desc`
      );
      entry.account_invites = inv.ok ? inv.data : { error: inv.status, body: inv.data };
    } else {
      entry.account_invites = null;
    }

    // 3. lifecycle_email_log — genuine sends only (a row means Resend
    // accepted it; absence means nothing genuinely went out via this path).
    if (userId) {
      const lel = await supaGet(
        `lifecycle_email_log?user_id=eq.${encodeURIComponent(userId)}&select=sequence,step,sent_at,resend_message_id,source&order=sent_at.desc`
      );
      entry.lifecycle_email_log = lel.ok ? lel.data : { error: lel.status, body: lel.data };
    } else {
      entry.lifecycle_email_log = null;
    }

    // 4. email_events (Resend webhook ledger) — opens/clicks/bounces by
    // recipient address, independent of which system sent the mail.
    const ee = await supaGet(
      `email_events?recipient_email=eq.${encodeURIComponent(t.email)}&select=event_type,event_ts,url_clicked&order=event_ts.desc&limit=500`
    );
    if (ee.ok && Array.isArray(ee.data)) {
      const counts = {};
      for (const row of ee.data) counts[row.event_type] = (counts[row.event_type] || 0) + 1;
      entry.email_events_summary = counts;
      entry.email_events_clicks = ee.data.filter((r) => r.event_type === 'clicked');
      entry.email_events_most_recent = ee.data[0] || null;
    } else {
      entry.email_events_summary = { error: ee.status, body: ee.data };
    }

    results.push(entry);
  }

  return res.status(200).json({ ok: true, ran_at: new Date().toISOString(), results });
};
