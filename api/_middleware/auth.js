// api/_middleware/auth.js
// Verifies a Supabase user JWT presented as a Bearer token.
//
// Usage (CJS):    const { verifySupabaseToken } = require('./_middleware/auth');
// Usage (ESM):    import { verifySupabaseToken } from './_middleware/auth.js';
//
// On success: returns { userId, email }.
// On failure: throws an Error with .status === 401 and a sanitized message.
// Callers should catch and respond with 401.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

function extractBearerToken(req) {
  const header =
    (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (typeof header !== 'string' || !header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token || null;
}

async function verifySupabaseToken(req) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Fail closed — auth must not be silently bypassed.
    throw new AuthError('Authentication is not configured.', 500);
  }

  const token = extractBearerToken(req);
  if (!token) {
    throw new AuthError('Missing or malformed Authorization header.');
  }

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    throw new AuthError('Authentication service unreachable.', 503);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError('Invalid or expired token.');
  }
  if (!response.ok) {
    throw new AuthError('Authentication service error.', 502);
  }

  let user;
  try {
    user = await response.json();
  } catch (e) {
    throw new AuthError('Authentication service returned invalid response.', 502);
  }

  if (!user || !user.id) {
    throw new AuthError('Token did not resolve to a user.');
  }

  return {
    userId: user.id,
    email: user.email || null,
  };
}

module.exports = { verifySupabaseToken, AuthError };
module.exports.verifySupabaseToken = verifySupabaseToken;
module.exports.AuthError = AuthError;
