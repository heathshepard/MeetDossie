// api/leads.js
// Handles GET (list leads) and POST (create lead) for the Dossie founding member signup form.
// Uses Supabase service role key for server-side writes, bypassing RLS.

import {
  validateEmail,
  sanitizeString,
  ValidationError,
} from "./_middleware/validate.js";
import {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} from "./_middleware/rateLimit.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseRequest(path, options = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: options.method === "POST" ? "return=representation" : "",
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase error (${response.status}): ${errorText}`);
  }
  return response.json();
}

export default async function handler(req, res) {
  // Guard against missing environment variables
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Supabase environment variables are not configured.",
    });
  }

  try {
    // Rate limit by IP. Applies to all methods so attackers can't bypass via GET.
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, "leads", 60, 60 * 60 * 1000);

    if (req.method === "GET") {
      // Return all leads, newest first
      const leads = await supabaseRequest("leads?select=*&order=created_at.desc");
      return res.status(200).json(leads);
    }

    if (req.method === "POST") {
      const { id, name, email, role, volume, notes, createdAt } = req.body || {};

      // Required-field check before sanitization so we report the right error.
      if (!email || !name) {
        return res.status(400).json({
          ok: false,
          error: "Name and email are required.",
        });
      }

      const cleanName = sanitizeString(name, { maxLength: 200 });
      const cleanEmailRaw = sanitizeString(email, { maxLength: 320 });
      const cleanEmail = cleanEmailRaw ? cleanEmailRaw.toLowerCase() : null;

      if (!cleanName) {
        return res.status(400).json({ ok: false, error: "Name is required." });
      }
      if (!cleanEmail || !validateEmail(cleanEmail)) {
        return res.status(400).json({ ok: false, error: "A valid email is required." });
      }

      const cleanId = id ? sanitizeString(id, { maxLength: 100 }) : null;
      const cleanRole = sanitizeString(role, { maxLength: 100 });
      const cleanVolume = sanitizeString(volume, { maxLength: 100 });
      const cleanNotes = sanitizeString(notes, { maxLength: 5000 });

      // Only accept a client-supplied createdAt if it parses to a real date;
      // otherwise stamp server-side.
      let createdAtIso = new Date().toISOString();
      if (createdAt) {
        const d = new Date(createdAt);
        if (!Number.isNaN(d.getTime())) createdAtIso = d.toISOString();
      }

      const leadRow = {
        id: cleanId || `lead-${Date.now()}`,
        name: cleanName,
        email: cleanEmail,
        role: cleanRole,
        volume: cleanVolume,
        notes: cleanNotes,
        created_at: createdAtIso,
      };

      const inserted = await supabaseRequest("leads", {
        method: "POST",
        body: JSON.stringify(leadRow),
      });

      return res.status(200).json({
        ok: true,
        lead: Array.isArray(inserted) ? inserted[0] : inserted,
      });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    console.error("Leads endpoint error:", err);

    if (err instanceof ValidationError) {
      return res.status(err.status || 400).json({ ok: false, error: err.message });
    }
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) {
        res.setHeader("Retry-After", String(err.retryAfterSeconds));
      }
      return res.status(429).json({
        ok: false,
        error: "Rate limit exceeded. Please try again later.",
      });
    }

    // Sanitized public message — never leak Supabase URLs / SQL / keys.
    return res.status(500).json({
      ok: false,
      error: "Server error.",
    });
  }
}
