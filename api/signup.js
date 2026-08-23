// Vercel Serverless Function: /api/signup
//
// The front door. Until now there wasn't one: /signup 404'd and /founding
// 308-redirected to /app (the login screen), which offered no way to create an
// account. Every account had to be provisioned by hand.
//
// Two paths, one endpoint:
//
//   1. INVITE CODE — a design partner enters the code Heath gave them. The
//      account is created immediately, comped (no card, no Stripe), and a
//      set-password email goes out. They can sign in the same minute.
//
//   2. REQUEST ACCESS — no code. Writes a `founding_applications` row with
//      status 'pending' and pings Heath on Telegram, reusing the approve/reject
//      flow that already exists (api/admin-approve-founding.js). Nobody gets an
//      account without Heath saying yes.
//
// Paid self-serve checkout lives on signup.html itself (added 2026-08-22), not
// in this endpoint — the Solo/Team plan buttons POST straight to
// /api/create-checkout-session and redirect to Stripe. This endpoint still
// only handles the two free/comped paths below. See api/_lib/pricing-tiers.js
// for the live Solo/Team price IDs.
//
// POST { name, email, phone, city, trec_license, deals, heard_from,
//        brokerage?, access_code? }
//   -> { ok: true, mode: 'provisioned', password_email_sent: bool }
//   -> { ok: true, mode: 'application_received' }
//
// Environment:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — provisioning (server-side only)
//   DOSSIE_PARTNER_INVITE_CODE              — comp'd design-partner invite code
//   DOSSIE_PARTNER_COMP_MONTHS              — optional, default 12
//   RESEND_API_KEY                          — set-password + welcome email
//   TELEGRAM_MARKETING_BOT_TOKEN / TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

const { applyCorsHeaders } = require('./_middleware/cors');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_COMP_MONTHS = 12;
const SET_PASSWORD_REDIRECT = 'https://meetdossie.com/set-password.html';

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_BLUSH_DEEP = '#D4A0A0';
const BRAND_MUTED = '#9CA8B4';

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type' });
}

function clean(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

function toTitleCase(value) {
  const t = clean(value, 120);
  if (!t) return '';
  return t.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// Constant-time-ish comparison so the endpoint doesn't leak the code length or
// prefix through response timing.
function codeMatches(supplied, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  try {
    return require('crypto').timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function supabaseFetch(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Supabase ${init.method || 'GET'} ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function findAuthUserIdByEmail(email) {
  try {
    const data = await supabaseFetch(`/auth/v1/admin/users?email=${encodeURIComponent(email)}`);
    const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
    const match = users.find((u) => String(u.email || '').toLowerCase() === email);
    return match ? match.id : null;
  } catch (err) {
    console.warn('[signup] findAuthUserIdByEmail failed:', err && err.message);
    return null;
  }
}

async function createAuthUser(email, fullName) {
  // Random unusable password — the user sets a real one via the recovery link.
  const scratch = require('crypto').randomBytes(36).toString('base64').replace(/[+/=]/g, '').slice(0, 48);
  try {
    const data = await supabaseFetch('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: scratch,
        email_confirm: true,
        user_metadata: { full_name: fullName || '' },
      }),
    });
    const id = data?.id || data?.user?.id || null;
    if (id) return { userId: id, existed: false };
    throw new Error('auth user create returned no id');
  } catch (err) {
    const body = String(err.body || err.message || '').toLowerCase();
    if (err.status === 422 || /already|registered|exists/.test(body)) {
      const existing = await findAuthUserIdByEmail(email);
      if (existing) return { userId: existing, existed: true };
    }
    throw err;
  }
}

async function generateRecoveryLink(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'recovery', email, redirect_to: SET_PASSWORD_REDIRECT }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    console.error('[signup] generate_link non-OK', res.status, text.slice(0, 300));
    return null;
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { return null; }
  return data?.action_link || data?.properties?.action_link || null;
}

function setPasswordEmailHtml(actionLink, firstName) {
  const name = (firstName || '').trim().split(' ')[0] || 'there';
  return `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 48px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-size: 12px; letter-spacing: 2px; color: #A48531; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE</div>
  <h1 style="font-family: Georgia, serif; font-size: 34px; line-height: 1.15; margin: 0 0 16px; color: ${BRAND_NAVY};">${name}, you're in.</h1>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 24px;">Your Dossie account is ready. Set a password and you can start dropping contracts in right away.</p>
  <a href="${actionLink}" style="display: inline-block; padding: 16px 32px; background: ${BRAND_BLUSH_DEEP}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px;">Set Your Password</a>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 28px 0 0;">Once you're in: open any deal you're working — even a closed one — and drop the contract in. She reads it, pulls every TREC deadline with the paragraph it came from, and lays your file out in order.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 18px 0 0;">Reply to this email any time. I read every one.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 18px 0 4px;">Heath</p>
  <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.6; margin: 0;">heath@meetdossie.com<br>Licensed Texas REALTOR | Founder, Dossie</p>
  <p style="margin-top: 32px; font-size: 13px; color: ${BRAND_MUTED}; line-height: 1.6;">This link expires in 1 hour. If it's expired, use "Forgot password?" at meetdossie.com/app or email heath@meetdossie.com.</p>
</div>`;
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[signup] RESEND_API_KEY not set — cannot email', to);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Dossie <dossie@meetdossie.com>',
        to: [to],
        subject,
        html,
        bcc: ['heath@meetdossie.com'],
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error('[signup] Resend failed', res.status, t.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[signup] Resend threw:', err && err.message);
    return false;
  }
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[signup] Telegram not configured — skipping notification');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (err) {
    console.error('[signup] Telegram threw:', err && err.message);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Path 1 — invite code: provision a comped account immediately.
// ---------------------------------------------------------------------------
async function provisionCompedAccount(d) {
  const { userId, existed } = await createAuthUser(d.email, d.name);
  if (!userId) throw new Error('Could not create the account.');

  if (existed) {
    // Do not silently re-provision or overwrite an existing member's profile.
    return { alreadyExisted: true, userId };
  }

  const months = Number(process.env.DOSSIE_PARTNER_COMP_MONTHS) || DEFAULT_COMP_MONTHS;
  const compEnd = new Date();
  compEnd.setMonth(compEnd.getMonth() + months);

  await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      id: userId,
      email: d.email,
      full_name: d.name,
      phone: d.phone || null,
      brokerage: d.brokerage || null,
      market: d.city || null,
      license_number: d.trec_license || null,
      heard_from: d.heard_from || 'design_partner_invite',
      // 'design_partner' keeps these accounts out of every founding calculation
      // (api/founding-count.js filters plan=eq.founding) while still reading as
      // a real, active account everywhere access is checked.
      plan: 'design_partner',
      subscription_tier: 'design_partner',
      subscription_status: 'active',
    }),
  });

  // Subscription row so the customer crons (morning brief, deadline reminders)
  // pick them up. plan='design_partner' means no MRR calculation counts it.
  try {
    await supabaseFetch('/rest/v1/subscriptions', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId,
        plan: 'design_partner',
        status: 'active',
        current_period_start: new Date().toISOString(),
        current_period_end: compEnd.toISOString(),
      }),
    });
  } catch (err) {
    // Non-fatal: the account works without it, they just miss the daily brief.
    console.error('[signup] subscription row insert failed (non-fatal):', err && err.message);
  }

  return { alreadyExisted: false, userId, compEndsAt: compEnd.toISOString() };
}

// ---------------------------------------------------------------------------
// Path 2 — no code: record an access request for Heath to approve.
// ---------------------------------------------------------------------------
async function recordAccessRequest(d) {
  await supabaseFetch('/rest/v1/founding_applications', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      name: d.name,
      email: d.email,
      phone: d.phone || null,
      city: d.city || null,
      market: d.city || null,
      brokerage: d.brokerage || null,
      trec_license: d.trec_license || null,
      transactions_12mo: Number.isFinite(Number(d.deals)) ? Number(d.deals) : 0,
      heard_from: d.heard_from || null,
      status: 'pending',
    }),
  });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[signup] Supabase not configured.');
    return res.status(500).json({ ok: false, error: 'Signup is not configured. Email heath@meetdossie.com.' });
  }

  try {
    // Brute-force guard on the invite code: 10 attempts per IP per hour.
    await checkRateLimit(clientIpFromReq(req), 'signup', 10, 60 * 60 * 1000);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const d = {
      name: toTitleCase(body.name),
      email: clean(body.email, 200).toLowerCase(),
      phone: clean(body.phone, 40),
      city: clean(body.city || body.market, 120),
      brokerage: clean(body.brokerage, 160),
      trec_license: clean(body.trec_license, 40),
      deals: clean(body.deals || body.transactions_12mo, 10),
      heard_from: clean(body.heard_from, 60),
    };
    const accessCode = clean(body.access_code, 100);

    if (!d.name) return res.status(400).json({ ok: false, error: 'Name is required.', field: 'name' });
    if (!EMAIL_RE.test(d.email)) return res.status(400).json({ ok: false, error: 'A valid email is required.', field: 'email' });
    if (!d.phone) return res.status(400).json({ ok: false, error: 'Phone is required.', field: 'phone' });
    if (!d.city) return res.status(400).json({ ok: false, error: 'City is required.', field: 'city' });

    const inviteCode = process.env.DOSSIE_PARTNER_INVITE_CODE;

    // ---- Path 1: valid invite code -> provision now ----
    if (accessCode) {
      if (!codeMatches(accessCode, inviteCode)) {
        return res.status(400).json({
          ok: false,
          error: "That invite code isn't valid. Leave it blank to request access instead.",
          field: 'access_code',
        });
      }

      const result = await provisionCompedAccount(d);

      if (result.alreadyExisted) {
        return res.status(200).json({
          ok: true,
          mode: 'already_registered',
          message: 'You already have a Dossie account with that email. Use "Forgot password?" on the sign-in page to get back in.',
        });
      }

      // The set-password link is the ONLY way into a comped account — there is
      // no password to guess. If it doesn't send, say so plainly instead of
      // returning a cheerful success the person can't act on.
      let passwordEmailSent = false;
      const actionLink = await generateRecoveryLink(d.email);
      if (actionLink) {
        passwordEmailSent = await sendEmail({
          to: d.email,
          subject: "You're in — set your Dossie password",
          html: setPasswordEmailHtml(actionLink, d.name),
        });
      } else {
        console.error('[signup] no action_link generated for', d.email);
      }

      await telegram(
        `✅ <b>DESIGN PARTNER PROVISIONED</b> (invite code)\n\n` +
        `<b>Name:</b> ${esc(d.name)}\n<b>Email:</b> ${esc(d.email)}\n` +
        `<b>Phone:</b> ${esc(d.phone)}\n<b>City:</b> ${esc(d.city)}\n` +
        `<b>Brokerage:</b> ${esc(d.brokerage || '—')}\n` +
        `<b>Comped until:</b> ${esc(String(result.compEndsAt || '').slice(0, 10))}\n\n` +
        (passwordEmailSent
          ? '<i>Set-password email sent. No card, no Stripe.</i>'
          : '🚨 <b>SET-PASSWORD EMAIL DID NOT SEND — they cannot sign in. Send them a link manually.</b>'),
      );

      if (!passwordEmailSent) {
        return res.status(500).json({
          ok: false,
          mode: 'provisioned',
          account_created: true,
          password_email_sent: false,
          error: "Your account was created, but we couldn't send the password email. Email heath@meetdossie.com and he'll send your link right away.",
        });
      }

      return res.status(200).json({
        ok: true,
        mode: 'provisioned',
        password_email_sent: true,
        message: "You're in. Check your email for a link to set your password.",
      });
    }

    // ---- Path 2: no code -> access request for Heath to approve ----
    await recordAccessRequest(d);

    await telegram(
      `📝 <b>NEW ACCESS REQUEST</b> (/signup, no invite code)\n\n` +
      `<b>Name:</b> ${esc(d.name)}\n<b>Email:</b> ${esc(d.email)}\n` +
      `<b>Phone:</b> ${esc(d.phone)}\n<b>City:</b> ${esc(d.city)}\n` +
      `<b>Brokerage:</b> ${esc(d.brokerage || '—')}\n` +
      `<b>TREC license:</b> ${esc(d.trec_license || '—')}\n` +
      `<b>Deals/12mo:</b> ${esc(d.deals || '—')}\n` +
      `<b>Heard from:</b> ${esc(d.heard_from || '—')}\n\n` +
      `<i>Nothing was provisioned. Approve via /api/admin-approve-founding or send them an invite code.</i>`,
    );

    return res.status(200).json({
      ok: true,
      mode: 'application_received',
      message: "Got it — Heath reviews these personally and will be in touch shortly.",
    });

  } catch (err) {
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many attempts. Try again later.' });
    }
    console.error('[signup] error:', err && err.message);
    return res.status(500).json({
      ok: false,
      error: 'Something went wrong creating your account. Email heath@meetdossie.com and he will sort it out.',
    });
  }
};
