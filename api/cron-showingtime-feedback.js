// Vercel Serverless Function: /api/cron-showingtime-feedback
// =============================================================================
// Capability #3 of the paid "Email Integration" add-on (see
// api/cron-email-to-dossier.js for #1 and api/cron-esign-events.js for #2).
// Net new 2026-08-22 — no prior version of this existed.
//
// Watches each entitled + connected customer's inbox for ShowingTime's
// feedback-notification emails ("Feedback received for <address>"), parses
// out the showing agent, rating, and comments, and:
//   1. Stores a row in public.showingtime_feedback (durable, feeds the
//      separately spec'd weekly listing-performance digest).
//   2. If the address matches an active listing on file, appends a note to
//      that transaction's notes_log too — same pattern as the email-to-dossier
//      and esign watchers, so feedback shows up in the dossier's timeline.
//
// Same architectural shape as cron-esign-events.js: gmail search across a
// known sender allowlist, parse, dedupe on (user_id, source_message_id) via a
// unique index, entitlement + connected-mailbox gate shared via
// api/_lib/email-integration-customers.js and api/_lib/gmail-oauth.js.
//
// ShowingTime email formats are not publicly documented and will drift — this
// parser is intentionally conservative (regex against known phrasing) and
// SKIPS (not guesses) anything it can't parse cleanly. A skipped email is
// still recorded with feedback_text=null / filed=false so nothing is silently
// dropped from the audit trail, but the notes_log entry is only written when
// there's real content to show the agent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — every 30 min (feedback isn't time-critical the way
// e-sign completions or urgent counterparty emails are)
//
// Owner: Carter, 2026-08-22 (SV-ENG-EMAIL-INTEGRATION-ADDON)
// =============================================================================

'use strict';

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { listEmailIntegrationCustomers } = require('./_lib/email-integration-customers');
const { loadGoogleTokensForUser, makeGmailClient, headerMap, bodyOfMessage } = require('./_lib/gmail-oauth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// ShowingTime sends from showingtime.com (and its ShowingTime+ / Showing
// Suite rebrand touches showingsuite.com). Broad allowlist — a false-positive
// match here only costs a wasted parse attempt, never a false record.
const PROVIDER_QUERY = '(from:showingtime.com OR from:showingsuite.com)';
const LOOKBACK = 'newer_than:3d';
const MAX_MESSAGES = 40;

// --------------------------------------------------------------------------
// Supabase
// --------------------------------------------------------------------------

async function sb(pathAndQuery, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function alreadyProcessed(userId, messageId) {
  const { ok, data } = await sb(
    `showingtime_feedback?select=id&user_id=eq.${encodeURIComponent(userId)}&source_message_id=eq.${encodeURIComponent(messageId)}&limit=1`,
  );
  return ok && Array.isArray(data) && data.length > 0;
}

async function loadActiveListings(userId) {
  // "Listings" here means transactions where this user is on the seller/list
  // side — ShowingTime feedback is inherently about a property the agent has
  // listed, not one they're representing a buyer on.
  const { ok, data } = await sb(
    `transactions?user_id=eq.${encodeURIComponent(userId)}&status=neq.closed` +
    `&select=id,property_address,stage,notes_log`,
  );
  if (!ok || !Array.isArray(data)) return [];
  return data.map((r) => ({
    id: r.id,
    address: r.property_address,
    stage: r.stage,
    notesLog: Array.isArray(r.notes_log) ? r.notes_log : [],
  }));
}

function normalizeAddress(addr) {
  return String(addr || '').toLowerCase().replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}

// Best-effort address match: the listing address appears somewhere in the
// normalized text (subject or body). No fuzzy/AI matching in v1, matching the
// same conservatism as cron-email-to-dossier.js.
function matchListing(text, listings) {
  const norm = normalizeAddress(text);
  if (!norm) return null;
  for (const listing of listings) {
    const listingNorm = normalizeAddress(listing.address);
    if (listingNorm && norm.includes(listingNorm)) return listing;
    // Also try just the street number + first street word (handles ShowingTime
    // truncating "123 Main St" to "123 Main").
    const parts = listingNorm.split(' ');
    if (parts.length >= 2) {
      const shortForm = parts.slice(0, 2).join(' ');
      if (shortForm.length > 4 && norm.includes(shortForm)) return listing;
    }
  }
  return null;
}

async function appendNote(listing, entry) {
  if (!listing) return;
  await sb(`transactions?id=eq.${encodeURIComponent(listing.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ notes_log: [entry, ...(listing.notesLog || [])] }),
  }).catch(() => {});
}

// --------------------------------------------------------------------------
// Parsing — conservative regex against known ShowingTime phrasing. Returns
// null (not a feedback email, or unparseable) rather than guessing.
// --------------------------------------------------------------------------

// Patterns below were reverse-engineered against REAL ShowingTime notification
// emails pulled live from heath.shepard@kw.com on 2026-08-22 (via
// scripts/kw-mail.py), not guessed. Real subject/body seen:
//   Subject: "FEEDBACK RECEIVED | 23 Nopalito, San Antonio, TX 78261"
//   Body (after HTML-strip): "...Feedback Received for 23 Nopalito San
//     Antonio, TX 78261 $1,195,000 | PRICE CHANGE | ID# 1916402
//     1. Is your client interested in this listing? Maybe
//     2. Please rate your overall experience at this showing. Excellent
//     3. Your (and your client's) opinion of the price: Just right
//     4. Please rate this listing (5=Best; 1=Worst): 5(Best)
//     5. COMMENTS / RECOMMENDATIONS: <free text> Publish to Seller ...
//     ...Buyer's Agent Details Craig Browning Phyllis Browning Company
//     (210) 316-7842 ... teambrowning@phyllisbrowning.com
//     ...Showing Thu, August 20, 2026 3:15 PM - 4:15 PM..."
// "FEEDBACK REQUESTED" subjects are a distinct, earlier email (asking the
// showing agent to submit feedback) and legitimately carry no rating/comments
// yet — correctly parsed as address+agent only, filed=false until (if ever)
// a matching RECEIVED email arrives.
function parseShowingTimeFeedback({ subject, body }) {
  const text = `${subject}\n${body}`;
  const isFeedback = /feedback/i.test(subject) && /showing/i.test(text);
  if (!isFeedback) return null;

  // Subject is consistently "FEEDBACK REQUESTED|RECEIVED | <address>" — the
  // part after the pipe IS the address, cleanly, no guessing needed.
  let address = null;
  const pipeIdx = subject.indexOf('|');
  if (pipeIdx >= 0) {
    address = subject.slice(pipeIdx + 1).trim().replace(/[.!]+$/, '');
  } else {
    const addrMatch = subject.match(/feedback\s*(?:received|requested)?\s*(?:for|on|:)?\s*(?:your listing at\s*)?(.+)$/i);
    if (addrMatch && addrMatch[1]) address = addrMatch[1].trim().replace(/[.!]+$/, '');
  }

  // Buyer's agent name + brokerage — real format has "Buyer's Agent Details"
  // as its own label, then a LARGE whitespace gap (Gmail preserves the
  // original HTML table's indentation as literal newlines/spaces), THEN
  // "Craig Browning   Phyllis Browning Company   tel:2103167842 (210)...".
  // Capture everything up to the first "tel:" or "mailto:" marker (reliable
  // — always precedes contact info) rather than trying to bound on a phone
  // number directly, and collapse the captured whitespace afterward.
  const agentMatch = body.match(/buyer'?s?\s*agent\s*details\s*([\s\S]{2,400}?)(?:tel:|mailto:)/i);
  const agentName = agentMatch ? agentMatch[1].replace(/\s+/g, ' ').trim() : null;

  const emailMatch = body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const agentEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

  // Rating: "2. Please rate your overall experience at this showing." then a
  // whitespace-heavy gap (\s matches the \r\n padding fine), then the
  // single-word-or-two answer on its own line, e.g. "Excellent".
  const ratingMatch = body.match(/overall experience at this showing\.?\s*([A-Za-z]+(?:\s[A-Za-z]+)?)/i);
  const rating = ratingMatch ? ratingMatch[1].trim() : null;

  // Comments: "5. COMMENTS / RECOMMENDATIONS:" then the free-text block, then
  // eventually "Publish to Seller" / "Manage Feedback" / "Appointment
  // Details" (each repeated twice in the real template, plus more whitespace
  // padding than a normal paragraph — 4000 chars of slack, not 800).
  const commentsMatch = body.match(/comments\s*\/\s*recommendations\s*:\s*([\s\S]{1,4000}?)(?:publish to seller|manage feedback|appointment details|$)/i);
  // The "Publish to Seller" / "Manage Feedback" links render (via the shared
  // href-preserving strip in bodyOfMessage) as bare URLs immediately before
  // their visible label, so the lazy match above can land just after the
  // comment text but still swallow that trailing tracking link. Strip it.
  const feedbackText = commentsMatch
    ? commentsMatch[1].replace(/\s+/g, ' ').replace(/\s*https?:\/\/\S+\s*$/i, '').trim()
    : null;

  // Showing date: "Showing Thu, August 20, 2026 3:15 PM - 4:15 PM"
  const dateMatch = body.match(/showing\s+\w+,\s*([A-Za-z]+ \d{1,2},\s*\d{4})\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
  let showingDateIso = null;
  if (dateMatch) {
    const d = new Date(`${dateMatch[1]} ${dateMatch[2]}`);
    if (!isNaN(d.getTime())) showingDateIso = d.toISOString();
  }

  return {
    address,
    agentName,
    agentEmail,
    rating,
    feedbackText,
    showingDateIso,
  };
}

// --------------------------------------------------------------------------
// Per-customer run
// --------------------------------------------------------------------------

async function runForCustomer({ userId, googleEmail }, { dryRun, debugBody } = {}) {
  const stats = { candidates: 0, feedback_emails: 0, filed: 0, matched_listing: 0, unparseable: 0 };
  const details = [];

  let gmail;
  try {
    const tokens = await loadGoogleTokensForUser(userId);
    if (!tokens) throw new Error('no_google_integration_row');
    gmail = makeGmailClient({ userId, tokens });
  } catch (err) {
    return { ok: false, status: 'no_google_integration', userId, googleEmail, error: String(err.message) };
  }

  let list;
  try {
    list = await gmail('messages', { q: `${PROVIDER_QUERY} ${LOOKBACK}`, maxResults: String(MAX_MESSAGES) });
  } catch (err) {
    return { ok: false, status: 'gmail_list_failed', userId, googleEmail, error: String(err.message) };
  }

  const ids = (list.messages || []).map((m) => m.id);
  stats.candidates = ids.length;

  const listings = await loadActiveListings(userId);

  for (const messageId of ids) {
    try {
      if (!dryRun && (await alreadyProcessed(userId, messageId))) continue;

      const msg = await gmail(`messages/${messageId}`, { format: 'full' });
      const hdr = headerMap(msg?.payload?.headers);
      const subject = hdr['subject'] || '';
      const body = bodyOfMessage(msg);

      const parsed = parseShowingTimeFeedback({ subject, body });
      if (!parsed) continue; // not a feedback email
      stats.feedback_emails++;

      const listing = parsed.address ? matchListing(parsed.address, listings) : matchListing(subject, listings);
      if (listing) stats.matched_listing++;
      if (!parsed.feedbackText && !parsed.rating) stats.unparseable++;

      if (dryRun) {
        details.push({
          messageId, subject, parsed,
          matchedListing: listing ? listing.address : null,
          commentsExcerpt: debugBody ? (() => {
            const s = String(body);
            const idx = s.search(/comments/i);
            return idx >= 0 ? s.slice(Math.max(0, idx - 100), idx + 1200) : '(no "comments" match)';
          })() : undefined,
          agentExcerpt: debugBody ? (() => {
            const s = String(body);
            const idx = s.search(/agent details/i);
            return idx >= 0 ? s.slice(Math.max(0, idx - 100), idx + 800) : '(no "agent details" match)';
          })() : undefined,
          ratingExcerpt: debugBody ? (() => {
            const s = String(body);
            const idx = s.search(/overall experience/i);
            return idx >= 0 ? s.slice(Math.max(0, idx - 50), idx + 400) : '(no "overall experience" match)';
          })() : undefined,
        });
        continue;
      }

      const insert = await sb('showingtime_feedback', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          transaction_id: listing ? listing.id : null,
          property_address: parsed.address,
          showing_agent_name: parsed.agentName,
          showing_agent_email: parsed.agentEmail,
          showing_date: parsed.showingDateIso,
          rating: parsed.rating,
          feedback_text: parsed.feedbackText,
          source_message_id: messageId,
          source_thread_id: msg.threadId || null,
          subject: subject.slice(0, 500),
          filed: !!listing && !!(parsed.feedbackText || parsed.rating),
        }),
      });
      if (!insert.ok && insert.status !== 409) {
        details.push({ messageId, error: 'insert_failed' });
        continue;
      }

      if (listing && (parsed.feedbackText || parsed.rating)) {
        await appendNote(listing, {
          id: `showingtime-${messageId}`,
          source: 'showingtime',
          stageId: listing.stage,
          text: [
            parsed.rating ? `Showing feedback: ${parsed.rating}.` : 'Showing feedback received.',
            parsed.feedbackText || '',
            parsed.agentName ? `— ${parsed.agentName}` : '',
          ].filter(Boolean).join(' '),
          createdAt: parsed.showingDateIso || new Date().toISOString(),
          read: false,
        });
        stats.filed++;
      }

      details.push({ messageId, matchedListing: listing ? listing.address : null, filed: !!listing });
    } catch (err) {
      console.warn('[cron-showingtime-feedback] message failed', userId, messageId, err && err.message);
    }
  }

  return { ok: true, status: dryRun ? 'dry_run' : 'complete', userId, googleEmail, stats, details };
}

// --------------------------------------------------------------------------
// Outer handler — entitlement gate + per-customer loop
// --------------------------------------------------------------------------

function authorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || '';
  return !!(CRON_SECRET && auth === `Bearer ${CRON_SECRET}`);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(200).json({ ok: true, status: 'skipped', reason: 'google_oauth_env_missing' });
  }

  let customers = [];
  try {
    customers = await listEmailIntegrationCustomers();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'entitlement_lookup_failed', detail: String(err.message || err) });
  }

  if (!customers.length) {
    return res.status(200).json({ ok: true, status: 'complete', customers: 0, results: [] });
  }

  const dryRun = !!(req.query && (req.query.dry === '1' || req.query.dry === 'true'));
  const targetUserId = req.query && req.query.user_id;
  const scoped = dryRun
    ? (targetUserId ? customers.filter((c) => c.userId === targetUserId) : customers.slice(0, 1))
    : customers;

  const results = [];
  for (const customer of scoped) {
    try {
      const debugBody = dryRun && !!(req.query && req.query.debug_body === '1');
      results.push(await runForCustomer(customer, { dryRun, debugBody }));
    } catch (err) {
      console.error('[cron-showingtime-feedback] customer run failed', customer.userId, err && err.message);
      results.push({ ok: false, status: 'unhandled_error', userId: customer.userId, error: String(err && err.message || err) });
    }
  }

  return res.status(200).json({ ok: true, status: dryRun ? 'dry_run' : 'complete', customers: customers.length, results });
}

module.exports = withTelemetry('cron-showingtime-feedback', handler);
module.exports.config = { maxDuration: 120 };
