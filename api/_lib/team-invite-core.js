// api/_lib/team-invite-core.js
//
// Shared invite logic — extracted from api/team/invite.js so the exact same
// code path serves two callers:
//   1. api/team/invite.js — the HTTP endpoint (self-serve "Add team member"
//      form in TeamView.jsx).
//   2. api/chat.js — Dossie's chat, when a team-lead account tells Dossie in
//      plain language to add a team member. Calling this directly
//      (service-role, in-process) avoids an HTTP round trip back into the
//      same Vercel deployment and keeps the admin-gate logic in one place.
//
// Both callers MUST already know the caller is trying to act as orgId's
// admin — this module re-checks _mt_user_is_org_admin itself as a hard
// backstop (cheap RPC call) rather than trusting the caller's own gate, the
// same defense-in-depth pattern as org-dossiers.js / team-risk-rollup.js.
//
// Hard seat cap (added 2026-08-23, Heath's direct ask): Team tops out at 8
// active agent-role seats (3 included + 5 purchasable at $79.99/seat,
// CLAUDE.md Section 5). Nothing enforced this anywhere before — an org could invite
// past 8 with no block. Blocks HERE, once, so both the "Add team member"
// form (api/team/invite.js) and Dossie's chat-driven add_team_member action
// (api/chat.js) get the same enforcement automatically — they both call
// this function, never invite_member_with_roles directly.
//
// Real Stripe billing sync (also 2026-08-23): after a successful invite that
// grants the 'agent' role, syncs the founder's real Stripe subscription's
// extra-seat line item quantity to match. Non-blocking — a Stripe failure
// here logs a warning but the invite itself has already succeeded and is
// not rolled back.

const Stripe = require('stripe');
const { getSeatCounts } = require('./team-seat-count');
const { syncTeamSeatBilling } = require('./team-seat-billing');

const VALID_ROLES = new Set(['agent', 'admin', 'tc']);
const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,}$/;

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase service-role client
 * @param {{orgId: string, email: string, roles: string[], callerId: string}} params
 * @returns {Promise<{ok:true, member_id:string, was_existing_user:boolean, invitee_user_id:string}
 *   | {ok:false, status:number, error:string}>}
 */
async function inviteTeamMember(supabase, { orgId, email, roles, callerId }) {
  const emailRaw = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const roleList = Array.isArray(roles) ? roles : [];

  if (!orgId || typeof orgId !== 'string') return { ok: false, status: 400, error: 'org_id required' };
  if (!emailRaw || !EMAIL_RE.test(emailRaw)) return { ok: false, status: 400, error: 'valid email required' };
  if (roleList.length === 0 || !roleList.every((r) => VALID_ROLES.has(r))) {
    return { ok: false, status: 400, error: 'roles must be a non-empty subset of agent/admin/tc' };
  }
  if (!callerId) return { ok: false, status: 401, error: 'callerId required' };

  const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
    p_user_id: callerId,
    p_org_id: orgId,
  });
  if (adminErr) {
    console.error('[team-invite-core] admin check error:', adminErr.message);
    return { ok: false, status: 500, error: 'authorization check failed' };
  }
  if (!isAdmin) return { ok: false, status: 403, error: 'not an admin on this org' };

  // Hard seat cap — only meaningful when this invite grants 'agent' (the
  // billed role). A pure admin or pure TC invite doesn't consume a paid
  // seat, so it's never blocked by this check.
  if (roleList.includes('agent')) {
    const counts = await getSeatCounts(supabase, orgId);
    if (!counts.ok) {
      console.error('[team-invite-core] seat count check failed:', counts.error);
      return { ok: false, status: 500, error: 'seat limit check failed' };
    }
    if (counts.at_or_over_limit) {
      return {
        ok: false,
        status: 400,
        error: `Your team is at its ${counts.max}-seat limit (${counts.included} included + ${counts.max - counts.included} extra at $${(counts.seat_price_cents / 100).toFixed(2)}/seat). Remove a member first, or email heath@meetdossie.com to raise the limit.`,
      };
    }
  }

  let inviteeUserId = null;
  let wasExisting = false;

  try {
    const { data: byEmail } = await supabase.auth.admin.getUserByEmail
      ? await supabase.auth.admin.getUserByEmail(emailRaw)
      : { data: null };
    if (byEmail && byEmail.user) {
      inviteeUserId = byEmail.user.id;
      wasExisting = true;
    }
  } catch (e) {
    // fall through to invite path
  }

  if (!inviteeUserId) {
    try {
      const { data: profileMatch } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', emailRaw)
        .maybeSingle();
      if (profileMatch && profileMatch.id) {
        inviteeUserId = profileMatch.id;
        wasExisting = true;
      }
    } catch (_) { /* profiles table may not have email column */ }
  }

  if (!inviteeUserId) {
    // 2026-08-23 fix (verified broken via real Playwright trace): this used
    // to redirect to `/app?invited_to_org=...`, but dossie-app.jsx's
    // Supabase client uses flowType:'pkce' + detectSessionInUrl:true, which
    // only consumes a `?code=` param — Supabase's invite link instead lands
    // with `#access_token=...&refresh_token=...&type=invite` in the URL
    // HASH (implicit-flow style), which the app never reads. A real invitee
    // landed on a bare "Sign In" screen with an inert, unusable token in the
    // URL and NO password ever set on the account — completely stuck.
    // set-password.html already exists and is the established pattern for
    // exactly this (api/signup.js, api/complete-onboarding.js,
    // forgot-password.html all use it): it manually parses the hash tokens,
    // calls setSession + updateUser({password}), then sends them to
    // /workspace.html with a real, working session. Reusing it here instead
    // of inventing a second path.
    const redirectTo = 'https://meetdossie.com/set-password.html';
    const { data: inviteResult, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(emailRaw, {
      redirectTo,
    });
    if (inviteErr) {
      console.error('[team-invite-core] inviteUserByEmail error:', inviteErr.message);
      return { ok: false, status: 400, error: inviteErr.message };
    }
    if (inviteResult && inviteResult.user) {
      inviteeUserId = inviteResult.user.id;
    }
  }

  if (!inviteeUserId) return { ok: false, status: 500, error: 'failed to resolve invitee user_id' };

  const { data: memberId, error: rpcErr } = await supabase.rpc('invite_member_with_roles', {
    p_org_id: orgId,
    p_invitee_user_id: inviteeUserId,
    p_roles: roleList,
    p_acting_user_id: callerId,
  });
  if (rpcErr) {
    console.error('[team-invite-core] invite_member_with_roles RPC error:', rpcErr.message);
    return { ok: false, status: 400, error: rpcErr.message };
  }

  // Real Stripe billing sync — non-blocking. The invite already succeeded
  // (member_id exists); a Stripe hiccup here must not undo it or fail the
  // caller's response, just log loudly so it's visible in Vercel logs.
  if (roleList.includes('agent')) {
    const stripe = getStripe();
    if (stripe) {
      try {
        const billingResult = await syncTeamSeatBilling(supabase, stripe, orgId);
        if (!billingResult.ok) {
          console.warn('[team-invite-core] seat billing sync failed after invite:', billingResult.error);
        } else if (billingResult.synced) {
          console.log('[team-invite-core] seat billing synced after invite: org=', orgId, 'quantity=', billingResult.quantity);
        }
      } catch (err) {
        console.warn('[team-invite-core] seat billing sync threw after invite:', err && err.message);
      }
    }
  }

  return { ok: true, member_id: memberId, was_existing_user: wasExisting, invitee_user_id: inviteeUserId };
}

module.exports = { inviteTeamMember, VALID_ROLES, EMAIL_RE };
