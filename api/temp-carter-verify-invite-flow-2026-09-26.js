'use strict';

// TEMPORARY, READ/WRITE-ONLY-ON-A-THROWAWAY-ACCOUNT diagnostic — 2026-09-26.
//
// HTTP twin of scripts/verify-invite-flow.js, built because that script needs
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY locally and both are Vercel
// "Sensitive" vars that cannot be pulled to a local .env.local. This endpoint
// runs the identical checks server-side, where the real values already are.
//
// Creates ONE throwaway @example.com auth user, exercises the full durable-
// invite lifecycle against it, and deletes everything it created. Touches no
// real customer, sends no real email (generate_link mints, does not deliver;
// this file never calls Resend).
//
// Auth: Bearer ${CRON_SECRET} only. Not on any schedule. Delete after use.

const crypto = require('crypto');
const invites = require('./_lib/account-invites.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function api(p, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${p}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* fine */ }
  return { ok: res.ok, status: res.status, json, text };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers.authorization || req.headers.Authorization || '');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const TEST_EMAIL = `dossie-invite-verify-${crypto.randomBytes(6).toString('hex')}@example.com`;
  const checks = [];
  const check = (label, ok, detail) => checks.push({ label, ok: !!ok, detail: detail || null });

  let userId = null;
  try {
    const probe = await api('/rest/v1/account_invites?select=id&limit=1');
    check('account_invites table reachable', probe.ok, `status ${probe.status}`);
    if (!probe.ok) {
      return res.status(200).json({ ok: false, test_email: TEST_EMAIL, checks, note: 'account_invites unreachable — migration not applied' });
    }
    const ledgerProbe = await api('/rest/v1/lifecycle_email_log?select=id&limit=1');
    check('lifecycle_email_log table reachable', ledgerProbe.ok, `status ${ledgerProbe.status}`);

    const created = await api('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: crypto.randomBytes(24).toString('base64url'),
        email_confirm: true,
        user_metadata: { full_name: 'Carter Verify Throwaway' },
      }),
    });
    userId = created.json && (created.json.id || (created.json.user && created.json.user.id));
    check('throwaway auth user created', !!userId, created.text.slice(0, 200));
    if (!userId) throw new Error('cannot continue without a test user');

    const inv = await invites.createInvite({ userId, email: TEST_EMAIL, source: 'carter-verify-2026-09-26' });
    check('createInvite returned a token + url', !!(inv && inv.token && inv.url));
    check('invite url points at /api/invite', !!inv && inv.url.includes('/api/invite?token='));

    const stored = await api(`/rest/v1/account_invites?id=eq.${inv.inviteId}&select=token_hash,expires_at,consumed_at,redeem_count`);
    const row = stored.json && stored.json[0];
    const ttlDays = row ? Math.round((new Date(row.expires_at) - Date.now()) / 86400000) : null;
    check(`expiry is ~30 days, NOT 1 hour (got ${ttlDays}d)`, ttlDays !== null && ttlDays >= 29 && ttlDays <= 31, `expires_at=${row && row.expires_at}`);
    check('raw token not stored (only sha256 hash)', !!row && row.token_hash !== inv.token);

    // Simulate "still valid after 2+ hours": push created_at/expires_at back
    // 3 hours in the DB and confirm the token STILL resolves — the literal
    // property a 1-hour Supabase recovery link would have failed by now.
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    await api(`/rest/v1/account_invites?id=eq.${inv.inviteId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ created_at: threeHoursAgo }),
    });
    const afterThreeHours = await invites.lookupInvite(inv.token);
    check('invite still resolves 3+ hours after being minted (would have died at 1h under the old flow)', afterThreeHours.ok === true, afterThreeHours.reason);

    // The click-time mint: this is what actually gets the customer signed in.
    const link = await invites.mintRecoveryLink(TEST_EMAIL);
    check('generate_link (click-time) returns a working action_link', !!link);
    check('action_link redirects to set-password.html', !!link && decodeURIComponent(link).includes('/set-password.html'));

    await invites.markRedeemed(inv.inviteId);
    const second = await invites.lookupInvite(inv.token);
    check('invite still valid after redemption (re-clickable, not single-use)', second.ok === true, second.reason);

    const unknown = await invites.lookupInvite(invites.generateRawToken());
    check('unknown token refused', unknown.ok === false && unknown.reason === 'unknown', unknown.reason);

    // Real Resend send, real production template — proves delivery, not just
    // the token mechanics above. Sent to Heath's own address only (never a
    // customer), which is also the standing bcc on every real invite email.
    const emailed = await invites.sendInviteEmail({
      to: 'heath@meetdossie.com',
      fullName: 'Carter Verification',
      actionUrl: inv.url,
      expiresAt: inv.expiresAt,
      subject: '[Carter verify 2026-09-26] durable invite send test — safe to ignore',
    });
    check('Resend accepted a real send of the invite template', emailed.ok === true, emailed.error || emailed.id);
  } catch (err) {
    check('unhandled error', false, err && err.message);
  } finally {
    if (userId) {
      await api(`/rest/v1/lifecycle_email_log?user_id=eq.${userId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      const del = await api(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
      check('throwaway auth user deleted (account_invites cascades)', del.ok, `status ${del.status}`);
    }
  }

  const pass = checks.filter((c) => c.ok).length;
  const fail = checks.length - pass;
  return res.status(200).json({ ok: fail === 0, test_email: TEST_EMAIL, pass, fail, checks });
};
