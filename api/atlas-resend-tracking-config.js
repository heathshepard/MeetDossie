// Vercel Serverless Function: /api/atlas-resend-tracking-config
//
// One-time-use diagnostic + fix endpoint for Resend open/click tracking.
// Built 2026-08-24 (Atlas) after email_events showed 0 'opened'/'clicked'
// events across 1,697 rows since 2026-06-30 despite resend-webhook.js
// correctly handling those event types — pointing at tracking being OFF
// at the Resend domain/webhook-subscription level, not a code bug.
//
// Read-only by default. Pass ?fix=1 to actually apply changes:
//   - PATCH the sending domain: open_tracking=true, click_tracking=true
//   - PATCH the webhook: add email.opened + email.clicked to its events
//
// Never touches resend-webhook.js. Never returns RESEND_API_KEY or any
// other secret value — diagnostic booleans/arrays only.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_BASE = 'https://api.resend.com';
const SENDING_DOMAIN = 'meetdossie.com';
const WEBHOOK_URL_MATCH = '/api/resend-webhook';
const REQUIRED_EVENTS = ['email.opened', 'email.clicked'];

function rHeaders() {
  return {
    Authorization: `Bearer ${RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'RESEND_API_KEY not configured' });
  }

  const fix = req.query && (req.query.fix === '1' || req.query.fix === 'true');
  const result = { ok: true, fix_applied: fix };

  try {
    // ── Domain tracking ────────────────────────────────────────────────
    const domListResp = await fetch(`${RESEND_BASE}/domains`, { headers: rHeaders() });
    if (!domListResp.ok) {
      const t = await domListResp.text().catch(() => '');
      return res.status(502).json({ ok: false, error: 'resend_domains_list_failed', status: domListResp.status, detail: t.slice(0, 300) });
    }
    const domList = await domListResp.json();
    const domains = Array.isArray(domList.data) ? domList.data : (Array.isArray(domList) ? domList : []);
    const domainSummary = domains.find(d => d.name === SENDING_DOMAIN);
    if (!domainSummary) {
      result.domain = { error: `no domain named ${SENDING_DOMAIN} found in Resend account`, all_domain_names: domains.map(d => d.name) };
    } else {
      const domResp = await fetch(`${RESEND_BASE}/domains/${domainSummary.id}`, { headers: rHeaders() });
      const dom = await domResp.json();
      result.domain = {
        id: dom.id,
        name: dom.name,
        status: dom.status,
        open_tracking_before: dom.open_tracking,
        click_tracking_before: dom.click_tracking,
        tracking_subdomain: dom.tracking_subdomain || null,
      };

      if (fix && (!dom.open_tracking || !dom.click_tracking)) {
        const patchResp = await fetch(`${RESEND_BASE}/domains/${domainSummary.id}`, {
          method: 'PATCH',
          headers: rHeaders(),
          body: JSON.stringify({ open_tracking: true, click_tracking: true }),
        });
        const patchBody = await patchResp.json().catch(() => ({}));
        result.domain.patch_status = patchResp.status;
        result.domain.patch_ok = patchResp.ok;
        result.domain.patch_response = patchBody;

        // Re-fetch to confirm the toggle actually took.
        const verifyResp = await fetch(`${RESEND_BASE}/domains/${domainSummary.id}`, { headers: rHeaders() });
        const verifyDom = await verifyResp.json();
        result.domain.open_tracking_after = verifyDom.open_tracking;
        result.domain.click_tracking_after = verifyDom.click_tracking;
      }
    }

    // ── Webhook event subscription ────────────────────────────────────
    const whListResp = await fetch(`${RESEND_BASE}/webhooks`, { headers: rHeaders() });
    if (!whListResp.ok) {
      const t = await whListResp.text().catch(() => '');
      result.webhook = { error: 'resend_webhooks_list_failed', status: whListResp.status, detail: t.slice(0, 300) };
    } else {
      const whList = await whListResp.json();
      const webhooks = Array.isArray(whList.data) ? whList.data : (Array.isArray(whList) ? whList : []);
      const ourHook = webhooks.find(w => typeof w.endpoint === 'string' && w.endpoint.includes(WEBHOOK_URL_MATCH));

      if (!ourHook) {
        result.webhook = { error: `no webhook found with endpoint containing ${WEBHOOK_URL_MATCH}`, all_endpoints: webhooks.map(w => w.endpoint) };
      } else {
        const currentEvents = Array.isArray(ourHook.events) ? ourHook.events : [];
        const missing = REQUIRED_EVENTS.filter(e => !currentEvents.includes(e));
        result.webhook = {
          id: ourHook.id,
          endpoint: ourHook.endpoint,
          status: ourHook.status,
          events_before: currentEvents,
          missing_before_fix: missing,
        };

        if (fix && missing.length) {
          const newEvents = Array.from(new Set([...currentEvents, ...REQUIRED_EVENTS]));
          const patchResp = await fetch(`${RESEND_BASE}/webhooks/${ourHook.id}`, {
            method: 'PATCH',
            headers: rHeaders(),
            body: JSON.stringify({ events: newEvents }),
          });
          const patchBody = await patchResp.json().catch(() => ({}));
          result.webhook.patch_status = patchResp.status;
          result.webhook.patch_ok = patchResp.ok;
          result.webhook.patch_response = patchBody;

          const verifyResp = await fetch(`${RESEND_BASE}/webhooks`, { headers: rHeaders() });
          const verifyList = await verifyResp.json();
          const verifyHooks = Array.isArray(verifyList.data) ? verifyList.data : (Array.isArray(verifyList) ? verifyList : []);
          const verifyHook = verifyHooks.find(w => w.id === ourHook.id);
          result.webhook.events_after = verifyHook ? verifyHook.events : null;
        }
      }
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err && err.message) ? err.message.slice(0, 500) : 'crash' });
  }
}

module.exports = handler;
module.exports.default = handler;
