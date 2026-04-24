// api/leads.js
// Handles GET (list leads) and POST (create lead) for the Dossie founding member signup form.
// Uses Supabase service role key for server-side writes, bypassing RLS.

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
    if (req.method === "GET") {
      // Return all leads, newest first
      const leads = await supabaseRequest("leads?select=*&order=created_at.desc");
      return res.status(200).json(leads);
    }

    if (req.method === "POST") {
      const { id, name, email, role, volume, notes, createdAt } = req.body || {};

      if (!email || !name) {
        return res.status(400).json({
          ok: false,
          error: "Name and email are required.",
        });
      }

      const leadRow = {
        id: id || `lead-${Date.now()}`,
        name: String(name).trim(),
        email: String(email).trim().toLowerCase(),
        role: role ? String(role).trim() : null,
        volume: volume ? String(volume).trim() : null,
        notes: notes ? String(notes).trim() : null,
        created_at: createdAt || new Date().toISOString(),
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
    return res.status(500).json({
      ok: false,
      error: err.message || "Server error",
    });
  }
}
