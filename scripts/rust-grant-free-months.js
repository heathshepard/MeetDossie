#!/usr/bin/env node
/**
 * rust-grant-free-months.js
 *
 * Grants free subscription months to Rust beta testers (the first 15 Android
 * beta testers were promised 3 months free at launch).
 *
 * How it works: Rust's `src/lib/useSubscription.ts` checks
 *   status === 'active' || status === 'past_due'  -> full access, returns immediately
 * so writing status='active' with a future current_period_end grants access with
 * zero Stripe involvement. Same approach used for the Play App Review demo
 * account (playreviewer@meetdossie.com) on 2026-08-30.
 *
 * Target DB: Rust's OWN Supabase project (aflqnvlhpkbokfneyhqh), NOT MeetDossie's.
 *
 * Usage:
 *   node scripts/rust-grant-free-months.js <email> [email2 ...] [--months N]
 *   node scripts/rust-grant-free-months.js --file testers.txt        (one email per line)
 *   node scripts/rust-grant-free-months.js <email> --dry-run
 *   node scripts/rust-grant-free-months.js <email> --force           (re-extend even if already covered)
 *
 * Credentials (never hardcoded - this is a PUBLIC repo):
 *   Reads RUST_SUPABASE_URL + RUST_SUPABASE_SERVICE_ROLE_KEY from the environment,
 *   or from ~/.rust-app-secrets/rust-supabase.env (chmod 600), matching the
 *   convention already used for the Play Developer API service account.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRETS_FILE = path.join(os.homedir(), '.rust-app-secrets', 'rust-supabase.env');
const DEFAULT_URL = 'https://aflqnvlhpkbokfneyhqh.supabase.co';
const DEFAULT_MONTHS = 3;

// ---------------------------------------------------------------- credentials

function loadCredentials() {
  const fromFile = {};
  if (fs.existsSync(SECRETS_FILE)) {
    for (const line of fs.readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  const url =
    process.env.RUST_SUPABASE_URL || fromFile.RUST_SUPABASE_URL || DEFAULT_URL;
  const key =
    process.env.RUST_SUPABASE_SERVICE_ROLE_KEY ||
    fromFile.RUST_SUPABASE_SERVICE_ROLE_KEY ||
    '';

  if (!key || key === '[SENSITIVE]') {
    console.error(
      [
        'ERROR: no Rust service-role key available.',
        '',
        'Provide it one of two ways:',
        '  1. export RUST_SUPABASE_SERVICE_ROLE_KEY=...',
        `  2. put RUST_SUPABASE_SERVICE_ROLE_KEY=... in ${SECRETS_FILE} (chmod 600)`,
        '',
        'Reveal it from the Supabase dashboard (Project Settings -> API Keys) for',
        'project aflqnvlhpkbokfneyhqh. Note: Rust/.env.local holds only the anon key',
        'and [SENSITIVE] placeholders - those will not work.',
      ].join('\n')
    );
    process.exit(2);
  }
  if (!/^https:\/\/aflqnvlhpkbokfneyhqh\./.test(url)) {
    console.error(
      `ERROR: RUST_SUPABASE_URL is "${url}" - that is not Rust's project ` +
        '(aflqnvlhpkbokfneyhqh). Refusing to write to the wrong database.'
    );
    process.exit(2);
  }
  return { url: url.replace(/\/+$/, ''), key };
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const emails = [];
  let months = DEFAULT_MONTHS;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--months' || a === '-m') {
      months = Number(argv[++i]);
    } else if (a.startsWith('--months=')) {
      months = Number(a.split('=')[1]);
    } else if (a === '--file' || a === '-f') {
      const p = argv[++i];
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const e = line.trim();
        if (e && !e.startsWith('#')) emails.push(e);
      }
    } else if (a === '--dry-run' || a === '-n') {
      dryRun = true;
    } else if (a === '--force') {
      force = true;
    } else if (a === '--help' || a === '-h') {
      emails.length = 0;
      break;
    } else if (a.startsWith('-')) {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    } else {
      emails.push(a.trim());
    }
  }

  if (!emails.length) {
    console.log(
      [
        'Usage: node scripts/rust-grant-free-months.js <email> [email2 ...] [--months N]',
        '',
        '  --months N   number of free months to grant (default 3)',
        '  --file PATH  read emails from a file, one per line',
        '  --dry-run    show what would change, write nothing',
        '  --force      extend even if the user is already covered past the target date',
      ].join('\n')
    );
    process.exit(emails.length ? 0 : 1);
  }
  if (!Number.isFinite(months) || months <= 0 || months > 120) {
    console.error(`ERROR: --months must be a number between 1 and 120 (got "${months}")`);
    process.exit(2);
  }
  // de-dupe, case-insensitive, preserve order
  const seen = new Set();
  const unique = [];
  for (const e of emails) {
    const k = e.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(e);
    }
  }
  return { emails: unique, months, dryRun, force };
}

// ---------------------------------------------------------------- date math

/** Add N months, clamping the day so Jan 31 + 1mo = Feb 28/29, not Mar 3. */
function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

// ---------------------------------------------------------------- supabase

function makeClient({ url, key }) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };

  async function req(pathname, opts = {}) {
    const res = await fetch(`${url}${pathname}`, {
      ...opts,
      headers: { ...headers, ...(opts.headers || {}) },
    });
    const text = await res.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      const detail =
        body && typeof body === 'object'
          ? body.message || body.msg || body.error_description || JSON.stringify(body)
          : String(body || '');
      throw new Error(`${res.status} ${res.statusText} on ${pathname}: ${detail}`);
    }
    return body;
  }

  return {
    /**
     * Build an email -> {id, email} map of every auth user, once per run.
     * auth.users is not exposed through PostgREST, so this uses the GoTrue
     * admin API. Paged; a run with a few hundred users is one or two calls.
     */
    async loadUsersByEmail() {
      const map = new Map();
      const perPage = 1000;
      for (let page = 1; page <= 100; page++) {
        const body = await req(
          `/auth/v1/admin/users?page=${page}&per_page=${perPage}`
        );
        const users = Array.isArray(body) ? body : body && body.users;
        if (!users || !users.length) break;
        for (const u of users) {
          if (u.email) map.set(u.email.toLowerCase(), { id: u.id, email: u.email });
        }
        if (users.length < perPage) break;
      }
      return map;
    },

    getSubscription(userId) {
      return req(
        `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=*`
      ).then((rows) => (Array.isArray(rows) && rows.length ? rows[0] : null));
    },

    /** Insert-or-update on the subscriptions_user_id_key UNIQUE(user_id). */
    upsertSubscription(row) {
      return req('/rest/v1/subscriptions?on_conflict=user_id', {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify([row]),
      });
    },
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const { emails, months, dryRun, force } = parseArgs(process.argv.slice(2));
  const creds = loadCredentials();
  const db = makeClient(creds);

  const now = new Date();
  const target = addMonths(now, months);
  const targetIso = target.toISOString();
  // Re-running the same grant a few minutes later should be a no-op, not a
  // 3-minute extension. Anything already covered to within a day of the target
  // counts as already granted.
  const alreadyCoveredThreshold = new Date(target.getTime() - 24 * 60 * 60 * 1000);

  console.log(`Rust free-month grant  ->  project aflqnvlhpkbokfneyhqh`);
  console.log(`Months: ${months}   Access through: ${targetIso}`);
  if (dryRun) console.log('DRY RUN - nothing will be written.');
  console.log('');

  let users;
  try {
    users = await db.loadUsersByEmail();
  } catch (err) {
    console.error(`ERROR: could not list auth users - ${err.message}`);
    process.exit(1);
  }

  const results = { granted: [], already: [], notRegistered: [], failed: [] };

  for (const email of emails) {
    const user = users.get(email.toLowerCase());

    if (!user) {
      console.log(`NOT REGISTERED  ${email}`);
      console.log(`                no Rust account with this email - needs to sign up first`);
      results.notRegistered.push(email);
      continue;
    }

    try {
      const existing = await db.getSubscription(user.id);
      const covered =
        existing &&
        existing.status === 'active' &&
        existing.current_period_end &&
        new Date(existing.current_period_end) >= alreadyCoveredThreshold;

      if (covered && !force) {
        console.log(`ALREADY         ${email}`);
        console.log(
          `                active through ${existing.current_period_end} - left alone`
        );
        results.already.push(email);
        continue;
      }

      if (dryRun) {
        console.log(`WOULD GRANT     ${email}`);
        console.log(
          `                ${existing ? `${existing.status} -> active` : 'no row -> new active row'}, through ${targetIso}`
        );
        results.granted.push(email);
        continue;
      }

      // Preserve everything else on the row; only move the access fields.
      const row = {
        ...(existing || {}),
        user_id: user.id,
        status: 'active',
        current_period_end: targetIso,
        trial_end: targetIso, // belt-and-suspenders, matches the reviewer account
      };
      await db.upsertSubscription(row);

      // Read back - never trust the write.
      const after = await db.getSubscription(user.id);
      if (!after) throw new Error('read-back returned no row');
      if (after.status !== 'active') {
        throw new Error(`read-back status is "${after.status}", expected "active"`);
      }
      const drift = Math.abs(new Date(after.current_period_end) - target);
      if (!after.current_period_end || drift > 1000) {
        throw new Error(
          `read-back current_period_end is "${after.current_period_end}", expected ${targetIso}`
        );
      }

      console.log(`GRANTED         ${email}`);
      console.log(
        `                ${existing ? `was ${existing.status}` : 'new row'} -> active, verified through ${after.current_period_end}`
      );
      results.granted.push(email);
    } catch (err) {
      console.log(`FAILED          ${email}`);
      console.log(`                ${err.message}`);
      results.failed.push(email);
    }
  }

  console.log('');
  console.log('--- summary ---');
  console.log(`granted:        ${results.granted.length}`);
  console.log(`already had it: ${results.already.length}`);
  console.log(`not registered: ${results.notRegistered.length}`);
  console.log(`failed:         ${results.failed.length}`);
  if (results.notRegistered.length) {
    console.log('');
    console.log('These still need to create a Rust account before they can be granted:');
    for (const e of results.notRegistered) console.log(`  - ${e}`);
  }

  process.exit(results.failed.length || results.notRegistered.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
