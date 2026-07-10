"use strict";
// Preload key env vars from .env.local so runs can query Supabase + sign in.
// Only sets vars if not already present in process.env.

const fs = require("fs");
const path = require("path");

function loadEnvLocal() {
  const p = path.resolve(__dirname, "..", "..", "..", ".env.local");
  if (!fs.existsSync(p)) return { ok: false, reason: `${p} missing` };
  const text = fs.readFileSync(p, "utf8");
  const wanted = new Set([
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_URL",
    "DEMO_PASSWORD",
    "APV_PASSWORD",
    "APV_EMAIL",
  ]);
  const set = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!wanted.has(key)) continue;
    if (process.env[key]) continue;
    process.env[key] = val;
    set[key] = true;
  }
  return { ok: true, set: Object.keys(set) };
}

module.exports = { loadEnvLocal };
