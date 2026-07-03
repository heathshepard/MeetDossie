// Server-side PostHog capture helper. Fire-and-forget — never block a
// webhook or API response on PostHog being slow or misconfigured.
//
// Env: POSTHOG_KEY (project write key, phc_...) and optional POSTHOG_HOST.
// If POSTHOG_KEY is unset the helper becomes a silent no-op — this lets
// us ship the instrumentation before Heath completes account creation.
//
// PII rule: never put email/name/phone in event properties. Use the email
// (or Stripe customer id) as the distinct_id so PostHog can join the
// event to the identified person, but keep the properties themselves
// anonymous by default.

const POSTHOG_KEY = process.env.POSTHOG_KEY || null;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

async function captureServerEvent({ distinctId, event, properties = {} }) {
  if (!POSTHOG_KEY) return; // graceful no-op when analytics isn't configured
  if (!distinctId || !event) return;

  const body = {
    api_key: POSTHOG_KEY,
    event,
    distinct_id: String(distinctId),
    properties: {
      ...properties,
      $lib: 'server',
      source: 'meetdossie-api',
    },
    timestamp: new Date().toISOString(),
  };

  try {
    // 3s timeout guard — we never want a slow PostHog to slow our webhook.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[posthog] capture non-OK', res.status, text.slice(0, 200));
    }
  } catch (err) {
    // AbortError, network error, DNS — swallow and continue. Analytics is
    // never load-bearing.
    console.warn('[posthog] capture failed:', event, err && err.message);
  }
}

module.exports = { captureServerEvent };
