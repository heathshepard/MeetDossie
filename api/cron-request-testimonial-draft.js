// Vercel Serverless Function: /api/cron-request-testimonial-draft
//
// Post-closing testimonial automation (Heath, 2026-09-10, after 104 Wild
// Cherry / the Lintons closed): "This is something that Dossie should do
// automatically once a sale happens." See memory
// dossie-post-closing-testimonial-request.md.
//
// Scans transactions that just reached status='closed' and, once per
// dossier ever, drafts a testimonial/review-request email (agent's own
// voice, from the agent's own profile -- never hardcoded to Heath) into
// email_queue as a PENDING draft, plus an action_items row so it can't be
// skipped silently. Nothing is sent here -- the agent taps Send from inside
// the app (see /api/send-testimonial-request.js).
//
// Idempotent: transactions.testimonial_draft_created_at is stamped after a
// successful draft and gates every future run for that dossier, forever.
//
// Freshness window (2026-09-10, post-incident): the first-ever run scanned
// every closed transaction in history (no floor on closing_date) and
// drafted 47 "ask for a testimonial" action items in one shot, including
// deals that closed months earlier -- a stale, out-of-place to-do for the
// member. Query is now floored to TESTIMONIAL_WINDOW_DAYS (14) so only
// recently-closed deals are ever drafted, regardless of how far back
// testimonial_draft_created_at=is.null reaches. See
// scripts/regression/testimonial-draft-window.test.js.
//
// Multi-tenant: every read/write is scoped to the transaction's own user_id
// (transactions-table-is-multi-tenant.md) -- there is no cross-tenant query.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
//
// NOT YET registered in vercel.json: the repo's cron cap is 100/100
// (commit hook enforces this -- see docs/TECH-DEBT.md). Needs either an
// existing cron slot freed up or external scheduling (cron-job.org, per the
// hook's own remediation note) before this runs unattended. Until then,
// trigger manually:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-url>/api/cron-request-testimonial-draft

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { customerFirstName } = require('./_lib/personalization.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const BATCH_LIMIT = 50;
const TESTIMONIAL_WINDOW_DAYS = 14;

// Floor date (YYYY-MM-DD) for the closing_date filter -- never draft a
// testimonial ask for a deal that closed more than TESTIMONIAL_WINDOW_DAYS
// ago, no matter how far back the testimonial_draft_created_at=is.null
// backlog reaches.
function windowFloorDate(now = new Date()) {
  const floor = new Date(now.getTime() - TESTIMONIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return floor.toISOString().slice(0, 10);
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

const isValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// Collects every real email/name on the agent's OWN side of the deal --
// listing side -> seller(s), buyer side (default) -> buyer(s). Mirrors
// getSuggestedRecipient()/getSideEmails() in Dossie/dossie-app.jsx so the
// "who is the agent's client" rule stays identical between the app and this
// cron.
function resolveClientContacts(tx) {
  const isListingSide = tx.role === 'listing';
  const names = isListingSide
    ? [tx.seller_name, tx.seller2_name]
    : [tx.buyer_name, tx.buyer2_name];
  const emails = isListingSide
    ? [tx.seller_email, tx.seller2_email]
    : [tx.buyer_email, tx.buyer2_email];

  const cleanNames = names.map((n) => (typeof n === 'string' ? n.trim() : '')).filter(Boolean);
  const cleanEmails = [];
  const seen = new Set();
  emails.forEach((raw) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    const email = raw.trim();
    if (isValidEmail(email) && !seen.has(email.toLowerCase())) {
      seen.add(email.toLowerCase());
      cleanEmails.push(email);
    }
  });

  const firstName = cleanNames.length
    ? cleanNames[0].split(/\s+/)[0]
    : null;
  const displayName = cleanNames.length ? cleanNames.join(' & ') : (isListingSide ? 'your seller' : 'your buyer');

  return { isListingSide, names: cleanNames, emails: cleanEmails, firstName, displayName };
}

function buildAgentSignature(profile) {
  if (!profile) return '';
  const lines = [];
  const agentName = (profile.full_name || '').trim();
  if (agentName) lines.push(agentName);
  const contactBits = [];
  if (profile.brokerage) contactBits.push(profile.brokerage);
  if (profile.phone) contactBits.push(profile.phone);
  if (contactBits.length) lines.push(contactBits.join(' · '));
  if (profile.license_number) lines.push(`TX License #${profile.license_number}`);
  if (profile.email) lines.push(profile.email);
  if (!lines.length) return '';
  return `\n\n--\n${lines.join('\n')}`;
}

function agentDisplayName(profile) {
  const name = (profile && profile.full_name || '').trim();
  if (name) return name;
  return customerFirstName(profile);
}

// Builds the email + one-line SMS variant for the ONE closing-day ask.
// Heath, 2026-09-10 (round 2): "I don't think we can post testimonials
// ourselves to every place" -- this is Google ONLY, never Zillow/Facebook/
// realtor.com in the same message (collapses response rate; Zillow in
// particular won't even attribute a review from a pasted link -- see
// cron-request-zillow-review-prompt.js for that separate, later, agent-only
// ask). Warm, short, 3-5 sentences: congratulate, ask for the Google
// review, ask for a two-sentence quote for social/website, explicit
// permission line for name + street.
//
// Requires profile.google_review_url to exist -- callers must not invoke
// this without one (see hasGoogleLink gate below); there is no
// placeholder-link fallback because a broken link in a client email is
// worse than not sending one.
function buildTestimonialDraft({ tx, profile, contacts }) {
  const clientFirst = contacts.firstName || 'there';
  const property = tx.property_address || 'your recent closing';
  const agentFirst = customerFirstName(profile);
  const signature = buildAgentSignature(profile);

  const subject = `Congratulations on closing ${property}!`;

  const body = `Hi ${clientFirst},

Congratulations on closing ${property}! It was a pleasure working with you and I'm so glad it's done.

If you have a minute, a quick Google review here would mean a lot: ${profile.google_review_url}

And if you have a moment, I'd love a two-sentence quote I could reuse on social media and my website about your experience working with me.

Would it be okay if I used your name and the ${property.split(',')[0]} address if I share that quote? No worries either way -- just let me know.

Thank you again -- it really was a joy.

${agentFirst}${signature}`;

  const sms = `Hi ${clientFirst}! Congrats again on closing ${property} -- if you have a minute, I'd love a quick Google review: ${profile.google_review_url} Thank you! - ${agentFirst}`;

  return { subject, body, sms };
}

module.exports = withTelemetry('cron-request-testimonial-draft', async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
    }

    // closing_date=gte.<floor> keeps this to recently-closed deals only.
    // (gte against a null closing_date never matches in PostgREST, so a
    // missing closing_date is skipped rather than silently drafted.)
    const windowFloor = windowFloorDate();
    const txResp = await supabaseFetch(
      `/rest/v1/transactions?status=eq.closed&testimonial_draft_created_at=is.null` +
      `&closing_date=gte.${windowFloor}` +
      `&select=id,user_id,property_address,city_state_zip,role,closing_date,` +
      `buyer_name,buyer2_name,buyer_email,buyer2_email,` +
      `seller_name,seller2_name,seller_email,seller2_email` +
      `&order=updated_at.asc&limit=${BATCH_LIMIT}`,
    );
    if (!txResp.ok) {
      return res.status(500).json({ ok: false, error: `transactions fetch failed: ${txResp.status}` });
    }
    const transactions = txResp.data || [];

    const summary = { ok: true, window_floor: windowFloor, scanned: transactions.length, drafted: 0, skipped_no_contact: 0, skipped_no_google_link: 0, errors: [] };

    for (const tx of transactions) {
      // Multi-tenant: every write below is scoped to this tx's own user_id.
      const userId = tx.user_id;
      if (!userId) { summary.errors.push({ tx_id: tx.id, error: 'missing user_id' }); continue; }

      const profResp = await supabaseFetch(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,full_name,preferred_name,email,brokerage,phone,license_number,google_review_url&limit=1`,
      );
      const profile = profResp.ok && Array.isArray(profResp.data) && profResp.data[0] ? profResp.data[0] : null;

      const contacts = resolveClientContacts(tx);
      const hasClientEmail = contacts.emails.length > 0;
      const hasGoogleLink = Boolean(profile && profile.google_review_url);

      // Only ever draft the client-facing email when BOTH the client's
      // contact info and the agent's own Google review link are on file.
      // A drafted email that says "add your link in Settings" would be a
      // client-facing message revealing internal product plumbing -- Heath,
      // 2026-09-10: "the action item should prompt them to add it rather
      // than sending a broken link." So a missing link skips the email
      // entirely and the action item says so plainly instead.
      let emailQueueId = null;
      let draft = null;
      if (hasClientEmail && hasGoogleLink) {
        draft = buildTestimonialDraft({ tx, profile, contacts });
        const eqInsert = await supabaseFetch('/rest/v1/email_queue', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            user_id: userId,
            transaction_id: String(tx.id),
            to_email: contacts.emails.join(', '),
            to_name: contacts.displayName,
            from_name: agentDisplayName(profile),
            subject: draft.subject,
            body: draft.body,
            status: 'pending',
          }),
        });
        if (eqInsert.ok && Array.isArray(eqInsert.data) && eqInsert.data[0]) {
          emailQueueId = eqInsert.data[0].id;
        } else {
          summary.errors.push({ tx_id: tx.id, user_id: userId, error: `email_queue insert failed: ${eqInsert.status}` });
        }
      } else if (!hasClientEmail) {
        summary.skipped_no_contact++;
      } else {
        summary.skipped_no_google_link++;
      }

      let description;
      if (!hasClientEmail && !hasGoogleLink) {
        description = `Ask ${contacts.displayName} for a testimonial -- add your Google review link in Settings AND their email on this dossier first`;
      } else if (!hasClientEmail) {
        description = `Ask ${contacts.displayName} for a testimonial -- add their email on this dossier first, no contact on file`;
      } else if (!hasGoogleLink) {
        description = `Ask ${contacts.displayName} for a testimonial -- add your Google review link in Settings first, then Dossie can send this`;
      } else {
        description = `Ask ${contacts.displayName} for a testimonial`;
      }

      const aiInsert = await supabaseFetch('/rest/v1/action_items', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          transaction_id: String(tx.id),
          action_type: 'testimonial_request',
          description,
          assigned_to_name: contacts.displayName,
          // assigned_to_email deliberately left NULL: cron-followup.js
          // auto-sends generic action items with assigned_to_email set once
          // overdue. A testimonial ask must never auto-send -- see
          // send-testimonial-request.js for the only send path.
          due_date: null,
          email_subject: draft ? draft.subject : null,
          email_body: draft ? draft.body : null,
          sms_draft: draft ? draft.sms : null,
          email_queue_id: emailQueueId,
          status: 'pending',
        }),
      });

      if (!aiInsert.ok) {
        summary.errors.push({ tx_id: tx.id, user_id: userId, error: `action_items insert failed: ${aiInsert.status}` });
        continue; // don't stamp the idempotency marker if the action item failed to write
      }

      const stamp = await supabaseFetch(
        `/rest/v1/transactions?id=eq.${encodeURIComponent(tx.id)}&user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ testimonial_draft_created_at: new Date().toISOString() }),
        },
      );
      if (!stamp.ok) {
        summary.errors.push({ tx_id: tx.id, user_id: userId, error: `idempotency stamp failed: ${stamp.status}` });
        continue;
      }

      summary.drafted++;
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[cron-request-testimonial-draft] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
