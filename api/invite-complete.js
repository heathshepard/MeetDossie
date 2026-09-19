'use strict';

// Vercel Serverless Function: POST /api/invite-complete
//
// Called by /set-password.html immediately after a successful password change,
// with the caller's own Supabase session JWT.
//
// WHY
//   A durable invite is a 30-day bearer credential sitting in an inbox. Once
//   the customer holds a real password, that token is no longer helping them
//   and is only a liability -- anyone who can read that mailbox later could
//   still walk into the account. So we retire every live invite for the user
//   the moment they no longer need one. Standard practice for password-reset
//   links; the durable window just makes it matter more.
//
// AUTHORITY
//   The Supabase JWT is the authority: a caller can only ever retire invites
//   for the user id inside their own verified token. The request body is
//   ignored entirely. There is no way to use this to lock someone else out.
//
// FAILURE IS NON-FATAL BY DESIGN
//   If this call fails, the customer still has their new password and is
//   already signed in. The client fires it and does not wait. Returning an
//   error here must never block anybody from reaching the app -- the entire
//   point of this work is that nothing in the sign-in path can strand a
//   paying customer.
//
// Sends no email.
//
// Owner: 2026-09-18.

const invites = require('./_lib/account-invites');
const { applyCorsHeaders } = require('./_middleware/cors');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

module.exports = async function handler(req, res) {
  const corsAllowed = applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const result = await invites.completeInvitesForUser(userId);
  return res.status(200).json({ ok: true, retired: !!result.ok, reason: result.reason || null });
};
