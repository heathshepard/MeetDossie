'use strict';

// api/_lib/brokerage-funnel.js
//
// Measures Heath's OTHER funnel — consumers/referral partners on his
// personal/realtor accounts, as distinct from the Dossie funnel
// (api/_lib/attribution.js). Explicitly NOT the same audience or the same
// conversion event: Dossie's funnel ends at a paying subscriber; this one
// ends at a listing, a buyer agreement, or a closing.
//
// WHAT THIS CAN SEE
//   Top of funnel only: comment_dm_leads (supabase/migrations/
//   20260925_zernio_comment_engine.sql) — who commented a keyword on a
//   heath-realtor video and got DM'd an asset, cross-referenced against
//   zernio_accounts.owner so a heath-realtor lead is told apart from a
//   dossie one sharing the same comment-engine infrastructure.
//
// WHAT THIS STRUCTURALLY CANNOT SEE
//   Everything downstream of the DM: did they reply, call, book a showing,
//   sign a listing or buyer agreement, close. There is no webhook, no API,
//   and no table ANYWHERE in this database for any of that — it happens in
//   Heath's texts, calls, in-person meetings, and (once a deal exists)
//   zipForm/connectMLS, none of which this repo can read. This file does not
//   pretend otherwise: downstream_tracking below is always explicit about
//   this, and outcome_* fields are null (not a fabricated 0) unless Heath or
//   Pierce has manually logged them via the optional comment_dm_leads.outcome
//   column (supabase/migrations/20261002_comment_dm_leads_outcome.sql, NOT
//   applied as of this writing — see same caveat pattern as
//   api/_lib/attribution.js's waitlist_tracking).
//
// Owner: Pierce, 2026-10-02 (feat/lead-attribution-1002)

const KNOWN_OWNERS = ['dossie', 'heath-realtor', 'rust'];

function daysAgoIso(days) {
  return new Date(Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000).toISOString();
}

async function defaultSupabaseFetch(path, init = {}) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// account_id on comment_dm_leads is the ZERNIO account id string (see
// api/cron-sync-comment-dm-leads.js -> video_comment_automations.account_id),
// which matches zernio_accounts.zernio_account_id, NOT zernio_accounts.id.
// Confirmed against supabase/migrations/20260818_zernio_accounts_page_id.sql's
// INSERT column list.
function buildOwnerByAccountId(zernioAccounts) {
  const map = new Map();
  for (const row of zernioAccounts) {
    if (row.zernio_account_id) map.set(String(row.zernio_account_id), row.owner || 'dossie');
  }
  return map;
}

function emptyOwnerBucket() {
  return {
    leads_total: 0,
    dm_sent: 0,
    dm_delivered: 0,
    dm_read: 0,
    by_keyword: {},
    outcomes: null, // filled in only if outcome tracking is available
  };
}

async function getBrokerageFunnelSummary({ days = 30, supabaseFetch = defaultSupabaseFetch } = {}) {
  const cutoff = daysAgoIso(days);

  const [zernioRes, leadsRes] = await Promise.all([
    supabaseFetch('/rest/v1/zernio_accounts?select=zernio_account_id,owner,platform,account_handle,is_active'),
    supabaseFetch(`/rest/v1/comment_dm_leads?triggered_at=gte.${encodeURIComponent(cutoff)}` +
      '&select=id,platform,account_id,keyword,video_library_id,dm_status,delivered,read,' +
      'commenter_handle,commenter_platform_id,triggered_at'),
  ]);

  if (!zernioRes.ok) {
    return {
      window_days: days,
      generated_at: new Date().toISOString(),
      error: `could not read zernio_accounts (status ${zernioRes.status}) — cannot tell dossie leads apart from heath-realtor leads without it`,
    };
  }

  const zernioAccounts = Array.isArray(zernioRes.data) ? zernioRes.data : [];
  const ownerByAccountId = buildOwnerByAccountId(zernioAccounts);
  const leads = (leadsRes.ok && Array.isArray(leadsRes.data)) ? leadsRes.data : [];

  // Outcome columns (supabase/migrations/20261002_comment_dm_leads_outcome.sql)
  // are optional and NOT applied as of this writing. Try to read them; a
  // column-not-found 400 degrades to "unavailable", never a crash, never a
  // fabricated zero — same contract as attribution.js's waitlist_tracking.
  const outcomesRes = await supabaseFetch(
    `/rest/v1/comment_dm_leads?triggered_at=gte.${encodeURIComponent(cutoff)}` +
    '&select=id,account_id,outcome,outcome_at',
  );
  const outcomeTrackingAvailable = !!outcomesRes.ok;
  const outcomeById = new Map();
  if (outcomeTrackingAvailable && Array.isArray(outcomesRes.data)) {
    for (const row of outcomesRes.data) outcomeById.set(row.id, row.outcome || null);
  }

  const buckets = { dossie: emptyOwnerBucket(), 'heath-realtor': emptyOwnerBucket(), unknown: emptyOwnerBucket() };
  if (outcomeTrackingAvailable) {
    for (const key of Object.keys(buckets)) {
      buckets[key].outcomes = { replied: 0, appointment_booked: 0, listing_agreement: 0, buyer_agreement: 0, closed: 0, dead: 0, not_yet_logged: 0 };
    }
  }

  for (const lead of leads) {
    const owner = ownerByAccountId.get(String(lead.account_id)) || 'unknown';
    const bucket = buckets[owner] || buckets.unknown;
    bucket.leads_total++;

    const status = (lead.dm_status || '').toLowerCase();
    if (status === 'sent' || status === 'delivered' || lead.delivered || lead.read) bucket.dm_sent++;
    if (lead.delivered) bucket.dm_delivered++;
    if (lead.read) bucket.dm_read++;

    const kw = lead.keyword || '(none)';
    bucket.by_keyword[kw] = (bucket.by_keyword[kw] || 0) + 1;

    if (outcomeTrackingAvailable) {
      const outcome = outcomeById.get(lead.id);
      if (outcome && bucket.outcomes[outcome] !== undefined) bucket.outcomes[outcome]++;
      else bucket.outcomes.not_yet_logged++;
    }
  }

  return {
    window_days: days,
    generated_at: new Date().toISOString(),
    leads_total: leads.length,
    leads_tracking: leadsRes.ok ? 'ok' : `FAILED: status ${leadsRes.status}`,
    unknown_owner_count: buckets.unknown.leads_total,
    unknown_owner_note: buckets.unknown.leads_total > 0
      ? 'These leads came through a Zernio account_id not found in zernio_accounts (likely a retired/deleted connected account) — real leads, just not attributable to dossie vs heath-realtor until that account_id is reconciled.'
      : null,
    per_owner: {
      'heath-realtor': buckets['heath-realtor'],
      dossie: buckets.dossie,
    },
    outcome_tracking: outcomeTrackingAvailable
      ? 'ok'
      : 'unavailable — comment_dm_leads.outcome is not migrated in this environment yet ' +
        '(supabase/migrations/20261002_comment_dm_leads_outcome.sql exists but is NOT applied — Heath\'s call).',
    downstream_tracking: {
      automated: false,
      reason: 'Nothing past the DM itself is webhook-able or API-readable: a reply, a phone call, a showing, ' +
        'a signed listing/buyer agreement, and a closing all happen outside any system this repo can query. ' +
        'The outcome_* fields above (when outcome_tracking is "ok") are ONLY as current as the last manual ' +
        'update — comment_dm_leads.outcome is filled in by hand, there is no automated event source for it, ' +
        'and there structurally never can be one without a CRM/calendar integration that does not exist today.',
    },
  };
}

module.exports = {
  KNOWN_OWNERS,
  buildOwnerByAccountId,
  getBrokerageFunnelSummary,
};
