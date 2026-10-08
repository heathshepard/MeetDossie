'use strict';

// api/_lib/outcome-expectations.js
//
// The measurement half of the outcome monitor: load declared expectations from
// the outcome_expectations table and count what the SYSTEM OF RECORD actually
// contains for each one.
//
// Design rule, and the whole point of the exercise: never read a job's own
// status flag. cron_runs.last_status said 'ok' for every one of the eight
// failures this was built after. We count the artifacts -- posted rows,
// rendered files, posted replies -- because an artifact cannot lie about
// existing. (memory: feedback_poll-system-of-record-not-notifications)
//
// TIER 1 NOTE -- the irreducible browser surface, recorded here because this is
// the file anyone touching the expectation set will open. All of it verified
// live on 2026-09-25 against GET https://zernio.com/api/v1/accounts (12
// connected destinations) and the zernio_accounts table (11 active rows).
//
//   API-CAPABLE TODAY, on Zernio's self-refreshing OAuth, zero browser:
//     facebook Page, instagram, twitter, linkedin COMPANY page, tiktok, youtube
//     -- for @meetdossie, @heathshepardrealtor and Rust alike.
//
//   BROWSER-ONLY BY NECESSITY (no API exists at any price, Meta does not ship
//   one and this will not change):
//     facebook GROUP posting, facebook comment replies, group comment harvest,
//     group lead scraping.
//
//   BROWSER-ONLY BY ACCIDENT -- the migration candidate:
//     linkedin_personal. Zernio's LinkedIn integration demonstrably works: the
//     MeetDossie company page posts through it daily on a token nobody has
//     touched in months, while the personal profile runs on a Chrome cookie
//     that died on 2026-09-22 and took 5 approved posts with it.
//     UNVERIFIED, and it is the whole decision: Zernio's connected list holds
//     exactly one LinkedIn destination (the company page), so whether it will
//     accept a personal PROFILE destination has not been established. That is a
//     two-minute connect attempt in the Zernio dashboard, not a build. If it
//     accepts, linkedin_personal moves to the API path and one entire cookie
//     class stops being able to fail. If it refuses, the channel is genuinely
//     browser-bound and the expectation set should say so instead of pretending
//     a fix is one login away.
//
// Net: of the channels that broke this month, the FB group + comment work is
// irreducibly browser-based; linkedin_personal probably is not. Shrinking the
// surface to just the Meta group work is the realistic target -- not zero.
//
// Owner: Atlas, 2026-09-25

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// PostgREST operators we allow in a stored filter. Anything else is rejected
// rather than passed through -- source_filters is data in a table, and data in
// a table is an injection surface unless you treat it like one.
const ALLOWED_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike',
  'is', 'in', 'not.is', 'not.in', 'not.eq',
]);

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

// PostgREST JSON-path column form, e.g. last_meta->>outcome. Needed so an
// expectation can assert on a JSONB field (the telemetry-blindness check reads
// cron_runs.last_meta->>outcome) without widening the identifier rule.
const JSON_PATH_RE = /^[a-z_][a-z0-9_]*(->>?[a-z_][a-z0-9_]*)+$/;

function validColumn(col) {
  return IDENT_RE.test(col) || JSON_PATH_RE.test(col);
}

// ─── Supabase REST ───────────────────────────────────────────────────────────

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data, contentRange: res.headers.get('content-range') };
}

/**
 * Exact row count for a PostgREST query, without transferring the rows.
 * Uses Prefer: count=exact + a 0-length Range so the body stays empty.
 */
async function countRows(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method: 'HEAD',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const cr = res.headers.get('content-range'); // "0-0/45" or "*/0"
  if (!res.ok) return { ok: false, status: res.status, count: null };
  const total = cr && cr.includes('/') ? cr.split('/')[1] : null;
  if (total === null || total === '*') return { ok: true, status: res.status, count: null };
  return { ok: true, status: res.status, count: parseInt(total, 10) };
}

// ─── Query construction ──────────────────────────────────────────────────────

/**
 * Which column the count query projects.
 *
 * BUGFIX 2026-09-25 (Atlas): this was hardcoded to `id`, which is an
 * ASSUMPTION about every table the expectation set can ever name.
 * credential_health's primary key is `channel` and it has no id column at all,
 * so PostgREST answered credential_probe_fresh with HTTP 400 on every run from
 * the hour it shipped. An expectation that can only ever error is worse than no
 * expectation: it looks like coverage.
 *
 * The projection is not what the query is FOR -- a HEAD with Prefer:
 * count=exact is answered by count(*) and Range: 0-0 keeps the body empty, so
 * the column named here never affects the number. It only has to be a column
 * that exists. So: an explicitly declared count_column, else the time_column
 * the expectation already depends on (and already validates), else `*`, which
 * no table can lack. Nothing here guesses a name.
 */
function countProjection(exp) {
  if (exp.count_column) {
    if (!IDENT_RE.test(exp.count_column)) throw new Error(`invalid count_column: ${exp.count_column}`);
    return exp.count_column;
  }
  if (exp.time_column && IDENT_RE.test(exp.time_column)) return exp.time_column;
  return '*';
}

/**
 * Turn a stored expectation into a validated PostgREST query string.
 * Throws on anything that does not look like a plain identifier or an
 * allowlisted operator -- fail closed, never build a half-trusted query.
 */
function buildQuery(exp, { nowMs = Date.now() } = {}) {
  if (!IDENT_RE.test(exp.source_table)) {
    throw new Error(`invalid source_table: ${exp.source_table}`);
  }
  const parts = [`select=${countProjection(exp)}`];

  const filters = exp.source_filters || {};
  for (const [col, expr] of Object.entries(filters)) {
    if (!validColumn(col)) throw new Error(`invalid filter column: ${col}`);
    if (typeof expr !== 'string') throw new Error(`invalid filter value for ${col}`);
    const dot = expr.indexOf('.');
    if (dot < 0) throw new Error(`filter for ${col} must be "op.value", got: ${expr}`);
    // longest-prefix match so "not.is" wins over "not"
    let op = null;
    for (const cand of ALLOWED_OPS) {
      if (expr === cand || expr.startsWith(`${cand}.`)) {
        if (!op || cand.length > op.length) op = cand;
      }
    }
    if (!op) throw new Error(`disallowed operator in filter for ${col}: ${expr}`);
    parts.push(`${col}=${expr}`);
  }

  if (exp.time_column) {
    if (!IDENT_RE.test(exp.time_column)) throw new Error(`invalid time_column: ${exp.time_column}`);
    const cutoff = new Date(nowMs - windowHours(exp) * 3600 * 1000).toISOString();
    // Window direction is DECLARED, never inferred. Two genuinely different
    // questions share this shape and guessing between them is how a check ends
    // up silently asking the wrong one:
    //   recent      "did enough happen lately?"        time >= cutoff
    //   older_than  "is anything still stuck here?"    time <  cutoff
    parts.push(windowMode(exp) === 'older_than'
      ? `${exp.time_column}=lt.${cutoff}`
      : `${exp.time_column}=gte.${cutoff}`);
  }

  return `${exp.source_table}?${parts.join('&')}`;
}

function windowMode(exp) {
  return exp.window_mode === 'older_than' ? 'older_than' : 'recent';
}

// BUGFIX (Atlas 2026-09-25): `exp.window_hours || 24` treats a DECLARED
// window_hours=0 (a real, meaningful value — "older_than" with 0 means
// "anything at all in the past", used by e.g. video_scheduled_not_posted's
// scheduled_for-has-passed check) as falsy and silently substitutes 24,
// giving that expectation a full day of unintended slack it was never
// configured to have. Caught live: outcome-monitor-verify.js reported
// video_orphan_files_stale as MET with window_hours temporarily set to 0 for
// a test, when the raw PostgREST count for the same cutoff was 15, not 0.
// 24 remains the correct default for an ABSENT window_hours (null/undefined
// — every expectation that predates this field, or a future INSERT that
// omits it).
function windowHours(exp) {
  return exp.window_hours === null || exp.window_hours === undefined ? 24 : Number(exp.window_hours);
}

/** min_count = 0 means "this set must stay EMPTY" (a backlog assertion). */
function isInverted(exp) {
  return Number(exp.min_count) === 0;
}

/**
 * When did this pipeline last actually produce? Ignores the window entirely --
 * this is what makes the outage age HONEST.
 *
 * Without it, "how long has this been broken" can only be measured from when
 * the monitor first noticed, so a channel that had already been dead 8 days
 * would report "down 0h" on the monitor's first run and sit inside its own
 * grace period. Asking the system of record for the last artifact instead means
 * the very first check knows the true age, and the cost line says "down 8 days".
 */
async function lastProducedAt(exp) {
  if (!exp.time_column || isInverted(exp)) return null;
  if (!IDENT_RE.test(exp.source_table) || !IDENT_RE.test(exp.time_column)) return null;
  const parts = [`select=${exp.time_column}`, `order=${exp.time_column}.desc.nullslast`, 'limit=1'];
  for (const [col, expr] of Object.entries(exp.source_filters || {})) {
    if (!validColumn(col) || typeof expr !== 'string') return null;
    parts.push(`${col}=${expr}`);
  }
  const { ok, data } = await sb(`${exp.source_table}?${parts.join('&')}`);
  if (!ok || !Array.isArray(data) || !data[0]) return null;
  return data[0][exp.time_column] || null;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

async function loadExpectations({ onlyKeys = null, includeDisabled = false } = {}) {
  let q = 'outcome_expectations?select=*&order=pipeline,key';
  if (!includeDisabled) q += '&enabled=eq.true';
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return [];
  if (onlyKeys && onlyKeys.length) return data.filter((e) => onlyKeys.includes(e.key));
  return data;
}

/**
 * Measure one expectation against the system of record.
 * Returns { key, expected, actual, met, inverted, query, error }.
 */
async function measure(exp, opts = {}) {
  const started = Date.now();
  let query;
  try {
    query = buildQuery(exp, opts);
  } catch (e) {
    return { key: exp.key, expected: exp.min_count, actual: null, met: false,
             error: `bad expectation spec: ${e.message}`, duration_ms: Date.now() - started };
  }
  const r = await countRows(query);
  if (!r.ok || r.count === null) {
    return { key: exp.key, expected: exp.min_count, actual: null, met: false, query,
             error: `count failed (http ${r.status})`, duration_ms: Date.now() - started };
  }
  const inverted = isInverted(exp);
  // Inverted: the set must be empty. Normal: >= min_count.
  const met = inverted ? r.count === 0 : r.count >= Number(exp.min_count);
  const last = met ? null : await lastProducedAt(exp).catch(() => null);
  // NEVER-PRODUCED is the most severe case, not the mildest. If the table has
  // no matching artifact at all, the honest age is "at least as long as we have
  // been asking", so it floors at the window rather than collapsing to null and
  // looking brand new. linkedin_personal has literally never posted; treating
  // that as a 0-hour-old problem would park it in its own grace period forever.
  const outageHours = met ? null
    : last ? (Date.now() - new Date(last).getTime()) / 3600000
    : (inverted ? null : windowHours(exp));
  return {
    key: exp.key, expected: Number(exp.min_count), actual: r.count,
    met, inverted, query, error: null,
    last_produced_at: last,
    never_produced: !met && !inverted && !last,
    outage_hours: outageHours,
    duration_ms: Date.now() - started,
  };
}

module.exports = {
  sb, countRows, buildQuery, countProjection, isInverted, windowMode, windowHours, loadExpectations,
  measure, lastProducedAt, validColumn, ALLOWED_OPS, IDENT_RE, JSON_PATH_RE,
};
