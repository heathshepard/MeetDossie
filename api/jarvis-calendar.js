// Vercel Serverless Function: /api/jarvis-calendar
// =========================================================================
// Returns today + tomorrow calendar events for the Jarvis PWA Calendar widget.
//
// Sources, in order of preference:
//   1. Google Calendar via stored OAuth refresh token in `user_integrations`
//      (table column oauth_provider='google_calendar', refresh_token).
//   2. ICS feed URL stored in `user_integrations.ics_feed_url` (fallback).
//   3. heath_calendar_events local table (manual entries).
//   4. Stub data with a "connect calendar" flag for first-time UX.
//
// GET /api/jarvis-calendar
//   ?days=2   how many days to look ahead (default 2: today + tomorrow)
//
// Auth: REQUIRED Bearer Supabase JWT.
//
// Returns:
//   {
//     ok: true,
//     source: "google" | "ics" | "local" | "stub",
//     needs_oauth: bool,
//     events: [{
//       id, title, start, end, all_day, location, attendees, source,
//       day_label: "today" | "tomorrow" | "Mon Jun 23",
//       can_dismiss: bool, can_snooze: bool, can_start_call: bool,
//       conference_url: string|null
//     }]
//   }
//
// Owner: Atlas (Tier 2 build, 2026-06-21).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

export const config = { api: { bodyParser: true }, maxDuration: 15 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${r.status} ${body.slice(0, 200)}`);
  }
  return r.json();
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'today';
  if (sameDay(d, tomorrow)) return 'tomorrow';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function extractConferenceUrl(description, location) {
  const candidates = [description, location].filter(Boolean).join(' ');
  if (!candidates) return null;
  const m = candidates.match(/https?:\/\/(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com)\/\S+/i);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// Google Calendar fetch
// ---------------------------------------------------------------------------

async function refreshGoogleAccessToken(refreshToken) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('google_oauth_env_missing');
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`google_refresh ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.access_token;
}

async function fetchGoogleEvents(accessToken, timeMin, timeMax) {
  const url = new URL('https://www.googleapis.com/calendar/v3/calendars/primary/events');
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '50');
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`google_events ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const items = data.items || [];
  return items.map((e) => {
    const start = e.start?.dateTime || e.start?.date;
    const end = e.end?.dateTime || e.end?.date;
    const allDay = !e.start?.dateTime;
    const confUrl = e.hangoutLink || extractConferenceUrl(e.description, e.location);
    return {
      id: e.id,
      title: e.summary || '(no title)',
      start,
      end,
      all_day: allDay,
      location: e.location || null,
      attendees: (e.attendees || []).map((a) => ({
        email: a.email, name: a.displayName, response: a.responseStatus,
      })),
      source: 'google',
      day_label: dayLabel(start),
      can_dismiss: true,
      can_snooze: !allDay,
      can_start_call: !!confUrl,
      conference_url: confUrl,
      description: e.description || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Local table fallback
// ---------------------------------------------------------------------------

async function fetchLocalEvents(tenantId, timeMin, timeMax) {
  // Optional local table for Heath to manually add events. Table may not
  // exist; suppress errors.
  try {
    const rows = await sbGet(
      `heath_calendar_events?select=id,title,start_at,end_at,location,description,conference_url&start_at=gte.${timeMin}&start_at=lte.${timeMax}&order=start_at.asc&limit=50`
    );
    return rows.map((e) => {
      const confUrl = e.conference_url || extractConferenceUrl(e.description, e.location);
      return {
        id: e.id,
        title: e.title,
        start: e.start_at,
        end: e.end_at,
        all_day: false,
        location: e.location || null,
        attendees: [],
        source: 'local',
        day_label: dayLabel(e.start_at),
        can_dismiss: true,
        can_snooze: true,
        can_start_call: !!confUrl,
        conference_url: confUrl,
        description: e.description || null,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Integration lookup
// ---------------------------------------------------------------------------

async function findGoogleIntegration(userId) {
  try {
    const rows = await sbGet(
      `user_integrations?select=oauth_provider,refresh_token,access_token,scopes,expires_at`
      + `&user_id=eq.${userId}&oauth_provider=eq.google_calendar&limit=1`
    );
    return rows && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const days = Math.min(7, Math.max(1, parseInt(req.query.days, 10) || 2));
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + days * 24 * 3600 * 1000);
  const timeMin = start.toISOString();
  const timeMax = end.toISOString();

  // 1. Try Google.
  const gIntegration = await findGoogleIntegration(authUser.userId);
  if (gIntegration && gIntegration.refresh_token) {
    try {
      const accessToken = await refreshGoogleAccessToken(gIntegration.refresh_token);
      const events = await fetchGoogleEvents(accessToken, timeMin, timeMax);
      return res.status(200).json({
        ok: true,
        source: 'google',
        needs_oauth: false,
        events,
        window: { start: timeMin, end: timeMax, days },
      });
    } catch (err) {
      console.warn('[jarvis-calendar] google fetch failed:', err.message);
      // fall through to local
    }
  }

  // 2. Local table fallback.
  // Resolve tenant for the local table query.
  let tenantId = null;
  try {
    const rows = await sbGet(`jarvis_users?select=tenant_id&auth_user_id=eq.${authUser.userId}&limit=1`);
    if (rows && rows.length) tenantId = rows[0].tenant_id;
  } catch {}

  const localEvents = await fetchLocalEvents(tenantId, timeMin, timeMax);
  if (localEvents.length > 0) {
    return res.status(200).json({
      ok: true,
      source: 'local',
      needs_oauth: !gIntegration,
      events: localEvents,
      window: { start: timeMin, end: timeMax, days },
    });
  }

  // 3. Stub.
  return res.status(200).json({
    ok: true,
    source: 'stub',
    needs_oauth: !gIntegration,
    events: [],
    window: { start: timeMin, end: timeMax, days },
    message: gIntegration
      ? 'Calendar connected but no events in the next ' + days + ' days.'
      : 'Connect your Google Calendar to see today and tomorrow here.',
  });
}
