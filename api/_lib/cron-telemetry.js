/**
 * Cron telemetry — fail-soft recording of cron run status
 * Records into cron_runs table (upsert on cron_name primary key)
 * Swallows all errors and logs warnings — never breaks the actual cron
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

module.exports = { recordCronRun };

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
