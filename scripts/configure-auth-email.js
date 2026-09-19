#!/usr/bin/env node
'use strict';

/**
 * scripts/configure-auth-email.js
 *
 * WHY THIS EXISTS
 *   Read docs/AUTH-EMAIL-SETUP-2026-09-19.md first. Short version: Dossie's
 *   password-reset email goes out through Supabase's built-in shared mailer as
 *   `noreply@mail.app.supabase.io`, on Supabase's stock template, with nothing
 *   on it that says Dossie. Verified from this project's own auth logs on
 *   2026-09-19:
 *
 *     {"event":"mail.send","mail_from":"noreply@mail.app.supabase.io",
 *      "mail_to":"...","mail_type":"recovery"}
 *
 *   To somebody who just paid $29 and has never heard of Supabase, that email
 *   is indistinguishable from phishing. Worse, the built-in mailer refuses to
 *   deliver to addresses outside the project's Supabase org team, so it is
 *   likely that customer resets were not merely ugly but silently dropped.
 *
 * WHAT IT DOES
 *   Applies the whole auth-mail configuration in one call against the Supabase
 *   Management API: custom SMTP (Resend, on meetdossie.com), the five rewritten
 *   templates in supabase/templates/, their subjects, and the link expiry.
 *
 *   This is the ALTERNATIVE to clicking through the dashboard. Either route
 *   produces the same result; the doc has the click-by-click version.
 *
 * SAFETY
 *   --verify (the DEFAULT) is read-only. It fetches the live config and prints
 *   what is set, and never writes. You must pass --apply to change anything.
 *
 *   This script SENDS NO EMAIL. It does not read, modify or contact any
 *   customer account. It only touches project configuration.
 *
 *   Secrets are never printed: the SMTP password is masked in all output.
 *
 * USAGE
 *   # Read-only: what is the live config right now?
 *   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/configure-auth-email.js
 *
 *   # Apply. Needs the Resend API key as the SMTP password.
 *   SUPABASE_ACCESS_TOKEN=sbp_... RESEND_API_KEY=re_... \
 *     node scripts/configure-auth-email.js --apply
 *
 *   SUPABASE_ACCESS_TOKEN comes from https://supabase.com/dashboard/account/tokens
 *   (it is a personal access token, NOT the service role key, and NOT stored in
 *   this repo or in Vercel).
 *
 * Owner: 2026-09-19.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'pgwoitbdiyubjugwufhk';
const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`;

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const APPLY = process.argv.includes('--apply');

// --- The intended configuration -------------------------------------------

// Resend's SMTP bridge. The username is the literal string "resend"; the
// password is the ordinary Resend API key, so this introduces no new
// credential to store or rotate.
const SMTP = {
  host: 'smtp.resend.com',
  port: 465,
  user: 'resend',
  // Sender must be on a Resend-verified domain. meetdossie.com already is --
  // the product sends from it today (api/stripe-webhook.js, api/signup.js).
  adminEmail: 'dossie@meetdossie.com',
  senderName: 'Dossie',
};

// 24 hours, in seconds. This is the maximum GoTrue permits.
//
// The old value (3600 / one hour) is what bricked accounts: the link was the
// customer's only credential, and an hour does not survive a brokerage spam
// quarantine, an evening, or a phone read at dinner. A recovery link is
// single-use, high-entropy and only minted on request, so the marginal risk
// between 1h and 24h is small next to the cost of a locked-out paying customer.
const OTP_EXPIRY_SECONDS = 86400;

const SUBJECTS = {
  recovery: 'Reset your Dossie password',
  invite: "You're in - set your Dossie password",
  confirmation: 'Confirm your Dossie account',
  magic_link: 'Your Dossie sign-in link',
  email_change: 'Confirm your new Dossie email',
};

const TEMPLATE_DIR = path.join(__dirname, '..', 'supabase', 'templates');
const TEMPLATE_FILES = {
  recovery: 'recovery.html',
  invite: 'invite.html',
  confirmation: 'confirmation.html',
  magic_link: 'magic_link.html',
  email_change: 'email_change.html',
};

// --- Helpers ---------------------------------------------------------------

function mask(v) {
  if (v === undefined || v === null || v === '') return '(unset)';
  const s = String(v);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}...${s.slice(-2)} (${s.length} chars)`;
}

async function getConfig() {
  const res = await fetch(API, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET config -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

function readTemplate(name) {
  const p = path.join(TEMPLATE_DIR, TEMPLATE_FILES[name]);
  const html = fs.readFileSync(p, 'utf8');
  // The HTML comment at the top of each file is documentation for whoever
  // opens it next; it should not ride along into a customer's inbox.
  return html.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
}

/**
 * Build the PATCH body, but ONLY with keys the live config actually has.
 *
 * The Management API's auth-config field names are not something to guess at:
 * a typo'd key is silently ignored, which would leave the stock template live
 * while the script cheerfully reported success. So we read the real config
 * first and intersect against it. Anything we cannot place is reported as a
 * gap for the dashboard rather than quietly dropped.
 */
function buildPatch(live) {
  const patch = {};
  const unplaceable = [];

  const put = (key, value, label) => {
    if (Object.prototype.hasOwnProperty.call(live, key)) {
      patch[key] = value;
      return true;
    }
    unplaceable.push(`${label} (expected config key "${key}")`);
    return false;
  };

  put('smtp_host', SMTP.host, 'SMTP host');
  put('smtp_port', SMTP.port, 'SMTP port');
  put('smtp_user', SMTP.user, 'SMTP username');
  put('smtp_pass', RESEND_API_KEY, 'SMTP password');
  put('smtp_admin_email', SMTP.adminEmail, 'Sender email');
  put('smtp_sender_name', SMTP.senderName, 'Sender name');

  put('mailer_otp_exp', OTP_EXPIRY_SECONDS, 'Email link/OTP expiry');

  for (const name of Object.keys(TEMPLATE_FILES)) {
    put(`mailer_templates_${name}_content`, readTemplate(name), `${name} template body`);
    put(`mailer_subjects_${name}`, SUBJECTS[name], `${name} subject`);
  }

  return { patch, unplaceable };
}

function summarise(live) {
  const host = live.smtp_host;
  const usingCustomSmtp = !!host;
  console.log('\n=== LIVE AUTH MAIL CONFIG ===');
  console.log(`  custom SMTP:    ${usingCustomSmtp ? `YES (${host}:${live.smtp_port})` : 'NO -- using Supabase built-in shared mailer'}`);
  console.log(`  sender email:   ${live.smtp_admin_email || '(unset)'}`);
  console.log(`  sender name:    ${live.smtp_sender_name || '(unset)'}`);
  console.log(`  smtp user:      ${live.smtp_user || '(unset)'}`);
  console.log(`  smtp pass:      ${mask(live.smtp_pass)}`);
  console.log(`  link expiry:    ${live.mailer_otp_exp} seconds (${(Number(live.mailer_otp_exp) / 3600).toFixed(1)} h)`);
  console.log(`  autoconfirm:    ${live.mailer_autoconfirm}  (true = no "confirm signup" mail is ever sent)`);
  console.log(`  secure change:  ${live.mailer_secure_email_change_enabled}  (true = email change confirms on BOTH addresses)`);
  console.log(`  email rate cap: ${live.rate_limit_email_sent} per hour`);

  console.log('\n  templates — is each one still Supabase stock?');
  for (const name of Object.keys(TEMPLATE_FILES)) {
    const body = live[`mailer_templates_${name}_content`];
    const subject = live[`mailer_subjects_${name}`];
    const branded = typeof body === 'string' && /DOSSIE/i.test(body);
    const state = !body ? 'STOCK (empty = Supabase default)' : (branded ? 'Dossie-branded' : 'CUSTOM but does not mention Dossie');
    console.log(`    ${name.padEnd(13)} ${state}`);
    console.log(`    ${' '.repeat(13)} subject: ${subject || '(default)'}`);
  }

  if (!usingCustomSmtp) {
    console.log('\n  >>> Built-in mailer is in use. Supabase refuses to deliver to any address');
    console.log('  >>> outside the project org team, so customer mail is likely being DROPPED,');
    console.log('  >>> not just arriving unbranded.');
  }
}

// --- Main ------------------------------------------------------------------

(async () => {
  if (!ACCESS_TOKEN) {
    console.error('SUPABASE_ACCESS_TOKEN is not set.');
    console.error('Create one at https://supabase.com/dashboard/account/tokens and re-run:');
    console.error('  SUPABASE_ACCESS_TOKEN=sbp_... node scripts/configure-auth-email.js');
    process.exit(1);
  }

  const live = await getConfig();
  summarise(live);

  if (!APPLY) {
    console.log('\n(read-only — pass --apply to write this configuration)');
    return;
  }

  if (!RESEND_API_KEY || !/^re_/.test(RESEND_API_KEY)) {
    console.error('\nRESEND_API_KEY must be set to a real Resend key (re_...) to use as the SMTP password.');
    console.error('Note: .env.local holds the literal string [SENSITIVE] for this var, because it is');
    console.error('marked Sensitive in Vercel and cannot be read back. Take the value from the Resend');
    console.error('dashboard or Bitwarden.');
    process.exit(1);
  }

  const { patch, unplaceable } = buildPatch(live);

  if (unplaceable.length) {
    console.log('\n!! These settings have no matching key in the live config and were NOT applied.');
    console.log('!! Set them by hand in the dashboard:');
    for (const u of unplaceable) console.log(`     - ${u}`);
  }

  console.log(`\nApplying ${Object.keys(patch).length} settings...`);
  const res = await fetch(API, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`PATCH failed -> ${res.status}: ${text.slice(0, 600)}`);
    process.exit(1);
  }

  console.log('Applied. Re-reading to confirm it actually stuck:');
  summarise(await getConfig());
  console.log('\nNow send yourself one real reset from https://meetdossie.com/forgot-password.html');
  console.log('and confirm the sender reads "Dossie", not "Supabase".');
})().catch((err) => {
  console.error('FAILED:', err && err.message);
  process.exit(1);
});
