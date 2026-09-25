'use strict';

// scripts/_lib/credential-health-writer.js
//
// The ONE way a row gets into credential_health.
//
// WHY A TABLE AND NOT A FILE -- this is the actual lesson of the 9-day outage.
// scripts/_lib/session-keepalive.js tracked exactly this state in
// scripts/sessions/keepalive-state.json. When its scheduled task stopped
// running, nothing wrote the file, so nothing went stale, so nothing looked
// wrong. Silence was indistinguishable from health.
//
// Inverting it to a database row flips the default: the outcome monitor's
// `credential_probe_fresh` expectation requires a row with last_probe_at inside
// 48h. If this writer stops being called for ANY reason -- task deleted, PC off,
// script crashing on line 1 -- the row goes stale and the monitor opens an
// incident on its own. The absence of news becomes the news.
//
// consecutive_failures is accumulated server-side-ish (read-then-write) rather
// than recomputed, so a channel that has been down for six probes says six.

const EXPIRY_WARN_DAYS = 14;

function creds() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key, ok: !!(url && key) };
}

function headers(key, extra) {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(extra || {}) };
}

async function readRow(channel) {
  const { url, key, ok } = creds();
  if (!ok) return null;
  try {
    const r = await fetch(`${url}/rest/v1/credential_health?channel=eq.${encodeURIComponent(channel)}&select=*`, {
      headers: headers(key),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch { return null; }
}

/**
 * Classify the health of a channel into something a human can act on, and --
 * the point of item 4 -- distinguish DEGRADING from BROKEN so a warning can
 * land before the pipeline actually stops.
 *
 *   healthy        required cookies present, authenticated surface rendered
 *   expiring_soon  still working, but a cookie lapses within 14 days
 *   soft_walled    URL looks logged in, authenticated element never rendered
 *   logged_out     a required cookie is gone -- hard failure, needs Heath
 *   unknown        could not establish; never treated as a failure
 */
function classify({ logged_in, days_to_expiry, soft_walled }) {
  if (logged_in === false) return 'logged_out';
  if (logged_in === null || logged_in === undefined) return 'unknown';
  if (soft_walled) return 'soft_walled';
  if (days_to_expiry !== null && days_to_expiry !== undefined && Number(days_to_expiry) <= EXPIRY_WARN_DAYS) {
    return 'expiring_soon';
  }
  return 'healthy';
}

/**
 * Upsert one channel's health. Safe to call from any script.
 * Returns { ok, status, skipped? } -- never throws, because a telemetry write
 * must not be able to take down the pipeline it is reporting on.
 */
async function writeHealth(input) {
  const { url, key, ok } = creds();
  if (!ok) {
    console.warn('[credential-health] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — not written');
    return { ok: false, skipped: 'no credentials' };
  }

  const now = new Date().toISOString();
  const prior = await readRow(input.channel);
  const healthy = input.logged_in === true;
  const status = classify(input);

  // UNKNOWN must not inflate the failure counter -- "could not check" is not
  // "is broken", and conflating them is how a flapping alert gets ignored.
  let consecutive;
  if (input.logged_in === true) consecutive = 0;
  else if (input.logged_in === false) consecutive = (Number(prior && prior.consecutive_failures) || 0) + 1;
  else consecutive = Number(prior && prior.consecutive_failures) || 0;

  const row = {
    channel: input.channel,
    profile_dir: String(input.profile_dir || ''),
    probe_kind: input.probe_kind || 'cookie_db',
    logged_in: input.logged_in ?? null,
    required_cookies: input.required_cookies || [],
    present_cookies: input.present_cookies || [],
    earliest_expiry: input.earliest_expiry || null,
    days_to_expiry: input.days_to_expiry ?? null,
    consecutive_failures: consecutive,
    last_probe_at: now,
    last_healthy_at: healthy ? now : ((prior && prior.last_healthy_at) || null),
    detail: {
      status,
      soft_walled: !!input.soft_walled,
      // Only a real browser touch advances this. A cookie read is not a touch.
      last_touch_at: input.touched ? now : ((prior && prior.detail && prior.detail.last_touch_at) || null),
      last_touch_kind: input.touched ? (input.probe_kind || 'keepalive_touch') : ((prior && prior.detail && prior.detail.last_touch_kind) || null),
      ...(input.detail || {}),
    },
    updated_at: now,
  };

  try {
    const r = await fetch(`${url}/rest/v1/credential_health?on_conflict=channel`, {
      method: 'POST',
      headers: headers(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify([row]),
    });
    if (!r.ok) {
      const text = await r.text();
      console.warn(`[credential-health] write FAILED ${r.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: r.status, text };
    }
    console.log(`[credential-health] ${input.channel} -> ${status} (consecutive_failures=${consecutive})`);
    return { ok: true, status: status };
  } catch (e) {
    console.warn(`[credential-health] write error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { writeHealth, readRow, classify, EXPIRY_WARN_DAYS };
