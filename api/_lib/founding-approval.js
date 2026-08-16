// Shared logic for the founding-application approve/reject lifecycle.
// Called from BOTH /api/admin-approve-founding (Bearer-CRON_SECRET, used for
// programmatic / one-shot triggers) and /api/telegram-webhook (Heath taps an
// inline button on the application notification). Keeping the body in one
// place means the email + DB updates can never drift between the two entry
// points.
//
// FOUNDING CLOSED 2026-08-04 — no new signups, ever. This flow is still live
// today: api/signup.js's "REQUEST ACCESS" path (no invite code) writes into
// this same founding_applications table and pings Heath on Telegram with the
// same Approve/Reject buttons this file handles. Before 2026-08-13 this
// function auto-emailed EVERY approved applicant a live Stripe Payment Link
// for the closed $29/mo-forever founding rate — a real bypass of "closed,"
// found during the pricing sweep. There is no live Stripe price ID for Solo
// or Team yet (see api/signup.js), so there is nothing valid to auto-sell
// on approval. Approve now just marks the row approved and tells Heath to
// follow up personally (send a manual Stripe payment link once Solo/Team
// prices exist, or a comp'd invite code). Nobody gets a checkout link they
// weren't supposed to have.

const { captureServerEvent } = require('./posthog');

async function supabaseGet(path) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`supabase GET ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function supabasePatch(path, patch) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const r = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`supabase PATCH ${r.status}: ${t.slice(0, 200)}`);
  }
}

async function loadApplication(applicationId) {
  const enc = encodeURIComponent(applicationId);
  const rows = await supabaseGet(
    `/rest/v1/founding_applications?id=eq.${enc}&select=*&limit=1`,
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

// Founding is closed — there is no checkout link to build anymore. Approval
// now just tells the applicant Heath is setting up their account personally.
function approvalEmailHtml({ firstName }) {
  const safeName = String(firstName || 'there').replace(/[<>]/g, '');
  return `
<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FDFCFA;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#1A1A2E;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;line-height:1.3;margin:0 0 24px;">${safeName},</p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">You're in. I read your application and it's exactly the kind of agent Dossie was built for.</p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 18px;">I'm setting your account up personally — I'll follow up directly in the next day or two with next steps to get you started.</p>
    <p style="font-size:16px;line-height:1.6;margin:0 0 6px;">Reply to this email if anything sticks. I read every one.</p>
    <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;line-height:1.4;margin:24px 0 0;">— Heath, founder of Dossie</p>
  </div>
</body>
</html>`.trim();
}

async function sendApprovalEmail({ resendKey, email, name, heardFrom }) {
  if (!resendKey) throw new Error('RESEND_API_KEY missing');
  const firstName = String(name || '').trim().split(/\s+/)[0] || '';
  const html = approvalEmailHtml({ firstName });
  const heardSlug = String(heardFrom || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64) || 'unknown';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Heath at Dossie <heath@meetdossie.com>',
      to: [email],
      reply_to: 'heath@meetdossie.com',
      subject: "You're in — welcome to Dossie",
      html,
      bcc: ['heath@meetdossie.com'],
      // Tags surface in the Resend dashboard so Heath can slice approval-email
      // sends by acquisition channel without joining back to the DB.
      tags: [
        { name: 'category', value: 'application_approval' },
        { name: 'heard_from', value: heardSlug },
      ],
      headers: {
        'X-Heard-From': heardSlug,
      },
    }),
  });
  const text = await r.text().catch(() => '');
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!r.ok) {
    throw new Error(`Resend ${r.status}: ${text.slice(0, 300)}`);
  }
  return parsed;
}

const HEARD_FROM_LABELS = {
  facebook_group: 'Facebook group post',
  facebook_page: 'Facebook page',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  twitter_x: 'Twitter/X',
  google_search: 'Google search',
  word_of_mouth: 'Word of mouth / another agent',
  trec_calculator: 'TREC deadline calculator',
  linkedin: 'LinkedIn',
  other: 'Other',
};

function prettyHeardFrom(v) {
  if (!v) return '—';
  return HEARD_FROM_LABELS[String(v).toLowerCase()] || String(v);
}

async function sendHeathTelegramConfirmation({ botToken, chatId, app, emailId }) {
  if (!botToken || !chatId) return;
  const text = [
    '✅ <b>Application approved</b>',
    '',
    `<b>Name:</b> ${app.name}`,
    `<b>Email:</b> ${app.email}`,
    `<b>How they found us:</b> ${prettyHeardFrom(app.heard_from)}`,
    '<b>Founding is closed</b> — no checkout link was sent. Follow up personally to get them set up (comp invite code, or a manual Stripe link once Solo/Team prices exist).',
    `<b>Resend message id:</b> ${emailId || '—'}`,
  ].join('\n');
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
}

// Top-level entry point. Idempotent — safe to call twice on the same row;
// the second call re-sends the approval email.
//
// Founding is closed, so this no longer sends a Stripe checkout/payment
// link. It marks the application approved, emails the applicant that Heath
// is setting them up personally, and tells Heath (via Telegram) to follow
// up manually — same human-in-the-loop guarantee as before ("nobody gets an
// account without Heath saying yes"), just without an accidental founding
// price offer attached.
async function approveFoundingApplication({ applicationId, env, opts = {} }) {
  const app = await loadApplication(applicationId);
  if (!app) {
    return { ok: false, error: `application ${applicationId} not found` };
  }

  // Update status (no-op if already approved).
  const now = new Date().toISOString();
  await supabasePatch(
    `/rest/v1/founding_applications?id=eq.${encodeURIComponent(applicationId)}`,
    { status: 'approved', decision: 'approved', reviewed_at: now },
  );

  let emailId = null;
  let emailError = null;
  try {
    const emailResp = await sendApprovalEmail({
      resendKey: env.RESEND_API_KEY,
      email: app.email,
      name: app.name,
      heardFrom: app.heard_from,
    });
    emailId = emailResp?.id || null;
  } catch (err) {
    emailError = (err && err.message) || String(err);
    console.error('[founding-approval] email failed:', emailError);
  }

  await sendHeathTelegramConfirmation({
    botToken: env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_MARKETING_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    app,
    emailId,
  });

  // Analytics: fires whether Heath approved via Telegram inline button or
  // via the admin-approve-founding endpoint. Both share this code path.
  try {
    const submittedAt = app.created_at ? new Date(app.created_at).getTime() : null;
    await captureServerEvent({
      distinctId: app.email,
      event: 'founding_application_approved',
      properties: {
        heard_from: app.heard_from || null,
        time_since_submitted_minutes: submittedAt
          ? Math.round((Date.now() - submittedAt) / 60000)
          : null,
      },
    });
  } catch (_) { /* analytics never load-bearing */ }

  return {
    ok: true,
    application: { id: app.id, name: app.name, email: app.email },
    emailId,
    emailError,
  };
}

async function rejectFoundingApplication({ applicationId }) {
  const app = await loadApplication(applicationId);
  if (!app) {
    return { ok: false, error: `application ${applicationId} not found` };
  }
  const now = new Date().toISOString();
  await supabasePatch(
    `/rest/v1/founding_applications?id=eq.${encodeURIComponent(applicationId)}`,
    { status: 'rejected', decision: 'rejected', reviewed_at: now },
  );
  try {
    await captureServerEvent({
      distinctId: app.email,
      event: 'founding_application_rejected',
      properties: { heard_from: app.heard_from || null },
    });
  } catch (_) { /* analytics never load-bearing */ }
  return { ok: true, application: { id: app.id, name: app.name, email: app.email } };
}

module.exports = {
  approveFoundingApplication,
  rejectFoundingApplication,
};
