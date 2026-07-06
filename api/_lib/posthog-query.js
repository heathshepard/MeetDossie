/**
 * PostHog Query API client (server-side).
 *
 * Uses POSTHOG_PERSONAL_API_KEY (a `phx_...` personal API key with
 * `query:read` + `web_analytics:read` scopes) to run HogQL against the
 * `events` table. Project ID from POSTHOG_PROJECT_ID (defaults to 500233).
 *
 * Rate limit safety: the caller layer (webpage-analytics-*) memoizes
 * responses for 5 minutes. This helper is a thin fetch wrapper.
 */

const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.posthog.com';
const POSTHOG_PERSONAL_API_KEY = process.env.POSTHOG_PERSONAL_API_KEY || null;
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID || '500233';

async function runHogQL(query, { timeoutMs = 15000 } = {}) {
  if (!POSTHOG_PERSONAL_API_KEY) {
    return { ok: false, error: 'POSTHOG_PERSONAL_API_KEY not configured', results: [], columns: [] };
  }
  const url = `${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${POSTHOG_PERSONAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: { kind: 'HogQLQuery', query },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        error: `PostHog ${res.status}`,
        detail: errText.slice(0, 500),
        results: [],
        columns: [],
      };
    }
    const j = await res.json();
    return {
      ok: true,
      results: j.results || [],
      columns: j.columns || [],
      hasMore: !!j.hasMore,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: err && err.name === 'AbortError' ? 'PostHog query timeout' : String(err && err.message || err),
      results: [],
      columns: [],
    };
  }
}

module.exports = { runHogQL, POSTHOG_HOST, POSTHOG_PROJECT_ID };
