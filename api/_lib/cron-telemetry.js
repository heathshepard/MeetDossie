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
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/cron_runs`,
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
 * Telemetry runs AFTER the response is sent so it never blocks the cron.
 */
function withTelemetry(cronName, handler) {
  return async function wrapped(req, res) {
    const startedAt = Date.now();
    let thrownError = null;

    // Patch res to remember status code (Vercel may have already written it).
    // We rely on res.statusCode being set by handler before they call res.send/json/end.
    try {
      await handler(req, res);
    } catch (err) {
      thrownError = err;
      // Mirror the original handler's responsibility: if it didn't respond, we do.
      if (res && !res.headersSent) {
        try {
          res.status(500).json({ ok: false, error: err && err.message ? err.message : 'crash' });
        } catch { /* ignore */ }
      }
    }

    // Fire-and-forget telemetry (non-blocking; we do await to ensure write before
    // Vercel kills the lambda, but we swallow any error).
    try {
      const duration_ms = Date.now() - startedAt;
      const code = (res && typeof res.statusCode === 'number') ? res.statusCode : 0;
      let status = 'ok';
      const meta = { duration_ms, http_status: code };
      if (thrownError) {
        status = 'error';
        meta.error = (thrownError && thrownError.message) ? thrownError.message.slice(0, 500) : 'crash';
      } else if (code >= 400) {
        status = 'error';
        meta.error = `http_${code}`;
      }
      await recordCronRun(cronName, status, meta);
    } catch (e) {
      console.warn(`[telemetry] wrapper telemetry crashed: ${e && e.message}`, { cronName });
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
