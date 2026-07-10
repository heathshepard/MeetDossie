"use strict";
// Records a diagnostic failure into the customer_experience_incidents Supabase table.
// If SUPABASE_SERVICE_ROLE_KEY isn't available, falls back to appending JSONL locally.

const fs = require("fs");
const path = require("path");

// Schema for public.customer_experience_incidents (actual):
//   id, created_at, cron_run_id, incident_type, severity, path,
//   detail, screenshot_path, resolved, resolved_at, resolved_notes,
//   repeat_count, last_seen_at
async function logIncident(cfg, incident) {
  // Local JSONL always includes richer context for offline analysis
  const richPayload = {
    source: "ridge_diagnostic_suite",
    severity: incident.severity || "medium",
    category: incident.category || "unknown",
    test_point: incident.test_point,
    detail: incident.detail,
    screenshot_path: incident.screenshot_path,
    run_id: `run-${cfg.runId}`,
    base_url: cfg.base,
    property_address: cfg.property && cfg.property.address,
    detected_at: new Date().toISOString(),
  };

  const localLog = path.join(cfg.outDir, "incidents.jsonl");
  fs.mkdirSync(path.dirname(localLog), { recursive: true });
  fs.appendFileSync(localLog, JSON.stringify(richPayload) + "\n", "utf8");

  if (!cfg.supabaseServiceKey) {
    return { ok: true, local_only: true, path: localLog };
  }

  // Payload matches the actual customer_experience_incidents schema.
  // cron_run_id is uuid; omit unless we have a real one (Ridge diagnostic runs aren't cron_runs entries).
  const supabasePayload = {
    incident_type: `${incident.category || "unknown"}.${incident.test_point || "unspecified"}`,
    severity: incident.severity || "medium",
    path: `diagnostic-suite/run-${cfg.runId}/${incident.test_point || "unspecified"}`,
    detail: `[${cfg.base}] ${incident.detail || ""}${incident.property_address ? ` — property=${incident.property_address}` : ""}`,
    screenshot_path: incident.screenshot_path || null,
    resolved: false,
    repeat_count: 1,
    last_seen_at: new Date().toISOString(),
  };

  try {
    const res = await fetch(`${cfg.supabaseUrl}/rest/v1/customer_experience_incidents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseServiceKey,
        Authorization: `Bearer ${cfg.supabaseServiceKey}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify(supabasePayload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[incident-log] supabase insert failed", res.status, text.slice(0, 200));
      return { ok: false, status: res.status, path: localLog };
    }
    const row = await res.json().catch(() => null);
    return { ok: true, row, path: localLog };
  } catch (err) {
    console.warn("[incident-log] supabase error", err.message);
    return { ok: false, error: err.message, path: localLog };
  }
}

module.exports = { logIncident };
