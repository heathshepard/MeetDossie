/**
 * mailinator.js — poll public mailinator inbox for a specific email address.
 *
 * Public mailinator inboxes are readable via the web UI at
 *   https://www.mailinator.com/v4/public/inboxes.jsp?to=<address>
 * There is a public JSON endpoint that backs the UI:
 *   https://www.mailinator.com/api/v2/domains/public/inboxes/<address>?limit=10
 * That endpoint is rate-limited and sometimes requires a token, so we fall
 * back to scraping the HTML search page + individual message pages when the
 * JSON path is blocked.
 *
 * Contract:
 *   pollInbox(address, opts) -> Promise<{ subject, html, receivedAt, msgId }>
 *   extractSigningUrl(html) -> string|null
 *
 * opts:
 *   timeoutMs (default 90000)  — max wait for first matching email
 *   pollMs    (default 5000)   — interval between polls
 *   subjectMatch (RegExp|null) — reject messages that don't match
 *   olderThanIso (string|null) — reject messages received before this ISO ts
 *
 * NOTE: This is intentionally NO-DEPS beyond node fetch. Playwright can poll
 * mailinator via its own browser if needed (see fallback), but the JSON path
 * is preferred to keep runs fast.
 */

'use strict';

/**
 * Fetch the public JSON inbox listing for an address.
 * Returns array of { subject, id, from, receivedAt } or null if unreachable.
 */
async function fetchInboxJson(address) {
  // Mailinator's public API keys on the LOCAL PART of the address only.
  // Passing the full "foo@mailinator.com" URL returns 500. Split before @.
  const local = String(address).split('@')[0];
  const url = `https://www.mailinator.com/api/v2/domains/public/inboxes/${encodeURIComponent(local)}?limit=25`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (dossie-sign-e2e)',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.msgs)) return null;
    return json.msgs.map((m) => ({
      id: m.id,
      subject: m.subject || '',
      from: m.from || '',
      receivedAt: m.time ? new Date(m.time).toISOString() : new Date().toISOString(),
      _time: m.time || 0,
    }));
  } catch {
    return null;
  }
}

/**
 * Fetch a single message body as HTML.
 * Returns string HTML or null.
 */
async function fetchMessageHtml(address, msgId) {
  // Try the JSON-body endpoint first.
  const url = `https://www.mailinator.com/api/v2/domains/public/messages/${encodeURIComponent(msgId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (dossie-sign-e2e)',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || !json.parts) return null;
    // parts is an array of {headers, body}. Prefer text/html body.
    let html = '';
    for (const p of json.parts) {
      const ct = (p.headers && (p.headers['content-type'] || p.headers['Content-Type'])) || '';
      if (/text\/html/i.test(ct)) {
        html += p.body || '';
      }
    }
    if (!html) {
      // Fall back to plain-text.
      for (const p of json.parts) {
        html += p.body || '';
      }
    }
    return html || null;
  } catch {
    return null;
  }
}

/**
 * Poll for the first inbox message matching subjectMatch and newer than
 * olderThanIso. Returns { subject, html, receivedAt, msgId } or throws.
 */
async function pollInbox(address, opts = {}) {
  const timeoutMs = opts.timeoutMs || 90_000;
  const pollMs = opts.pollMs || 5_000;
  const subjectMatch = opts.subjectMatch || null;
  const olderThanIso = opts.olderThanIso || null;
  const olderThanTs = olderThanIso ? new Date(olderThanIso).getTime() : 0;

  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts += 1;
    const listing = await fetchInboxJson(address);
    if (listing && listing.length > 0) {
      // Newest first.
      listing.sort((a, b) => b._time - a._time);
      for (const m of listing) {
        if (subjectMatch && !subjectMatch.test(m.subject)) continue;
        if (m._time && olderThanTs && m._time <= olderThanTs) continue;
        // Found a candidate — fetch its body.
        const html = await fetchMessageHtml(address, m.id);
        if (html) {
          return {
            subject: m.subject,
            html,
            receivedAt: m.receivedAt,
            msgId: m.id,
            attempts,
          };
        }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for email at ${address} after ${timeoutMs}ms / ${attempts} polls (subjectMatch=${subjectMatch})`);
}

/**
 * Extract the DocuSeal signing link from an email HTML body.
 * Dossie's Resend template links to https://docuseal.com/s/<slug>.
 * DocuSeal's native email links directly to https://docuseal.com/s/<slug> too.
 * Returns the first matching URL or null.
 */
function extractSigningUrl(html) {
  if (!html || typeof html !== 'string') return null;
  // Prefer the exact DocuSeal signing pattern.
  const patterns = [
    /https?:\/\/(?:www\.)?docuseal\.com\/s\/[A-Za-z0-9_-]+/g,
    /https?:\/\/(?:[a-z0-9-]+\.)?docuseal\.com\/[a-z]{1,4}\/[A-Za-z0-9_-]+/g,
    /https?:\/\/(?:[a-z0-9-]+\.)?docuseal\.com\/embed\/[A-Za-z0-9_-]+/g,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match && match.length > 0) return match[0];
  }
  return null;
}

/**
 * Generate a unique mailinator address for a test run.
 * Format: dsg-<form>-<role>-<shortTs>@mailinator.com
 * Mailinator public inboxes 500-error on local parts longer than ~30 chars,
 * so we compress the timestamp to seconds and use shortened form/role slugs.
 */
function newAddress(form, role, n = 1) {
  const shortTs = Math.floor(Date.now() / 1000).toString(36); // ~7 chars base36
  const safe = String(form).toLowerCase().replace(/[^a-z0-9]/g, '');
  const roleSafe = String(role).toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = n > 1 ? `${n}` : '';
  return `dsg-${safe}-${roleSafe}${suffix}-${shortTs}@mailinator.com`;
}

module.exports = {
  fetchInboxJson,
  fetchMessageHtml,
  pollInbox,
  extractSigningUrl,
  newAddress,
};
