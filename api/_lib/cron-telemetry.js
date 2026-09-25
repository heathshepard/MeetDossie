/**
 * Cron telemetry — fail-soft recording of cron run status
 * Records into cron_runs table (upsert on cron_name primary key)
 * Swallows all errors and logs warnings — never breaks the actual cron
 *
 * Two ways to use:
 *
 * 1) Direct call (for crons that need fine-grained meta in the success path):
 *      await recordCronRun('cron-name', 'ok', { items: 12 });
 *
 * 2) Wrapper (preferred for new crons or telemetry-only retrofits):
 *      const { withTelemetry } = require('./_lib/cron-telemetry.js');
 *      module.exports = withTelemetry('cron-name', async function handler(req, res) { ... });
 *
 *    The wrapper auto-records 'ok' on a 2xx response, 'error' on thrown exceptions
 *    or non-2xx responses. Wrapper failures never break the cron.
 */

// ─── OUTCOME ACCOUNTING (Atlas, 2026-09-25) ──────────────────────────────────
//
// THE HARD RULE: a job that processed zero items must not be indistinguishable
// from one that did the work. It reports "ok, 0 items" and the outcome monitor
// (api/_lib/outcome-monitor.js) decides whether zero is acceptable for that
// period.
//
// cron-render-videos is the case that forced this. It recorded
//   last_status='ok', last_meta={duration_ms:168, http_status:200}
// while matching zero rows, for weeks, because its selector had drifted off the
// rows it was supposed to drain. Nothing in that record could tell you.
//
// WHY last_status STAYS 'ok': a dozen places already treat any non-'ok' status
// as an incident (cron-daily-debrief, jarvis-morning-brief, ventures/reliability,
// ...). Minting a new failing status for every idle tick would bury Heath in
// noise, which is the same disease from the other end. So the count goes in
// last_meta, where it is unambiguous and machine-readable:
//   last_meta.outcome        'produced' | 'zero' | 'unknown'
//   last_meta.outcome_items  the number, when we could determine one
// 'unknown' is itself a finding -- outcome-causes.js `telemetry_blind` reports
// every cron that still cannot say what it accomplished.
//
// Keep ITEM_KEYS in sync with api/_lib/outcome-causes.js.
const ITEM_KEYS = [
  'items', 'processed', 'published', 'posted', 'sent', 'rendered', 'claimed',
  'created', 'updated', 'handled', 'count', 'rows', 'generated', 'replied',
  'harvested', 'synced', 'queued', 'approved', 'delivered', 'fixed',
];

function extractItemCount(obj) {
  if (!obj || typeof obj !== 'object') return null;
  let total = null;
  for (const k of ITEM_KEYS) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) total = (total || 0) + v;
  }
  return total;
}

/** res.send / res.end may hand us a JSON string or a Buffer rather than an object. */
function parseBody(body) {
  if (!body) return null;
  if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
  try {
    const s = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    if (s.length > 200000) return null;
    return JSON.parse(s);
  } catch { return null; }
}

/** Stamp meta with an explicit outcome so 'ran' and 'accomplished' stop looking alike. */
function withOutcome(meta) {
  const m = { ...(meta || {}) };
  const n = extractItemCount(m);
  if (n === null) {
    m.outcome = 'unknown';
  } else {
    m.outcome_items = n;
    m.outcome = n > 0 ? 'produced' : 'zero';
  }
  return m;
}

async function recordCronRun(cronName, status, meta = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[telemetry] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing, skipping telemetry');
    return;
  }

  const stamped = status === 'ok' ? withOutcome(meta) : { ...(meta || {}), outcome: 'error' };

  const payload = {
    cron_name: cronName,
    last_run: new Date().toISOString(),
    last_status: status,
    last_meta: stamped,
  };

  try {
    // PostgREST upsert requires on_conflict when the conflict target isn't the
    // table's primary key. cron_runs.id is PK; cron_name has a UNIQUE constraint.
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/cron_runs?on_conflict=cron_name`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      console.warn(
        `[telemetry] recordCronRun failed: ${res.status} ${res.statusText}`,
        { cronName, status }
      );
    }
  } catch (e) {
    console.warn(`[telemetry] recordCronRun crashed: ${e.message}`, { cronName, status });
  }
}

/**
 * withTelemetry(name, handler) — wraps a Vercel function handler so every fire is
 * recorded to cron_runs. Status logic:
 *   - handler throws  → status='error', meta.error = message
 *   - response.statusCode >= 400 → status='error', meta.status=N
 *   - otherwise → status='ok', meta.status=N, meta.duration_ms=N
 *
 * IMPORTANT: We must intercept the response BEFORE Vercel flushes it, otherwise
 * the lambda gets killed mid-await and telemetry never writes. We monkey-patch
 * res.send / res.json / res.end so the telemetry write happens inline as part
 * of the response chain.
 */
function withTelemetry(cronName, handler) {
  return async function wrapped(req, res) {
    const startedAt = Date.now();
    let recorded = false;

    async function record(status, extraMeta = {}) {
      if (recorded) return;
      recorded = true;
      try {
        const duration_ms = Date.now() - startedAt;
        const code = (res && typeof res.statusCode === 'number') ? res.statusCode : 0;
        const meta = { duration_ms, http_status: code, ...extraMeta };
        await recordCronRun(cronName, status, meta);
      } catch (e) {
        console.warn(`[telemetry] wrapper record crashed: ${e && e.message}`, { cronName });
      }
    }

    // Patch res.end so we write telemetry BEFORE flushing the response.
    // res.json and res.send all funnel through res.end eventually but Vercel
    // implements them differently; safer to wrap each.
    const origJson = res.json && res.json.bind(res);
    const origSend = res.send && res.send.bind(res);
    const origEnd  = res.end  && res.end.bind(res);

    async function finalizeAndPassThrough(passThrough, body) {
      const code = (res && typeof res.statusCode === 'number') ? res.statusCode : 0;
      // 401 = the auth gate rejected this specific caller, not "the cron ran
      // and failed." A real cron trigger (Vercel's own x-vercel-cron header,
      // or a correct manual Bearer CRON_SECRET) never gets a 401 from its own
      // endpoint — only an unauthenticated/misauthenticated caller does
      // (health-check bots, scanners, a stray curl without the secret, etc).
      // Recording those into cron_runs overwrote the real last-known-good
      // status for low-frequency crons (e.g. once-daily) with a false
      // "persistently failing" signal that could sit there for up to 24h
      // until the next legitimate run. Root cause of the 2026-08-14
      // cron-followup false alarm (http_401 was a stray unauthenticated hit,
      // not a scheduler failure — confirmed the endpoint returns 200 with the
      // correct CRON_SECRET). Skip telemetry entirely for 401s; still record
      // everything else (2xx, and genuine errors from an authenticated run).
      if (code === 401) {
        return passThrough();
      }
      const status = code >= 400 ? 'error' : 'ok';
      const extra = code >= 400 ? { error: `http_${code}` } : {};
      // AUTOMATIC ITEM COUNTING (Atlas, 2026-09-25). Nearly every cron here
      // already returns something like {ok:true, published:0, errors:0} — the
      // count exists, it just never reached cron_runs. Sniffing the response
      // body retrofits honest outcome reporting onto all ~140 crons without
      // editing 140 files. A cron that returns no count at all lands at
      // outcome='unknown', which outcome-causes.js reports as blind.
      if (code < 400) {
        const n = extractItemCount(parseBody(body));
        if (n !== null) extra.items = n;
      }
      await record(status, extra);
      return passThrough();
    }

    if (origJson) {
      res.json = function (body) {
        // Note: schedule telemetry then call origJson. We can't await here without
        // changing the signature, so we kick off telemetry and trust Vercel to wait.
        // To guarantee write completion we make this async by returning a Promise.
        return finalizeAndPassThrough(() => origJson(body), body);
      };
    }
    if (origSend) {
      res.send = function (body) {
        return finalizeAndPassThrough(() => origSend(body), body);
      };
    }
    if (origEnd) {
      res.end = function (...args) {
        return finalizeAndPassThrough(() => origEnd(...args), args[0]);
      };
    }

    try {
      await handler(req, res);
      // If the handler returned without sending a response, force-record.
      if (!recorded) {
        await record('ok', {});
      }
    } catch (err) {
      const meta = { error: (err && err.message) ? err.message.slice(0, 500) : 'crash' };
      await record('error', meta);
      if (res && !res.headersSent) {
        try { res.status(500).json({ ok: false, error: meta.error }); } catch { /* ignore */ }
      }
    }
  };
}

module.exports = { recordCronRun, withTelemetry, withOutcome, extractItemCount, ITEM_KEYS };

/*
  SQL migration to create cron_runs table (run once in Supabase console):

  CREATE TABLE IF NOT EXISTS cron_runs (
    cron_name TEXT PRIMARY KEY,
    last_run TIMESTAMPTZ NOT NULL,
    last_status TEXT NOT NULL,
    last_meta JSONB,
    updated_at TIMESTAMPTZ DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_cron_runs_last_status ON cron_runs(last_status);
*/
