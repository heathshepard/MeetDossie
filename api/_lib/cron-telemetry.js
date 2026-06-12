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

async function recordCronRun(cronName, status, meta = {}) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[telemetry] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing, skipping telemetry');
    return;
  }

  const payload = {
    cron_name: cronName,
    last_run: new Date().toISOString(),
    last_status: status,
    last_meta: meta,
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

    async function finalizeAndPassThrough(passThrough) {
      const code = (res && typeof res.statusCode === 'number') ? res.statusCode : 0;
      const status = code >= 400 ? 'error' : 'ok';
      const extra = code >= 400 ? { error: `http_${code}` } : {};
      await record(status, extra);
      return passThrough();
    }

    if (origJson) {
      res.json = function (body) {
        // Note: schedule telemetry then call origJson. We can't await here without
        // changing the signature, so we kick off telemetry and trust Vercel to wait.
        // To guarantee write completion we make this async by returning a Promise.
        return finalizeAndPassThrough(() => origJson(body));
      };
    }
    if (origSend) {
      res.send = function (body) {
        return finalizeAndPassThrough(() => origSend(body));
      };
    }
    if (origEnd) {
      res.end = function (...args) {
        return finalizeAndPassThrough(() => origEnd(...args));
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

module.exports = { recordCronRun, withTelemetry };

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
